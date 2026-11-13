"""Bounded cleanup for process handles owned by WorkStep or a native SDK.

Snapshot descendants before asking an SDK to close its root: after root exit,
the OS may reparent them. Never scan by command name or signal a shared group.
"""
import asyncio
import inspect
import logging
import os
import time

import psutil

logger = logging.getLogger(__name__)


async def finish_cleanup(operation):
    """Defer even repeated asyncio cancellation until owned cleanup finishes."""
    task = asyncio.ensure_future(operation)
    cancelled = False
    while not task.done():
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            cancelled = True
    result = task.result()
    if cancelled:
        raise asyncio.CancelledError
    return result


def _snapshot(handle):
    pid = getattr(handle, 'pid', None)
    if not isinstance(pid, int) or pid <= 0 or pid == os.getpid():
        return []
    if hasattr(handle, 'poll') and handle.poll() is not None:
        return []
    if getattr(handle, 'returncode', None) is not None:
        return []
    try:
        root = psutil.Process(pid)
        root.create_time()
        children = root.children(recursive=True)
    except psutil.NoSuchProcess:
        return []
    processes = []
    for process in children:
        try:
            process.create_time()  # Cache identity, protecting against PID reuse.
            processes.append(process)
        except psutil.NoSuchProcess:
            pass  # A short-lived child must not discard the root's ownership.
    return [*processes, root]


def _alive(process):
    try:
        return process.is_running() and process.status() != psutil.STATUS_ZOMBIE
    except psutil.NoSuchProcess:
        return False


def _reap(processes):
    # All blocking psutil operations and grace polling run in a worker.
    for process in reversed(processes):
        try:
            if _alive(process):
                process.terminate()
        except psutil.NoSuchProcess:
            pass
    deadline = time.monotonic() + 0.3
    while time.monotonic() < deadline and any(_alive(p) for p in processes):
        time.sleep(0.01)
    for process in reversed(processes):
        try:
            if _alive(process):
                process.kill()
        except psutil.NoSuchProcess:
            pass
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline and any(_alive(p) for p in processes):
        time.sleep(0.01)
    if any(_alive(p) for p in processes):
        raise RuntimeError('Owned child process did not exit after SIGKILL')


async def _wait_handle(handle):
    if handle is None or not hasattr(handle, 'wait'):
        return
    if inspect.iscoroutinefunction(handle.wait):
        await asyncio.wait_for(handle.wait(), 3)
    else:
        await asyncio.to_thread(handle.wait, timeout=3)


async def terminate_owned_process(handle, *, snapshot=None):
    processes = snapshot if snapshot is not None else await asyncio.to_thread(_snapshot, handle)
    await asyncio.to_thread(_reap, processes)
    await _wait_handle(handle)


async def close_subprocess(handle, *, close_stdin=False):
    """Preserve a CLI's graceful exit window, then reap its owned tree."""
    snapshot = None
    try:
        snapshot = await asyncio.to_thread(_snapshot, handle)
        if getattr(handle, 'returncode', None) is None:
            if close_stdin and getattr(handle, 'stdin', None) is not None:
                handle.stdin.close()
            else:
                try:
                    handle.terminate()
                except ProcessLookupError:
                    pass
            try:
                await asyncio.wait_for(handle.wait(), 3 if close_stdin else 5)
            except TimeoutError:
                pass
    finally:
        await finish_cleanup(terminate_owned_process(handle, snapshot=snapshot))


def sdk_process(client):
    process = getattr(getattr(client, '_owned_bridge', None), 'process', None)
    if process is not None:
        return process
    process = getattr(client, 'process', None)
    if process is not None:
        return process
    process = getattr(getattr(client, 'value', None), 'process', None)
    if process is not None:
        return process
    sync = getattr(getattr(client, '_client', None), '_sync', None)
    if sync is not None:
        return getattr(sync, '_proc', None)
    return getattr(getattr(client, '_transport', None), '_process', None)


async def close_sdk_client(client, method='disconnect', *, timeout=5):
    handle = sdk_process(client)
    snapshot = None
    try:
        snapshot = await asyncio.to_thread(_snapshot, handle)
        # Keep disconnect in its calling task: SDKs may own anyio cancel scopes.
        async with asyncio.timeout(timeout):
            await getattr(client, method)()
    except Exception as exc:
        logger.warning('SDK %s failed (%s); reclaiming owned processes', method, type(exc).__name__)
    finally:
        await finish_cleanup(terminate_owned_process(handle, snapshot=snapshot))
