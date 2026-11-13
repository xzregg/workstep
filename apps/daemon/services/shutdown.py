"""Close every owned service even when an earlier shutdown step fails."""
import asyncio
import logging

from engines.core.process_cleanup import finish_cleanup

logger = logging.getLogger(__name__)


async def close_deepseek_pool():
    # Optional engine import is itself a shutdown step, so it cannot prevent
    # unrelated services from releasing their resources.
    from engines.deepseek_harness import DeepSeekHarnessEngine
    await asyncio.to_thread(DeepSeekHarnessEngine.shutdown_pool)


async def run_shutdown(steps):
    async def run():
        for name, close in steps:
            try:
                async with asyncio.timeout(10):
                    await close()
            except (Exception, asyncio.CancelledError) as exc:
                logger.warning('Shutdown step %s failed (%s); continuing cleanup', name, type(exc).__name__)
    await finish_cleanup(run())
