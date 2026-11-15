"""Standard-library diagnostic logging plus WorkStep retention rules.

Conversation event journals are business history and are deliberately outside
this policy. No subprocess is created to collect diagnostic output.
"""
from __future__ import annotations

import atexit
from dataclasses import dataclass
from datetime import datetime, timezone
import logging
import os
from pathlib import Path
import queue
from logging.handlers import QueueHandler, QueueListener, RotatingFileHandler
import signal
import sys
import threading
import time
import weakref

_path_registry_lock = threading.Lock()
_path_locks = weakref.WeakValueDictionary()


def file_lock(path):
    key = os.path.abspath(path)
    with _path_registry_lock:
        lock = _path_locks.get(key)
        if lock is None:
            lock = threading.RLock()
            _path_locks[key] = lock
        return lock
_installed = None


@dataclass(frozen=True)
class LogPolicy:
    max_bytes: int = 5 * 1024 * 1024
    backups: int = 9
    retention_days: int = 14
    records_per_second: int = 100
    bytes_per_second: int = 256 * 1024

    @classmethod
    def from_env(cls):
        def number(name, default, low, high):
            value = int(os.environ.get(name, default))
            if not low <= value <= high:
                raise ValueError(f'{name} must be between {low} and {high}')
            return value
        return cls(number('WORKSTEP_LOG_MAX_MIB', 5, 1, 1024) * 1024 * 1024,
                   number('WORKSTEP_LOG_BACKUPS', 9, 0, 99),
                   number('WORKSTEP_LOG_RETENTION_DAYS', 14, 1, 3650),
                   number('WORKSTEP_LOG_RECORDS_PER_SECOND', 100, 1, 10000),
                   number('WORKSTEP_LOG_KIB_PER_SECOND', 256, 64, 16384) * 1024)


def diagnostic_policy():
    """A bad diagnostic setting must not abort a business operation."""
    try:
        return LogPolicy.from_env()
    except ValueError:
        return LogPolicy()


class BoundedLog:
    def __init__(self, path, policy, *, persistent=False):
        self.path = Path(path)
        self.policy = policy
        self.lock = file_lock(self.path)
        self.persistent = persistent
        self.handler = None
        self.disabled = False

    def _bounded(self, value):
        data = value.encode('utf-8', errors='replace')
        if len(data) > self.policy.max_bytes:
            marker = b'[truncated; recent output follows]\n'
            tail = data[-max(0, self.policy.max_bytes-len(marker)):].decode('utf-8', errors='ignore').encode()
            data = (marker + tail)[-self.policy.max_bytes:]
        return data

    def prune(self, *, now=None, include_active=True):
        now = time.time() if now is None else now
        cutoff = now - self.policy.retention_days * 86400
        with self.lock:
            candidates = [*self.path.parent.glob(self.path.name + '.*')]
            if include_active: candidates.append(self.path)
            for path in candidates:
                suffix = path.name[len(self.path.name):]
                if suffix and (not suffix.startswith('.') or not suffix[1:].isdigit()):
                    continue
                if path.is_symlink():
                    raise ValueError('Diagnostic log cannot be a symbolic link')
                try:
                    stat = path.stat()
                    if stat.st_mtime < cutoff or suffix and int(suffix[1:]) > self.policy.backups:
                        path.unlink(missing_ok=True)
                    elif stat.st_size > self.policy.max_bytes:
                        # Bound legacy files too; never read a multi-GB log whole.
                        with path.open('rb') as stream:
                            stream.seek(-self.policy.max_bytes, os.SEEK_END)
                            tail = stream.read(self.policy.max_bytes).decode('utf-8', errors='ignore')
                        temporary = path.with_name(path.name + '.bounded-tmp')
                        temporary.write_bytes(self._bounded(tail))
                        os.chmod(temporary, 0o600)
                        temporary.replace(path)
                        os.utime(path, (stat.st_atime, stat.st_mtime))
                except FileNotFoundError:
                    continue

    def append(self, value, *, now=None):
        # Action output already runs in the shared executor. Delegate actual
        # file writes and rollover to the standard logging handler as well.
        with self.lock:
            handler = self.handler or RetentionFileHandler(self)
            if self.persistent: self.handler = handler
            handler.terminator = ''
            record = logging.makeLogRecord({'msg': value, 'args': (),
                'levelno': logging.INFO, 'levelname': 'INFO',
                'created': time.time() if now is None else now})
            try:
                handler.handle(record)
            finally:
                if not self.persistent: handler.close()
            if now is not None: os.utime(self.path, (now, now))

    def close(self):
        with self.lock:
            if self.handler:
                self.handler.close()
                self.handler = None

    def prune_redirected(self, *, now=None):
        """Copy/truncate an external O_APPEND writer without replacing its inode.

        Used only for Vite's diagnostic stream. Checks are triggered by ordinary
        log writes, at most once a minute; no monitoring thread is created.
        """
        clock = time.time() if now is None else now
        with self.lock:
            if self.path.is_symlink(): raise ValueError('Diagnostic log cannot be a symbolic link')
            if not self.path.exists(): return
            with self.path.open('r+b') as stream:
                stat = os.fstat(stream.fileno())
                expired = stat.st_mtime < clock - self.policy.retention_days * 86400
                if expired or stat.st_size > self.policy.max_bytes or int(stat.st_mtime // 86400) != int(clock // 86400):
                    if self.policy.backups and not expired:
                        self.path.with_name(self.path.name + f'.{self.policy.backups}').unlink(missing_ok=True)
                        for index in range(self.policy.backups-1, 0, -1):
                            source = self.path.with_name(self.path.name + f'.{index}')
                            if source.is_symlink(): raise ValueError('Diagnostic log cannot be a symbolic link')
                            if source.exists(): source.replace(self.path.with_name(self.path.name + f'.{index+1}'))
                        stream.seek(max(0, stat.st_size - self.policy.max_bytes))
                        backup = self.path.with_name(self.path.name + '.1')
                        if backup.is_symlink(): raise ValueError('Diagnostic log cannot be a symbolic link')
                        backup.write_bytes(stream.read(self.policy.max_bytes))
                        os.chmod(backup, 0o600)
                        os.utime(backup, (stat.st_atime, stat.st_mtime))
                    stream.truncate(0)
                    os.utime(self.path, (clock, clock))
            self.prune(now=clock, include_active=False)


class DiagnosticBudget(logging.Filter):
    """Cap diagnostic write pressure, reserving capacity for error records."""
    def __init__(self, policy, formatter):
        super().__init__()
        self.policy, self.formatter = policy, formatter
        self.clock = time.monotonic
        self.window = self.clock()
        self.count = self.size = self.normal_count = self.normal_size = 0
        self.skipped = 0

    def filter(self, record):
        now = self.clock()
        if now - self.window >= 1:
            self.window = now
            self.count = self.size = self.normal_count = self.normal_size = 0
        normal = record.levelno < logging.ERROR
        count_limit = max(1, int(self.policy.records_per_second * .8))
        room = self.policy.bytes_per_second - self.size
        if normal: room = min(room, self.policy.bytes_per_second // 2 - self.normal_size)
        if (self.count >= self.policy.records_per_second or normal and self.normal_count >= count_limit
                or isinstance(record.msg, str) and len(record.msg) > room):
            self.skipped += 1
            return False
        record.msg = bounded_message(record.getMessage(), limit=self.policy.bytes_per_second // 2)
        record.args = ()
        if self.skipped:
            record.msg = f'[日志过密，省略 {self.skipped} 条] ' + record.msg
        try:
            size = len((self.formatter(record) + '\n').encode('utf-8', errors='replace'))
        except Exception:
            # Let the standard handler's guarded emit/handleError report a
            # formatting problem; never kill QueueListener from a filter.
            return True
        if size > room:
            self.skipped += 1
            return False
        self.skipped = 0
        self.count += 1
        self.size += size
        if normal:
            self.normal_count += 1
            self.normal_size += size
        return True


class RetentionFileHandler(RotatingFileHandler):
    """Standard size rotation plus WorkStep's age and UTF-8 byte budget."""
    def __init__(self, sink, *, external_sinks=()):
        sink.path.parent.mkdir(parents=True, exist_ok=True)
        sink.prune()
        self.sink = sink
        self.external_sinks = external_sinks
        self.last_prune = 0
        self.day = int(sink.path.stat().st_mtime // 86400) if sink.path.exists() else int(time.time() // 86400)
        super().__init__(sink.path, maxBytes=sink.policy.max_bytes,
                         backupCount=sink.policy.backups, encoding='utf-8', delay=True)
        self.addFilter(DiagnosticBudget(sink.policy, self.format))
        self.retry_after = 0

    def shouldRollover(self, record):
        standard = super().shouldRollover(record)
        day = int(record.created // 86400)
        size = len((self.format(record) + self.terminator).encode('utf-8'))
        rollover = standard or self.stream.tell() + size > self.maxBytes or day != self.day
        self.day = day
        return rollover

    def doRollover(self):
        if self.backupCount:
            super().doRollover()
        else:
            # The stdlib treats zero backups as append-only. Restart output
            # explicitly wants just one bounded current file instead.
            if self.stream:
                self.stream.close()
                self.stream = None
            with open(self.baseFilename, 'w', encoding='utf-8'):
                pass

    def emit(self, record):
        if time.monotonic() < self.retry_after: return
        try:
            with self.sink.lock:
                if time.monotonic() - self.last_prune > 60:
                    self.sink.prune(now=record.created, include_active=False)
                    for sink in self.external_sinks: sink.prune_redirected()
                    self.last_prune = time.monotonic()
                # Format once, bounding even a single oversized exception/output.
                text = self.format(record)
                bounded = self.sink._bounded(text + self.terminator).decode('utf-8')
                prepared = logging.makeLogRecord({**record.__dict__, 'msg': bounded,
                    'args': (), 'exc_info': None, 'exc_text': None})
                formatter, terminator = self.formatter, self.terminator
                try:
                    self.setFormatter(logging.Formatter('%(message)s'))
                    self.terminator = ''
                    super().emit(prepared)
                finally:
                    self.setFormatter(formatter)
                    self.terminator = terminator
        except Exception:
            self.handleError(record)

    def handleError(self, record):
        self.retry_after = time.monotonic() + 60
        super().handleError(record)

def bounded_message(value, limit=64 * 1024):
    if not isinstance(value, str) or len(value) <= limit // 4:
        return value
    marker = '…[日志过长，已截断]…'
    if len(value) > limit:
        value = value[:limit//2] + marker + value[-limit//2:]
    data = value.encode('utf-8', errors='replace')
    if len(data) <= limit: return value
    marker = marker.encode()
    half = (limit - len(marker)) // 2
    return data[:half].decode('utf-8', errors='ignore') + marker.decode() + data[-half:].decode('utf-8', errors='ignore')


class RecentQueueHandler(QueueHandler):
    accepting = True

    def handleError(self, record):
        now = time.monotonic()
        if now >= getattr(self, 'report_after', 0):
            self.report_after = now + 60
            super().handleError(record)

    def prepare(self, record):
        import copy
        record = copy.copy(record)
        if isinstance(record.args, tuple):
            record.args = tuple(bounded_message(value) for value in record.args)
        elif isinstance(record.args, dict):
            record.args = {key: bounded_message(value) for key, value in record.args.items()}
        # Truncating a format template can remove a %s while leaving its args.
        # Merge an oversized template first so valid logging never becomes a
        # formatting error merely because the message exceeds our budget.
        if record.args and isinstance(record.msg, str) and len(record.msg) > 64 * 1024:
            record.msg = record.getMessage()
            record.args = ()
        record.msg = bounded_message(record.msg)
        prepared = super().prepare(record)
        prepared.msg = bounded_message(prepared.msg)
        prepared.message = prepared.msg
        return prepared

    def enqueue(self, record):
        if not self.accepting: return
        try:
            super().enqueue(record)
        except queue.Full:
            if not self.accepting: return
            try:
                removed = self.queue.get_nowait()
                self.queue.task_done()
                if removed is QueueListener._sentinel:
                    self.queue.put_nowait(removed)
                    return
            except queue.Empty: pass
            if not self.accepting: return
            record.msg = bounded_message('日志队列已满，省略较早输出；' + record.getMessage())
            record.args = ()
            try: super().enqueue(record)
            except queue.Full: pass


class LogListener(QueueListener):
    def stop(self, timeout=5):
        thread = self._thread
        if thread is None: return True
        deadline = time.monotonic() + timeout
        try:
            self.queue.put(self._sentinel, timeout=max(0, timeout))
        except queue.Full:
            # Logging is already detached. Drop a queued record to signal the
            # standard worker without another thread or an unbounded wait.
            try:
                self.queue.get_nowait()
                self.queue.task_done()
            except queue.Empty: pass
            self.queue.put_nowait(self._sentinel)
        thread.join(max(0, deadline - time.monotonic()))
        if thread.is_alive(): return False
        self._thread = None
        return True


class RuntimeLogging:
    """One stdlib QueueListener; no custom reader, writer or polling threads."""
    def __init__(self, sink, *, queue_size=512, external_sinks=(), policy=None):
        self.sink = sink
        self.queue = queue.Queue(maxsize=queue_size)
        self.file_handler = RetentionFileHandler(sink, external_sinks=external_sinks) if sink else logging.StreamHandler(sys.stderr)
        if sink is None:
            self.file_handler.addFilter(DiagnosticBudget(policy or LogPolicy(), self.file_handler.format))
        formatter = logging.Formatter('%(asctime)sZ %(levelname)s %(name)s: %(message)s')
        formatter.converter = time.gmtime
        self.file_handler.setFormatter(formatter)
        self.handler = RecentQueueHandler(self.queue)
        self.handler.setLevel(logging.INFO)
        self.listener = LogListener(self.queue, self.file_handler)
        self.listener.start()
        self.closed = False
        self.stopped = None
        self.shutdown_timeout = 5
        self.fallback_reason = None
        self.close_lock = threading.RLock()

    def configure(self):
        root = logging.getLogger()
        root.setLevel(logging.INFO)
        root.handlers = [self.handler]
        for name in ('uvicorn', 'uvicorn.error', 'uvicorn.access'):
            logger = logging.getLogger(name)
            logger.handlers = [self.handler]
            logger.propagate = False
        def uncaught(kind, value, traceback):
            logging.getLogger('workstep').critical('未捕获的后台异常', exc_info=(kind, value, traceback))
            if not self.close(): os._exit(1)
        sys.excepthook = uncaught

    def close(self):
        with self.close_lock:
            if self.closed: return self.stopped
            self.handler.accepting = False
            self.stopped = self.listener.stop(timeout=self.shutdown_timeout)
            self.closed = True
            if self.stopped:
                self.file_handler.close()
            return self.stopped


def install_runtime_logging(directory, name='daemon.log', *, backups=None):
    global _installed
    if _installed is not None: return _installed
    policy_error = None
    try:
        policy = LogPolicy.from_env()
    except ValueError as exc:
        policy, policy_error = LogPolicy(), str(exc)
    if backups is not None:
        from dataclasses import replace
        policy = replace(policy, backups=backups)
    sink = BoundedLog(Path(directory) / name, policy)
    external = [BoundedLog(Path(directory) / 'web.log', policy)] if name == 'daemon.log' and os.environ.get('WORKSTEP_LOG_MAINTAIN_WEB') == '1' else []
    try:
        runtime = RuntimeLogging(sink, external_sinks=external)
    except (OSError, ValueError) as exc:
        runtime = RuntimeLogging(None, policy=policy)
        runtime.fallback_reason = str(exc)
    runtime.configure()
    _installed = runtime
    if policy_error:
        logging.getLogger(__name__).error('日志配置无效：%s；使用默认值继续运行', policy_error)
    if runtime.fallback_reason:
        logging.getLogger(__name__).warning('日志文件不可用，降级到宿主标准错误输出：%s', runtime.fallback_reason)
    def exit_flush():
        if not runtime.close():
            # The process is already exiting. Avoid logging.shutdown acquiring
            # a file lock held forever by failed storage in the daemon worker.
            os._exit(1)
    atexit.register(exit_flush)
    if threading.current_thread() is threading.main_thread() and signal.getsignal(signal.SIGTERM) == signal.SIG_DFL:
        def terminate(signum, frame):
            # Uvicorn re-raises SIGTERM after its graceful shutdown; a default
            # signal exit skips atexit. Drain final diagnostics before restoring
            # the original termination semantics.
            runtime.close()
            signal.signal(signum, signal.SIG_DFL)
            signal.raise_signal(signum)
        signal.signal(signal.SIGTERM, terminate)
    return runtime


def queue_handler():
    """Uvicorn dictConfig factory; all records use its standard QueueHandler."""
    directory = os.environ.get('WORKSTEP_LOG_DIR') or str(Path(os.environ.get('WORKSTEP_CONFIG_DIR') or Path.home() / '.workstep') / 'logs')
    return install_runtime_logging(directory).handler


def runtime_logging_installed():
    return _installed is not None


def prune_action_logs(workstep_dir, active_ids, policy, *, now=None):
    """Only diagnostic output files of inactive runs; never event history/DBs."""
    now = time.time() if now is None else now
    root = Path(workstep_dir) / 'action-runs'
    if root.is_symlink() or not root.exists(): return
    files = []
    for folder in root.iterdir():
        if folder.is_symlink() or not folder.is_dir() or folder.name in active_ids: continue
        for path in folder.glob('output.log*'):
            suffix = path.name[len('output.log'):]
            if suffix and (not suffix.startswith('.') or not suffix[1:].isdigit()): continue
            if path.is_symlink(): continue
            stat = path.stat()
            if stat.st_mtime < now - policy.retention_days * 86400:
                path.unlink(missing_ok=True)
            else:
                files.append((stat.st_mtime, stat.st_size, path))
    total = sum(size for _, size, _ in files)
    budget = policy.max_bytes * (policy.backups + 1)
    for _, size, path in sorted(files):
        if total <= budget: break
        path.unlink(missing_ok=True)
        total -= size

class DiagnosticLogRetention:
    def __init__(self, manager, runtime, *, interval=3600, startup_delay=30):
        import asyncio
        self.manager, self.runtime = manager, runtime
        self.interval, self.startup_delay = interval, startup_delay
        self.stop = asyncio.Event()
        self.task = None

    async def sweep(self):
        import asyncio
        policy = diagnostic_policy()
        for project in list(self.manager.iter_projects()):
            if self.stop.is_set(): break
            try:
                # Membership checks use the live run map; active run IDs are
                # registered before their output directories are created.
                await asyncio.to_thread(prune_action_logs, project.workstep_dir, self.runtime.tasks, policy)
            except Exception:
                logging.getLogger(__name__).warning('Diagnostic log retention failed: project=%s', project.id, exc_info=True)

    async def _wait(self, seconds):
        import asyncio
        try: await asyncio.wait_for(self.stop.wait(), seconds)
        except asyncio.TimeoutError: pass

    async def run(self):
        await self._wait(self.startup_delay)
        while not self.stop.is_set():
            await self.sweep()
            await self._wait(self.interval)

    def start(self):
        import asyncio
        self.task = asyncio.create_task(self.run())

    async def close(self):
        self.stop.set()
        if self.task: await self.task
