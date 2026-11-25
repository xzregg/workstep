"""Agent voice selection shares persisted settings and real synthesis sessions."""
import asyncio
import threading

import httpx
import pytest
from fastapi import FastAPI

from api import digital_person
from cli import build_parser, dispatch
from services.speech_output import SpeechOutputService
from services.tool_registry import WorkstepClient


@pytest.fixture
def environment(tmp_path, monkeypatch):
    service = SpeechOutputService(tmp_path)
    monkeypatch.setattr(digital_person, "speech_service", service)
    monkeypatch.setattr(service.resources, "installed", lambda model: model == "moss-nano")
    monkeypatch.setattr(service.resources, "platform_error", lambda model: "")
    monkeypatch.setattr(service.resources, "runtime_error", lambda model: "")
    app = FastAPI()
    app.include_router(digital_person.router)
    @app.get("/health")
    async def health():
        return {"ok": True}
    return service, app


async def test_cli_selects_available_voice_and_next_playback_uses_it(environment, monkeypatch):
    import main
    from streaming.bus import EventBus
    service, app = environment
    bus = EventBus()
    monkeypatch.setattr(main, 'event_bus', bus)
    queue = bus.subscribe()
    client = WorkstepClient(transport=httpx.ASGITransport(app=app))
    listed = await dispatch(build_parser().parse_args(["digital-hub", "voice", "list", "--json"]), client)
    assert listed["mode"] == "system"
    model = next(row for row in listed["models"] if row["id"] == "moss-nano")
    assert model["available"]
    assert "Junhao" in {row["id"] for row in model["voices"]}
    assert "reference" not in {row["id"] for row in model["voices"]}
    result = await dispatch(build_parser().parse_args([
        "digital-hub", "voice", "set", "--model", "moss-nano", "--voice", "Junhao", "--json"]), client)
    assert result["voice"] == "Junhao"
    assert queue.get_nowait() == {"type": "CUSTOM", "name": "workstep.speech_output_changed", "value": {}}
    assert (await SpeechOutputService(service.root).settings())["voice"] == "Junhao"
    async def audio(settings, text):
        assert settings["voice"] == "Junhao"
        yield {"audio": "AAA=", "format": "pcm", "sample_rate": 24000}
    monkeypatch.setattr(service, "_audio", audio)
    sid = (await service.start("p", "local", "你好"))["id"]
    assert (await service.next(sid, "p", "local"))["audio"]
    await service.cancel(sid, "p", "local")
    await service.close()


def test_voice_change_subscription_is_host_only():
    from streaming.ws import WsSubscription, _make_subscription_predicate
    event = {"type": "CUSTOM", "name": "workstep.speech_output_changed", "value": {}}
    assert _make_subscription_predicate(WsSubscription(active=True, selected_project_id='p'))(event)
    assert not _make_subscription_predicate(WsSubscription(active=True, project_id='p'))(event)


async def test_omni_persona_requires_design_runtime(environment, monkeypatch):
    service, _ = environment
    monkeypatch.setattr(service.resources, 'installed', lambda model: True)
    monkeypatch.setattr(service.resources, 'omni_design_ready', lambda: False)
    model = next(row for row in (await service.voice_options())['models'] if row['id'] == 'omnivoice')
    assert not model['available'] and not model['voices']
    with pytest.raises(ValueError):
        await service.select_voice('persona', 'omnivoice')


async def test_invalid_uninstalled_and_busy_selection_does_not_write(environment):
    service, app = environment
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        for body in ({"model_id": "moss-nano", "voice": "invented"},
                     {"model_id": "cosyvoice3", "voice": "default"},
                     {"model_id": "moss-nano", "voice": "reference"},
                     {"voice": "Junhao"}):
            assert (await client.put("/api/digital-person/voice", json=body)).status_code == 409
        service.sessions["busy"] = {"preview": False, "project": "p", "owner": "local"}
        assert (await client.put("/api/digital-person/voice", json={"model_id": "moss-nano", "voice": "Junhao"})).status_code == 409
        service.sessions.clear()
    assert (await service.settings())["mode"] == "system"
    assert not (service.root / "settings.json").exists()


async def test_selection_preserves_other_settings_and_connection_secrets(environment):
    import json
    service, _ = environment
    await service.configure(dict(mode='cloud', provider='qwen', api_key='private-test-key', rate=1.3, volume=.4))
    result = await service.select_voice('Junhao', 'moss-nano')
    assert result['rate'] == 1.3 and result['volume'] == .4
    assert 'private-test-key' not in json.dumps(await service.voice_options())
    await service.select_voice('Yuewen')
    reloaded = SpeechOutputService(service.root)
    assert (await reloaded.settings())['voice'] == 'Yuewen'
    assert (await reloaded.resolve(dict(mode='cloud', provider='qwen', api_key=None)))['api_key'] == 'private-test-key'
    assert 'private-test-key' not in (service.root / 'settings.json').read_text()


@pytest.mark.parametrize("policy", ["missing", "denied"])
async def test_host_allowed_and_project_actor_denied(environment, monkeypatch, policy):
    import main
    from types import SimpleNamespace
    from services.gateway_client.policy import ManagedPolicyCache, verify_policy_snapshot
    from services.remote_access import ActorSnapshot, actor_context
    from tests.test_gateway_policy import _signed_policy
    _, app = environment
    cache = ManagedPolicyCache()
    if policy == "denied":
        token, pem, fingerprint = _signed_policy(engine_install=False, allow_local_providers=False)
        cache.apply(verify_policy_snapshot(token, pem, fingerprint, "gateway-test", "device-1", "user-1"))
    monkeypatch.setattr(main, "gateway_client", SimpleNamespace(managed_config=object(), policy_cache=cache))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        for project in (None, "p"):
            with actor_context(ActorSnapshot("user-1", "Alice", "device-1", "PC", "managed", project_id=project)):
                assert (await client.get("/api/digital-person/voice")).status_code == (200 if project is None else 403)
                response = await client.put("/api/digital-person/voice", json={"model_id": "moss-nano", "voice": "Junhao"})
                assert response.status_code == (200 if project is None else 403)


async def test_slow_selection_save_keeps_health_responsive(environment, monkeypatch):
    service, app = environment
    entered, release = threading.Event(), threading.Event()
    original = service._save
    def slow(settings):
        entered.set()
        assert release.wait(3)
        original(settings)
    monkeypatch.setattr(service, "_save", slow)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        job = asyncio.create_task(client.put("/api/digital-person/voice", json={"model_id": "moss-nano", "voice": "Junhao"}))
        try:
            assert await asyncio.to_thread(entered.wait, 2)
            assert (await asyncio.wait_for(client.get("/health"), .3)).status_code == 200
        finally:
            release.set()
        assert (await job).status_code == 200
