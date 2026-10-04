"""Workspace metadata stays project-bound and does not expose host configuration."""
import asyncio
import time

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from services.remote_access import ActorSnapshot, actor_context


@pytest.mark.anyio
async def test_workspace_catalog_scope_redaction_and_slow_io(tmp_path, monkeypatch):
    import api.engine as engine_api
    import api.assistant as assistant_api
    import api.provider as provider_api
    import services.config as config_module
    from services.config import ConfigStore
    monkeypatch.setattr(config_module, "CONFIG_FILE", tmp_path / "config.json")
    store = ConfigStore()
    for module in (engine_api, assistant_api, provider_api):
        monkeypatch.setattr(module, "config_store", store)

    secret_engine = {
        "id": "codex", "installed": True, "supports_coordinator": True,
        "binary_path": "/private/bin/codex", "configured_path": "/private/bin/codex",
        "install_command": "private install", "update_command": "private update",
        "runtime_manageable": True, "installable": True, "updatable": True,
        "config": {"fields": [{"key": "secret"}], "values": {"token": "private-token"},
                   "secrets": {"token": True}, "step_fields": [{"key": "sandbox", "sensitive": False}]},
    }
    def slow_engines():
        time.sleep(.2)
        return [secret_engine]
    monkeypatch.setattr(engine_api, "_engine_summaries", slow_engines)
    monkeypatch.setattr(engine_api, "_coordinator_engine_options", lambda: [secret_engine])
    monkeypatch.setattr(assistant_api, "_available_engines", lambda: [secret_engine])
    monkeypatch.setattr(provider_api.config_store, "get_providers", lambda: [{
        "id": "p1", "name": "Allowed", "type": "custom", "base_url": "https://private-host",
        "api_key": "private-key", "protocol_base_urls": {"openai": "https://private-host"},
    }])
    app = FastAPI()
    for router in (engine_api.router, assistant_api.router, provider_api.router):
        app.include_router(router)
    @app.get("/health")
    async def health():
        return {"ok": True}
    actor = ActorSnapshot("worker", "Worker", "device", "Device", "managed",
                          project_id="visible", access_level="read")
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with actor_context(actor):
            for route in ("/engine/list", "/engine/execution/config", "/engine/coordinator/config",
                          "/assistant/list", "/provider/list", "/engine/codex/models"):
                for query in ("", "?project_id=private"):
                    response = await client.get("/api" + route + query)
                    assert response.status_code == 403, (route, response.text)
            pending = asyncio.create_task(client.get("/api/engine/list?project_id=visible"))
            await asyncio.sleep(.03)
            assert (await asyncio.wait_for(client.get("/health"), .15)).status_code == 200
            response = await pending
            assert response.status_code == 200, response.text
            public = response.json()["engines"][0]
            assert public["binary_path"] is None
            assert public["runtime_manageable"] is False
            assert public["config"]["step_fields"] == [{"key": "sandbox", "sensitive": False}]
            assert "private" not in response.text
            for route in ("/engine/coordinator/config", "/assistant/list", "/provider/list", "/engine/codex/models"):
                response = await client.get("/api" + route + "?project_id=visible")
                assert response.status_code == 200, response.text
                assert "private" not in response.text


@pytest.mark.anyio
async def test_workspace_model_refresh_and_error_do_not_expose_host(monkeypatch):
    import api.engine as engine_api
    from fastapi import HTTPException
    class Engine:
        def resolve_provider_runtime(self, **kwargs):
            raise RuntimeError("private-token at /private/config.json")
    monkeypatch.setattr(engine_api, "refresh_registry", lambda **kwargs: None)
    monkeypatch.setattr(engine_api, "create_engine", lambda _: Engine())
    monkeypatch.setattr(engine_api.config_store, "get_engine_default_model", lambda _: "")
    actor = ActorSnapshot("worker", "Worker", "device", "Device", "managed",
                          project_id="visible", access_level="read")
    with actor_context(actor):
        with pytest.raises(HTTPException) as denied:
            await engine_api.list_engine_models("codex", refresh=True, project_id="visible")
        assert denied.value.status_code == 403
        result = await engine_api.list_engine_models("codex", project_id="visible")
        assert result["error"] == "读取模型列表失败"
