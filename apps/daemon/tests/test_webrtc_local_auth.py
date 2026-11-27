"""The signaling operator's ticket must not grant access without the host secret."""

import asyncio
import json

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient


@pytest.mark.asyncio
async def test_gateway_ticket_cannot_unlock_bridge_without_local_pair_key():
    from services.webrtc_p2p.bridge import WebRtcDataBridge

    messages = []
    requests = []

    async def app(scope, receive, send):
        requests.append(scope)

    async def send_text(text):
        messages.append(json.loads(text))

    async def send_bytes(_data):
        pass

    async def verify(key):
        return key == "host-only-secret-1234567890-abcdef"

    bridge = WebRtcDataBridge(
        app=app, device_id="dev-1", expected_ticket="gateway-issued-ticket",
        candidate_info={}, send_text=send_text, send_bytes=send_bytes,
        verify_pair_key=verify,
    )
    try:
        for key in (None, "wrong-secret"):
            await bridge.handle_text(json.dumps({
                "type": "p2p.auth", "ticket": "gateway-issued-ticket", "pair_key": key,
            }))
            assert messages[-1]["type"] == "p2p.error"
            await bridge.handle_text(json.dumps({
                "type": "http.request", "stream_id": "before-auth",
                "payload": {"phase": "start", "method": "GET", "path": "/api/project/list"},
            }))
            await asyncio.sleep(0)
            assert requests == []
        await bridge.handle_text(json.dumps({
            "type": "p2p.auth", "ticket": "gateway-issued-ticket", "pair_key": "host-only-secret-1234567890-abcdef",
        }))
        assert messages[-1]["type"] == "p2p.ready"
    finally:
        await bridge.close()


@pytest.mark.asyncio
async def test_lan_and_forwarded_loopback_cannot_read_or_rotate_host_secret(tmp_path):
    from api.webrtc_p2p import router
    from services.webrtc_p2p.client import WebRtcClientService
    from tests.test_webrtc_p2p_settings import _InMemoryConfigStore

    app = FastAPI()
    app.include_router(router)
    app.state.webrtc_client = WebRtcClientService(
        config_store=_InMemoryConfigStore(), config_dir_provider=lambda: tmp_path,
    )
    transport = ASGITransport(app=app, client=("192.168.1.20", 12345))
    async with AsyncClient(transport=transport, base_url="http://127.0.0.1:8765") as client:
        headers = {"X-Forwarded-For": "127.0.0.1", "Origin": "http://127.0.0.1:8765"}
        assert (await client.get("/api/webrtc-p2p/settings", headers=headers)).status_code == 403
        assert (await client.post("/api/webrtc-p2p/rotate-key", headers=headers)).status_code == 403


@pytest.mark.asyncio
async def test_local_verification_is_off_loop_and_rotation_disconnects_old_sessions(tmp_path):
    from types import SimpleNamespace
    from services.webrtc_p2p.client import WebRtcClientService
    from tests.test_webrtc_p2p_settings import _InMemoryConfigStore

    store = _InMemoryConfigStore()
    service = WebRtcClientService(config_store=store, config_dir_provider=lambda: tmp_path)
    settings = await service.get_settings()
    store.sleep_on_get = 0.2
    pending = asyncio.create_task(service.verify_remote_pair_key(settings["pair_key"]))
    assert await asyncio.to_thread(store.entered_io.wait, 1)
    await asyncio.sleep(0.01)
    assert not pending.done()
    assert await pending is True
    store.sleep_on_get = 0
    closed = []

    async def close():
        closed.append(True)

    service._sessions["old-session"] = SimpleNamespace(close=close)
    rotated = await service.rotate_pair_key()
    assert closed == [True]
    assert service._sessions == {}
    assert await service.verify_remote_pair_key(settings["pair_key"]) is False
    assert await service.verify_remote_pair_key(rotated["pair_key"]) is True
