"""Exercise settings routes with real signed allow/deny policies, without network I/O."""
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from services.gateway_client.policy import ManagedPolicyCache, verify_policy_snapshot
from services.remote_access import ActorSnapshot, actor_context
from tests.test_gateway_policy import _signed_policy
from tests.test_api_engine_config import MemoryEngineConfigStore


@pytest.fixture
def settings_app(monkeypatch):
    import main
    from api import engine, provider

    store = MemoryEngineConfigStore()
    monkeypatch.setattr(store, "set_engine_binary_path", lambda *a: None, raising=False)
    cache = ManagedPolicyCache()
    gateway = SimpleNamespace(managed_config=object(), policy_cache=cache)
    monkeypatch.setattr(main, "gateway_client", gateway)
    monkeypatch.setattr(engine, "config_store", store)
    monkeypatch.setattr(provider, "config_store", store)
    monkeypatch.setattr(engine, "refresh_registry", lambda *a, **kw: None)
    monkeypatch.setattr(provider, "refresh_registry", lambda: None)
    monkeypatch.setattr(engine, "get_available_engines", lambda: [{"id": "demo"}])
    monkeypatch.setattr(engine, "_engine_info", lambda _: {})
    monkeypatch.setattr(engine, "_engine_config_snapshot", lambda _: {})
    monkeypatch.setattr(engine, "_engine_config_response", lambda *a: {})

    class DemoEngine:
        async def save_full_config_values(self, *a, **kw):
            store.default_models["changed"] = True

        def reveal_config_value(self, key):
            return "fixture-secret"

    monkeypatch.setattr(engine, "create_engine", lambda _: DemoEngine())
    monkeypatch.setattr(engine, "list_all_engines", lambda: {"demo": DemoEngine})
    monkeypatch.setattr(provider.provider_service, "scan_cc_switch_providers", lambda: [])
    app = FastAPI()
    app.include_router(engine.router)
    app.include_router(provider.router)
    return app, gateway


SETTINGS_WRITES = [
    ("PUT", "/api/engine/execution/config", {"engine": ""}),
    ("PUT", "/api/engine/coordinator/config", {"engine": ""}),
    ("PUT", "/api/engine/demo/default-model", {"model": "fixture-model"}),
    ("PUT", "/api/engine/demo/binary-path", {"path": ""}),
    ("PUT", "/api/engine/demo/config", {"values": {}}),
    ("POST", "/api/engine/demo/config/reveal", {"key": "token"}),
    ("POST", "/api/provider/import/cc-switch", {"provider_ids": []}),
    ("GET", "/api/provider/import/sources", None),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("method,path,body", SETTINGS_WRITES)
@pytest.mark.parametrize("mode", ["denied", "allowed", "project", "unmanaged", "other-user", "expired"])
async def test_settings_require_matching_host_permission(settings_app, method, path, body, mode):
    app, gateway = settings_app
    allowed = mode in ("allowed", "project", "other-user", "expired")
    token, pem, fingerprint = _signed_policy(engine_install=allowed, allow_local_providers=allowed)
    gateway.policy_cache.apply(verify_policy_snapshot(
        token, pem, fingerprint, "gateway-test", "device-1", "user-1"))
    if mode == "expired":
        from dataclasses import replace
        gateway.policy_cache.current = replace(gateway.policy_cache.current, expires_at=0)
    if mode == "unmanaged":
        gateway.managed_config = None
    actor = ActorSnapshot("user-2" if mode == "other-user" else "user-1", "Alice", "device-1", "PC", "managed",
                          project_id="project" if mode == "project" else None,
                          access_level="edit" if mode == "project" else None)
    with actor_context(actor):
        async with AsyncClient(transport=ASGITransport(app), base_url="http://test") as client:
            response = await client.request(method, path, **({"json": body} if body is not None else {}))
    expected = 200 if mode in ("allowed", "unmanaged") else 403
    assert response.status_code == expected, response.text
