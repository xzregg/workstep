"""Bounded, in-memory system metrics; OS I/O stays on one sampling worker."""
from __future__ import annotations

import asyncio
import logging
import platform
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

import psutil

logger = logging.getLogger(__name__)
METRICS = ('cpu_percent', 'memory_rss', 'threads', 'descriptors')


def _sum_metrics(rows: list[dict]) -> dict:
    # An inaccessible member must not silently turn a partial sum into a total.
    return {key: None if any(row[key] is None for row in rows)
            else round(sum(row[key] for row in rows), 2) for key in METRICS}


class SystemCollector:
    """Stateful synchronous collector, called only on its dedicated worker."""

    def __init__(self, config_dir: Path):
        self.config_dir = config_dir
        self.previous_processes: dict[tuple[int, float], tuple[float, float]] = {}
        self.previous_network: tuple[float, int, int] | None = None
        self.primed = False

    def __call__(self) -> dict:
        monotonic = time.monotonic()
        now = time.time()
        os_name = platform.system()
        cores = psutil.cpu_count() or 1
        current_processes = {}
        partial = False

        def read(operation):
            nonlocal partial
            try:
                return operation()
            except (psutil.Error, OSError, NotImplementedError, AttributeError):
                partial = True
                return None

        def process_row(process):
            created = read(process.create_time)
            name = read(process.name)
            cpu_times = read(process.cpu_times)
            cpu = None
            if cpu_times is not None and created is not None:
                identity = (process.pid, created)
                total = cpu_times.user + cpu_times.system
                previous = self.previous_processes.get(identity)
                if previous and monotonic > previous[0] and total >= previous[1]:
                    cpu = round(min(100.0, (total - previous[1]) / (monotonic - previous[0]) / cores * 100), 2)
                current_processes[identity] = (monotonic, total)
            memory = read(process.memory_info)
            descriptors = read(process.num_handles) if os_name == 'Windows' else read(process.num_fds)
            return {
                'pid': process.pid, 'name': name,
                'cpu_percent': cpu,
                'memory_rss': memory.rss if memory else None,
                'threads': read(process.num_threads), 'descriptors': descriptors,
                'uptime_seconds': max(0, now - created) if created is not None else None,
            }

        parent = psutil.Process()
        daemon = process_row(parent)
        limit = None
        if os_name != 'Windows':
            # macOS lacks Process.rlimit(); resource covers the current process.
            import resource
            limits = read(lambda: resource.getrlimit(resource.RLIMIT_NOFILE))
            if limits is not None:
                soft, _ = limits
                limit = soft if soft != resource.RLIM_INFINITY else None
        daemon['descriptor_limit'] = limit
        descendants = read(lambda: parent.children(recursive=True))
        children = [process_row(child) for child in descendants or []]
        children.sort(key=lambda row: (row['cpu_percent'] is None, -(row['cpu_percent'] or 0), row['pid']))
        children_summary = _sum_metrics(children)
        children_summary['process_count'] = len(children) if descendants is not None else None
        total = _sum_metrics([daemon, *children])
        if descendants is None:
            children_summary.update({key: None for key in METRICS})
            total.update({key: None for key in METRICS})

        memory = read(psutil.virtual_memory)
        swap = read(psutil.swap_memory)
        # The configured directory may not exist yet during first startup.
        disk_path = self.config_dir
        while not disk_path.exists() and disk_path != disk_path.parent:
            disk_path = disk_path.parent
        disk = read(lambda: psutil.disk_usage(disk_path))
        network = read(psutil.net_io_counters)
        recv_rate = sent_rate = None
        if network is not None:
            if self.previous_network:
                previous_time, recv, sent = self.previous_network
                elapsed = monotonic - previous_time
                if elapsed > 0:
                    recv_rate = max(0, (network.bytes_recv - recv) / elapsed) if network.bytes_recv >= recv else None
                    sent_rate = max(0, (network.bytes_sent - sent) / elapsed) if network.bytes_sent >= sent else None
            self.previous_network = (monotonic, network.bytes_recv, network.bytes_sent)
        else:
            self.previous_network = None
        host_cpu = read(lambda: psutil.cpu_percent(interval=None))
        report = {
            'sampled_at': datetime.now(timezone.utc).isoformat(),
            'platform': os_name, 'descriptor_kind': 'handles' if os_name == 'Windows' else 'fds',
            'host': {
                'cpu_count': cores, 'cpu_percent': host_cpu if self.primed else None,
                'memory_total': memory.total if memory else None,
                'memory_used': memory.total - memory.available if memory else None,
                'memory_available': memory.available if memory else None,
                'memory_percent': memory.percent if memory else None,
                'swap_total': swap.total if swap else None, 'swap_used': swap.used if swap else None,
                'disk_total': disk.total if disk else None, 'disk_used': disk.used if disk else None,
                'disk_free': disk.free if disk else None, 'disk_percent': disk.percent if disk else None,
                'network_recv_per_second': recv_rate, 'network_sent_per_second': sent_rate,
            },
            'daemon': daemon, 'children': children, 'children_summary': children_summary,
            'total': total, 'partial': partial,
        }
        self.previous_processes = current_processes
        self.primed = True
        return report


class SystemStatistics:
    def __init__(self, *, collector: Callable[[], dict] | None = None, interval: float = 5, max_samples: int = 360):
        self._provided_collector = collector
        self.interval = interval
        self.history: deque[dict] = deque(maxlen=max_samples)
        self.sample: dict | None = None
        self.failed = False
        self.last_success: float | None = None
        self.duration_ms: float | None = None
        self._task: asyncio.Task | None = None
        self._executor: ThreadPoolExecutor | None = None

    async def start(self):
        if self._task is not None:
            return
        from services.config import CONFIG_DIR
        self.sample = None
        self.history.clear()
        self.failed = False
        self.last_success = None
        self.duration_ms = None
        collector = self._provided_collector or SystemCollector(CONFIG_DIR)
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='system-statistics')
        self._task = asyncio.create_task(self._run(collector), name='system-statistics')

    async def _run(self, collector):
        loop = asyncio.get_running_loop()
        while True:
            started = time.monotonic()
            try:
                # Await exactly one sample; slow samples never accumulate work.
                sample = await loop.run_in_executor(self._executor, collector)
                self.duration_ms = round((time.monotonic() - started) * 1000, 2)
                self.sample = sample
                self.last_success = time.monotonic()
                self.failed = False
                point = {
                    'sampled_at': sample['sampled_at'],
                    'host_cpu_percent': sample['host']['cpu_percent'],
                    'host_memory_used': sample['host']['memory_used'],
                    'total_cpu_percent': sample['total']['cpu_percent'],
                    'total_memory_rss': sample['total']['memory_rss'],
                    'total_descriptors': sample['total']['descriptors'],
                    'daemon_descriptors': sample['daemon']['descriptors'],
                }
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.warning('System resource sampling failed', exc_info=True)
                self.failed = True
                point = {'sampled_at': datetime.now(timezone.utc).isoformat(), **{
                    key: None for key in ('host_cpu_percent', 'host_memory_used', 'total_cpu_percent',
                                         'total_memory_rss', 'total_descriptors', 'daemon_descriptors')}}
            self.history.append(point)
            cutoff = datetime.now(timezone.utc).timestamp() - 1800
            while self.history and datetime.fromisoformat(self.history[0]['sampled_at']).timestamp() < cutoff:
                self.history.popleft()
            # Skip missed cycles rather than queueing them or busy-looping.
            await asyncio.sleep(self.interval)

    def snapshot(self) -> dict:
        age = time.monotonic() - self.last_success if self.last_success is not None else None
        status = 'error' if self.failed or (age is not None and age > max(15, self.interval * 3)) else 'ok' if self.sample else 'warming'
        return {'status': status, 'sample': self.sample, 'history': list(self.history),
                'interval_seconds': self.interval, 'retention_seconds': 1800,
                'sample_age_seconds': round(age, 2) if age is not None else None,
                'collection_duration_ms': self.duration_ms}

    async def close(self):
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        if self._executor is not None:
            # A running OS read cannot be killed; do not block the event loop on it.
            self._executor.shutdown(wait=False, cancel_futures=True)
            self._executor = None


system_statistics = SystemStatistics()
