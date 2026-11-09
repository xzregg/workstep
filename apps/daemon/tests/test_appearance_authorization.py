"""Appearance management is host-scoped and independent of engine installation."""
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from services.remote_access import ActorSnapshot, actor_context


@pytest.mark.asyncio
@pytest.mark.parametrize("source", [None, "managed"])
async def test_host_can_customize_appearance_without_engine_install(monkeypatch, source):
    import main
    from api import engine, languages, skins
    from services import skin_onboarding
    from services.gateway_client.policy import ManagedPolicyCache

    monkeypatch.setattr(main, "gateway_client", SimpleNamespace(
        managed_config=object(), policy_cache=ManagedPolicyCache(),
    ))
    calls = []

    async def onboarding():
        calls.append("onboarding")
        return {"session_id": "design-session"}

    async def validate(path):
        calls.append(path)
        return {"ok": True}

    monkeypatch.setattr(skin_onboarding, "create_onboarding", onboarding)
    monkeypatch.setattr(engine, "_refresh_and_summaries", lambda: [])
    monkeypatch.setattr(skins, "manager", SimpleNamespace(validate=validate))
    monkeypatch.setattr(languages, "manager", SimpleNamespace(validate=validate))
    app = FastAPI()
    for router in (engine.router, skins.router, languages.router):
        app.include_router(router)
    actor = ActorSnapshot("user-1", "alice", "device-1", "PC", source) if source else None
    with actor_context(actor):
        async with AsyncClient(transport=ASGITransport(app), base_url="http://test") as client:
            assert (await client.post("/api/engine/refresh")).status_code == 200
            response = await client.post("/api/skins/onboarding")
            assert response.status_code == 200, response.text
            assert response.json()["session_id"] == "design-session"
            for prefix in ("skins", "language-packs"):
                response = await client.post(f"/api/{prefix}/validate", json={"path": prefix})
                assert response.status_code == 200, response.text
    assert calls == ["onboarding", "skins", "language-packs"]


@pytest.mark.asyncio
@pytest.mark.parametrize("source", ["remote", "managed"])
async def test_project_actor_cannot_manage_appearance(monkeypatch, source):
    from api import languages, skins

    def forbidden_operation(*args, **kwargs):
        pytest.fail("Project actor reached host package management")

    for module in (skins, languages):
        monkeypatch.setattr(module, "manager", SimpleNamespace(validate=forbidden_operation))
    app = FastAPI()
    app.include_router(skins.router)
    app.include_router(languages.router)
    actor = ActorSnapshot("user-1", "alice", "device-1", "PC", source,
                          project_id="project", access_level="edit")
    with actor_context(actor):
        async with AsyncClient(transport=ASGITransport(app), base_url="http://test") as client:
            assert (await client.post("/api/skins/onboarding")).status_code == 403
            for prefix in ("skins", "language-packs"):
                response = await client.post(f"/api/{prefix}/validate?project_id=project",
                                             json={"path": "/tmp/package"})
                assert response.status_code == 403
