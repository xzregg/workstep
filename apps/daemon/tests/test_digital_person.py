import asyncio
import threading
from types import SimpleNamespace

import pytest
from tests.test_chat_session import chat_module
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient


@pytest.fixture
def setup(tmp_path, monkeypatch):
    from api import digital_person
    from services import config, digital_person as service
    monkeypatch.setattr(config, "CONFIG_FILE", tmp_path / "config.json")
    monkeypatch.setattr(config, "CONFIG_DIR", tmp_path)
    monkeypatch.setattr(config.config_store, "_cache", None)
    app = FastAPI()
    app.include_router(digital_person.router)
    @app.get("/health")
    async def health():
        return {"ok": True}
    return app, service


async def test_profile_roundtrip_validation_and_restart(setup):
    app, service = setup
    async with AsyncClient(transport=ASGITransport(app), base_url="http://test") as client:
        original = (await client.get("/api/digital-person")).json()
        assert original["enabled"] is False
        payload = {**original, "enabled": True, "name": "小研", "duties": "跟进研发", "personality": "直接"}
        response = await client.put("/api/digital-person", json=payload)
        assert response.status_code == 200
        service.config_store._cache = None
        assert (await client.get("/api/digital-person")).json()["duties"] == "跟进研发"
        assert (await client.put("/api/digital-person", json={**payload, "name": "   "})).status_code == 422
        assert (await client.put("/api/digital-person", json={**payload, "workspace": "/tmp"})).status_code == 422


@pytest.mark.parametrize('endpoint', ['/api/digital-person', '/api/digital-person/voice-wake'])
async def test_slow_save_does_not_block_health(setup, monkeypatch, endpoint):
    app, service = setup
    entered, release = threading.Event(), threading.Event()
    original = service.config_store.set
    def slow(*args):
        entered.set()
        assert release.wait(3)
        return original(*args)
    monkeypatch.setattr(service.config_store, "set", slow)
    async with AsyncClient(transport=ASGITransport(app), base_url="http://test") as client:
        payload = (await client.get(endpoint)).json()
        payload.pop('available', None); payload.pop('listening', None)
        pending = asyncio.create_task(client.put(endpoint, json=payload))
        try:
            assert await asyncio.to_thread(entered.wait, 2)
            assert (await asyncio.wait_for(client.get("/health"), .5)).status_code == 200
        finally:
            release.set()
        assert (await pending).status_code == 200


@pytest.mark.parametrize("source", ["share", "remote_project"])
async def test_project_identity_cannot_manage_host(setup, source):
    from services.remote_access import ActorSnapshot, actor_context
    app, _ = setup
    actor = ActorSnapshot(actor_id="u", user_name="u", device_id="d", device_name="d", source=source, project_id="p", access_level="edit")
    with actor_context(actor):
        async with AsyncClient(transport=ASGITransport(app), base_url="http://test") as client:
            assert (await client.get("/api/digital-person")).status_code == 403
            assert (await client.put("/api/digital-person", json={})).status_code == 403
            assert (await client.get("/api/digital-person/voice-wake")).status_code == 403
            assert (await client.put("/api/digital-person/voice-wake", json={})).status_code == 403


def test_person_prompt_only_in_fixed_workspace_and_when_enabled(setup, monkeypatch):
    from services import customization_workspace
    from services.digital_person import DigitalPersonProfile
    _, service = setup
    monkeypatch.setattr(customization_workspace, "is_default_workspace", lambda p: p.id == "home")
    home, other = SimpleNamespace(id="home"), SimpleNamespace(id="other")
    profile = DigitalPersonProfile(enabled=True, name="小研", duties="复查证据", personality="直接")
    service.save_profile(profile)
    assert "复查证据" in service.prompt_for_project(home)
    assert service.prompt_for_project(other) == ""
    service.save_profile(profile.model_copy(update={"enabled": False}))
    assert service.prompt_for_project(home) == ""


async def test_identity_reaches_engine_changes_on_resume_and_does_not_pollute_settings(chat_module, monkeypatch):
    from tests.test_chat_role_binding import install_engine, send
    from services.digital_person import DigitalPersonProfile, save_profile
    from services import customization_workspace
    module, _, _, project, store = chat_module
    monkeypatch.setattr('services.digital_person.config_store', store)
    monkeypatch.setattr(customization_workspace, "is_default_workspace", lambda p: p.id == project.id)
    save_profile(DigitalPersonProfile(enabled=True, name="小研", duties="IDENTITY ORIGINAL"))
    sid = module.create_session(project.id)['id']
    calls, _ = install_engine(module, monkeypatch)
    assert await send(module, project, sid, 'first') == 'completed'
    assert 'IDENTITY ORIGINAL' in calls[-1]
    assert module.get_system_prompt(project.id) == ''
    save_profile(DigitalPersonProfile(enabled=True, duties="IDENTITY UPDATED"))
    assert await send(module, project, sid, 'changed') == 'completed'
    assert 'IDENTITY UPDATED' in calls[-1] and 'IDENTITY ORIGINAL' not in calls[-1]
    save_profile(DigitalPersonProfile(enabled=False))
    assert await send(module, project, sid, 'off') == 'completed'
    assert '模式已关闭' in calls[-1] and 'IDENTITY UPDATED' not in calls[-1]


async def test_host_config_is_independent_of_retired_install_capability(setup, monkeypatch):
    import main
    from services.gateway_client.policy import ManagedPolicyCache
    from services.remote_access import ActorSnapshot, actor_context
    app, _ = setup
    monkeypatch.setattr(main, 'gateway_client', SimpleNamespace(managed_config=object(), policy_cache=ManagedPolicyCache()))
    with actor_context(ActorSnapshot('u', 'user', 'd', 'device', 'managed')):
        async with AsyncClient(transport=ASGITransport(app), base_url='http://test') as client:
            response = await client.get('/api/digital-person')
            assert response.status_code == 200
            assert (await client.put('/api/digital-person', json=response.json())).status_code == 200


async def test_voice_wake_draft_persists_without_claiming_listener(setup):
    app, service = setup
    async with AsyncClient(transport=ASGITransport(app), base_url='http://test') as client:
        response = await client.get('/api/digital-person/voice-wake')
        assert response.status_code == 200
        assert response.json()['listening'] is False
        response = await client.put('/api/digital-person/voice-wake', json={'keyword':'你好小舟','sensitivity':'high'})
        assert response.status_code == 200
        service.config_store._cache = None
        result = (await client.get('/api/digital-person/voice-wake')).json()
        assert result['keyword'] == '你好小舟'
        assert result['available'] is False and result['listening'] is False
        for payload in ({'keyword':' '}, {'sensitivity':'invalid'}, {'enabled':True}):
            assert (await client.put('/api/digital-person/voice-wake', json=payload)).status_code == 422
