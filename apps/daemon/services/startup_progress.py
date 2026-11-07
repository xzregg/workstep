"""Flushed startup diagnostics, independent of application logging configuration."""

import asyncio
import sys
import time
from contextlib import asynccontextmanager


def _write(message: str) -> None:
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
