"""Persistent stream-json CLI process leases; one native conversation each."""
import asyncio
from contextlib import asynccontextmanager
from types import SimpleNamespace

from engines.core.process_cleanup import close_subprocess, finish_cleanup
from engines.core.session_pool import ManagedConnection, get_session_pool, startup_fingerprint


@asynccontextmanager
async def pooled_cli_process(engine, cmd, options, session_id):
    pool = get_session_pool(engine.ENGINE_ID)
    identity = list(cmd)
    if '--resume' in identity:
        index = identity.index('--resume')
        del identity[index:index + 2]
    fingerprint = await asyncio.to_thread(startup_fingerprint, (identity, options))
    @asynccontextmanager
    async def context():
        process = await asyncio.create_subprocess_exec(*cmd, **options)
        stderr = []
        async def drain():
            while chunk := await process.stderr.read(8192):
                stderr.append(chunk)
                del stderr[:-8]
        task = asyncio.create_task(drain())
        try:
            yield SimpleNamespace(process=process, stderr=stderr)
        finally:
            if process.stdin is not None:
                process.stdin.close()
            await finish_cleanup(close_subprocess(process))
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
    lease = await pool.acquire(options['cwd'], session_id, fingerprint,
                               lambda: ManagedConnection(context))
    engine._transport_lease = lease
    complete = False
    try:
        value = await lease.client.open()
        engine._process = value.process
        yield lease, value
        complete = bool(getattr(engine, '_turn_done', False) and not getattr(engine, '_turn_error', True)
                        and not getattr(engine, '_cli_injected', False) and value.process.returncode is None)
    finally:
        await pool.release(lease, reusable=complete)
        if getattr(engine, '_transport_lease', None) is lease:
            engine._transport_lease = None
        engine._process = None
        engine._running = False
