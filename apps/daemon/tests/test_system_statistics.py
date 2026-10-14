"""System sampling, local-only API, and event-loop responsiveness."""
import asyncio
import threading
from datetime import datetime, timezone
import sys
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from services.system_statistics import SystemCollector, SystemStatistics
from services.remote_access import ActorSnapshot, actor_context


def sample():
    return {
        "sampled_at": datetime.now(timezone.utc).isoformat(), "platform": "Darwin",
        "descriptor_kind": "fds", "host": {"cpu_percent": 20, "cpu_count": 4, "memory_used": 500},
        "daemon": {"pid": 42, "cpu_percent": 1, "memory_rss": 100, "descriptors": 10},
        "children": [], "children_summary": {"process_count": 0, "cpu_percent": 0, "memory_rss": 0, "descriptors": 0, "threads": 0},
        "total": {"cpu_percent": 1, "memory_rss": 100, "descriptors": 10, "threads": 1}, "partial": False,
    }


@pytest.mark.asyncio
async def test_sampler_bounds_history_preserves_last_success_and_resets():
    fail = False
    def collect():
        if fail:
            raise OSError("private path must not be returned")
        return sample()
    service = SystemStatistics(collector=collect, interval=.01, max_samples=3)
    await service.start()
    try:
        for _ in range(50):
            if len(service.snapshot()["history"]) == 3:
                break
            await asyncio.sleep(.01)
        report = service.snapshot()
        assert report["status"] == "ok"
        assert len(report["history"]) == 3
        fail = True
        await asyncio.sleep(.03)
        failed = service.snapshot()
        assert failed["status"] == "error"
        assert failed["sample"]["daemon"]["pid"] == 42
        assert "private" not in str(failed)
        assert failed["history"][-1]["host_cpu_percent"] is None
    finally:
        await service.close()
    fail = False
    await service.start()
    assert service.snapshot()["history"] == []
    await service.close()


@pytest.mark.asyncio
async def test_slow_sampler_and_cached_api_do_not_block_health_or_queue_samples():
    import api.statistics as api
    started = threading.Event()
    release = threading.Event()
    calls = 0
    def slow():
        nonlocal calls
        calls += 1
        started.set()
        release.wait(2)
        return sample()
    service = SystemStatistics(collector=slow, interval=.01)
    app = FastAPI()
    app.include_router(api.router)
    @app.get('/health')
    async def health():
        return {"ok": True}
    original = api.system_statistics
    api.system_statistics = service
    await service.start()
    try:
        assert await asyncio.to_thread(started.wait, 1)
        async with AsyncClient(transport=ASGITransport(app=app, client=('127.0.0.1', 123)), base_url='http://localhost') as client:
            for _ in range(5):
                response = await asyncio.wait_for(client.get('/health'), .2)
                assert response.json() == {"ok": True}
                stats = await asyncio.wait_for(client.get('/api/statistics/system'), .2)
                assert stats.status_code == 200
                assert stats.json()['status'] == 'warming'
        assert calls == 1
    finally:
        release.set()
        await service.close()
        api.system_statistics = original


@pytest.mark.asyncio
@pytest.mark.parametrize('peer,forwarded,source,project,expected', [
    ('127.0.0.1', None, None, None, 200),
    ('::1', None, 'browser', None, 200),
    ('127.0.0.1', None, 'remote', None, 403),
    ('127.0.0.1', None, 'managed', 'project-a', 403),
    ('192.0.2.2', '127.0.0.1', None, None, 403),
    ('127.0.0.1', '192.0.2.2', 'browser', None, 403),
])
async def test_system_api_local_boundary(peer, forwarded, source, project, expected):
    import api.statistics as api
    app = FastAPI()
    app.include_router(api.router)
    actor = ActorSnapshot('a', 'user', 'd', 'device', source, project_id=project) if source else None
    headers = {'x-forwarded-for': forwarded} if forwarded else {}
    async with AsyncClient(transport=ASGITransport(app=app, client=(peer, 123)), base_url='http://localhost') as client:
        if actor:
            with actor_context(actor):
                response = await client.get('/api/statistics/system', headers=headers)
        else:
            response = await client.get('/api/statistics/system', headers=headers)
    assert response.status_code == expected


class FakeProcess:
    def __init__(self, pid, created=1, cpu=0, denied=False):
        self.pid, self.created, self.cpu, self.denied = pid, created, cpu, denied
    def create_time(self): return self.created
    def name(self): return 'python' if self.pid == 42 else 'node'
    def cpu_times(self): return SimpleNamespace(user=self.cpu, system=0)
    def memory_info(self): return SimpleNamespace(rss=100)
    def num_threads(self): return 2
    def num_fds(self):
        if self.denied:
            import psutil
            raise psutil.AccessDenied(self.pid)
        return 10
    def num_handles(self): return 12
    def rlimit(self, kind): return (4096, 8192)
    def children(self, recursive): return self.descendants


def setup_collector(monkeypatch, tmp_path):
    import services.system_statistics as module
    monkeypatch.setattr(module.platform, 'system', lambda: 'Darwin')
    monkeypatch.setitem(sys.modules, 'resource', SimpleNamespace(RLIMIT_NOFILE=7, RLIM_INFINITY=-1, getrlimit=lambda kind: (4096, 8192)))
    parent, child = FakeProcess(42), FakeProcess(43)
    parent.descendants = [child]
    monkeypatch.setattr(module.psutil, 'Process', lambda: parent)
    monkeypatch.setattr(module.psutil, 'cpu_count', lambda: 4)
    monkeypatch.setattr(module.psutil, 'cpu_percent', lambda interval: 25)
    monkeypatch.setattr(module.psutil, 'virtual_memory', lambda: SimpleNamespace(total=1000, available=400, percent=60))
    monkeypatch.setattr(module.psutil, 'swap_memory', lambda: SimpleNamespace(total=500, used=20))
    monkeypatch.setattr(module.psutil, 'disk_usage', lambda path: SimpleNamespace(total=10000, used=3000, free=7000, percent=30))
    net = SimpleNamespace(bytes_sent=100, bytes_recv=200)
    monkeypatch.setattr(module.psutil, 'net_io_counters', lambda: net)
    clock = [100.0]
    monkeypatch.setattr(module.time, 'monotonic', lambda: clock[0])
    monkeypatch.setattr(module.time, 'time', lambda: 1000)
    return SystemCollector(tmp_path), parent, child, net, clock


@pytest.mark.parametrize('os_name', ['Darwin', 'Linux'])
def test_collector_cpu_network_deltas_pid_reuse_and_partial(monkeypatch, tmp_path, os_name):
    import services.system_statistics as module
    collector, parent, child, net, clock = setup_collector(monkeypatch, tmp_path)
    monkeypatch.setattr(module.platform, 'system', lambda: os_name)
    first = collector()
    assert first['host']['cpu_percent'] is None
    assert first['daemon']['cpu_percent'] is None
    assert first['host']['network_recv_per_second'] is None
    clock[0] += 5
    parent.cpu, child.cpu, net.bytes_recv = 1, 3, 250
    second = collector()
    assert second['daemon']['cpu_percent'] == 5
    assert second['total']['cpu_percent'] == 20
    assert second['host']['network_recv_per_second'] == 10
    assert second['daemon']['descriptor_limit'] == 4096
    child.created = 2
    child.denied = True
    clock[0] += 5
    third = collector()
    assert third['children'][0]['cpu_percent'] is None
    assert third['total']['descriptors'] is None
    assert third['partial'] is True
    parent.descendants = []
    clock[0] += 5
    fourth = collector()
    assert fourth['children_summary']['cpu_percent'] == 0
    assert fourth['children_summary']['process_count'] == 0


def test_windows_handles_and_network_counter_reset(monkeypatch, tmp_path):
    import services.system_statistics as module
    collector, _, _, net, clock = setup_collector(monkeypatch, tmp_path)
    monkeypatch.setattr(module.platform, 'system', lambda: 'Windows')
    first = collector()
    assert first['descriptor_kind'] == 'handles'
    assert first['daemon']['descriptors'] == 12
    assert first['daemon']['descriptor_limit'] is None
    net.bytes_recv = 0
    clock[0] += 5
    assert collector()['host']['network_recv_per_second'] is None


def test_real_system_collector_returns_only_process_counts_and_not_private_details(tmp_path):
    report = SystemCollector(tmp_path)()
    assert report['daemon']['pid'] > 0
    assert report['host']['cpu_count'] >= 1
    assert report['daemon']['memory_rss'] > 0
    assert 'cmdline' not in str(report)
    assert str(tmp_path) not in str(report)


@pytest.mark.parametrize('os_name', ['Darwin', 'Linux', 'Windows'])
def test_unsupported_host_and_process_metrics_remain_null(monkeypatch, tmp_path, os_name):
    import services.system_statistics as module
    collector, parent, _, _, _ = setup_collector(monkeypatch, tmp_path)
    monkeypatch.setattr(module.platform, 'system', lambda: os_name)
    def unavailable(*args):
        raise NotImplementedError
    parent.num_fds = parent.num_handles = unavailable
    monkeypatch.setattr(module.psutil, 'swap_memory', unavailable)
    monkeypatch.setattr(module.psutil, 'disk_usage', unavailable)
    monkeypatch.setattr(module.psutil, 'net_io_counters', unavailable)
    report = collector()
    assert report['partial'] is True
    assert report['daemon']['descriptors'] is None
    assert report['total']['descriptors'] is None
    assert report['host']['swap_used'] is None
    assert report['host']['disk_used'] is None
    assert report['host']['network_recv_per_second'] is None


@pytest.mark.asyncio
async def test_real_sampler_cached_response_marks_stale_and_has_bounded_serialized_size(tmp_path):
    import json
    service = SystemStatistics(collector=SystemCollector(tmp_path), interval=.01)
    await service.start()
    try:
        for _ in range(100):
            if len(service.snapshot()['history']) >= 2:
                break
            await asyncio.sleep(.01)
        report = service.snapshot()
        assert report['status'] == 'ok'
        assert report['sample']['daemon']['cpu_percent'] is not None
        assert report['collection_duration_ms'] is not None
        assert len(json.dumps(report)) < 100_000
        service.last_success -= 16
        assert service.snapshot()['status'] == 'error'
    finally:
        await service.close()
