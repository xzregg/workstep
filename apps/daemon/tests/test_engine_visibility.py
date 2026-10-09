"""Display-only engine visibility API and event-loop canary."""
import asyncio
import threading

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient


@pytest.mark.asyncio
async def test_visibility_api_and_slow_save_canary(monkeypatch, tmp_path):
    import api.engine as api
    from services.config import ConfigStore
    import services.config as config_module
    monkeypatch.setattr(config_module, "CONFIG_DIR", tmp_path)
    monkeypatch.setattr(config_module, "CONFIG_FILE", tmp_path / "config.json")
    store = ConfigStore()
    store._cache = {}
    entered = threading.Event()
    release = threading.Event()
    original = store.set_engine_enabled

    def slow_save(engine_id, enabled):
        entered.set()
        assert release.wait(2)
        original(engine_id, enabled)

    monkeypatch.setattr(api, "config_store", store)
    monkeypatch.setattr(store, "set_engine_enabled", slow_save)
    monkeypatch.setattr(api, "_require_managed_engine_permission", lambda: None)
    monkeypatch.setattr(api, "list_all_engines", lambda: {"codex": object})
    monkeypatch.setattr(api, "_refresh_and_summaries", lambda: [{"id": "codex", "enabled": store.is_engine_enabled("codex")}])
    app = FastAPI()
    app.include_router(api.router)

    @app.get("/health")
    async def health():
        return {"ok": True}

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        task = asyncio.create_task(client.put("/api/engine/codex/visibility", json={"enabled": True}))
        try:
            assert await asyncio.to_thread(entered.wait, 1)
            response = await asyncio.wait_for(client.get("/health"), .3)
            assert response.json() == {"ok": True}
        finally:
            release.set()
        assert (await task).json() == {"engines": [{"id": "codex", "enabled": True}]}
        response = await client.put("/api/engine/unknown/visibility", json={"enabled": False})
        assert response.status_code == 404
        response = await client.put("/api/engine/codex/visibility", json={})
        assert response.status_code == 422
