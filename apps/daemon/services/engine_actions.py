"""Engine actions shared by local API and managed device commands."""

import asyncio
from dataclasses import asdict
from tempfile import TemporaryDirectory

from engines.core.registry import create_engine, refresh_registry
from services.config import config_store


async def probe_engine(engine_id: str, *, timeout_seconds: float = 300,
                       model: str = "", values: dict | None = None,
                       clear: dict[str, bool] | None = None,
                       store=None) -> dict:
    store = store or config_store
    engine = await asyncio.to_thread(lambda: (refresh_registry(), create_engine(engine_id))[1])
    if engine is None:
        await asyncio.to_thread(store.set_engine_verified, engine_id, False)
        return {"engine_id": engine_id, "success": False,
                "message": "引擎未安装或当前不可用", "duration_ms": 0,
                "_unavailable": True}
    kwargs = {"timeout_seconds": timeout_seconds}
    if model.strip():
        kwargs["model"] = model.strip()
    overrides = dict(values or {})
    clear_keys = [key for key, enabled in (clear or {}).items() if enabled]
    if clear_keys:
        overrides["__workstep_clear_keys__"] = clear_keys
    if overrides:
        kwargs["config_overrides"] = overrides
    workspace = await asyncio.to_thread(TemporaryDirectory, prefix="workstep-engine-test-")
    try:
        result = await engine.test_connection(cwd=workspace.name, **kwargs)
    finally:
        await asyncio.to_thread(workspace.cleanup)
    await asyncio.to_thread(store.set_engine_verified, engine_id, result.success)
    return {"engine_id": engine_id, **asdict(result)}
