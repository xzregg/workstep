"""Flushed startup diagnostics, independent of application logging configuration."""

import asyncio
import logging
import sys
import time
from contextlib import asynccontextmanager


def _write(message: str) -> None:
    from services.runtime_logging import runtime_logging_installed
    if runtime_logging_installed():
        logging.getLogger(__name__).info(message)
    else:
        # Embedded desktop startup owns its console/READY protocol and logs.
        print(message, file=sys.stderr, flush=True)


@asynccontextmanager
async def startup_stage(name: str):
    started = time.monotonic()
    await asyncio.to_thread(_write, f"STARTUP {name} start")
    state = "failed"
    try:
        yield
        state = "complete"
    finally:
        elapsed_ms = round((time.monotonic() - started) * 1000)
        await asyncio.to_thread(_write, f"STARTUP {name} {state} elapsed_ms={elapsed_ms}")
