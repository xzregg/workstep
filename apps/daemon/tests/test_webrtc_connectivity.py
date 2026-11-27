"""Single-host checks must prove STUN replies without promising peer connectivity."""

import asyncio
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient


@pytest.mark.asyncio
async def test_stun_probe_validates_responses_and_closes_sockets():
    from services.webrtc_p2p.connectivity import probe_stun
    from workstep_webrtc_signal.stun import StunServer

    server = StunServer(host="127.0.0.1", port=0)
    port = await server.start()
    try:
        assert await probe_stun([f"stun:127.0.0.1:{port}"], timeout=0.2) is True
    finally:
        await server.close()
    assert await probe_stun([f"stun:127.0.0.1:{port}"], timeout=0.05) is False
    assert await probe_stun([], timeout=0.05) is False


@pytest.mark.asyncio
async def test_stun_probe_rejects_unrelated_packets_and_does_not_block_health():
    from aioice import stun
    from services.webrtc_p2p.connectivity import probe_stun

    class Echo(asyncio.DatagramProtocol):
        def connection_made(self, transport):
            self.transport = transport

        def datagram_received(self, data, addr):
            self.transport.sendto(data, addr)  # A request echoed back is not a STUN response.
            request = stun.parse_message(data)
            wrong_transaction = stun.Message(stun.Method.BINDING, stun.Class.RESPONSE)
            wrong_transaction.attributes["XOR-MAPPED-ADDRESS"] = ("127.0.0.1", 12345)
            self.transport.sendto(bytes(wrong_transaction), addr)
            missing_mapping = stun.Message(
                stun.Method.BINDING, stun.Class.RESPONSE, transaction_id=request.transaction_id,
            )
            self.transport.sendto(bytes(missing_mapping), addr)

    transport, _ = await asyncio.get_running_loop().create_datagram_endpoint(
        Echo, local_addr=("127.0.0.1", 0),
    )
    port = transport.get_extra_info("sockname")[1]
    try:
        pending = asyncio.create_task(probe_stun([f"stun:127.0.0.1:{port}"], timeout=0.1))
        await asyncio.sleep(0.02)
        assert pending.done() is False
        assert await pending is False
    finally:
        transport.close()


@pytest.mark.asyncio
async def test_check_api_waits_for_registration_and_enforces_host_scope(tmp_path, monkeypatch):
    from api.webrtc_p2p import router
    from services.webrtc_p2p.client import WebRtcClientService
    from services.webrtc_p2p import client as client_module

    class Store:
        def __init__(self):
            self.data = {"webrtc_p2p": {"enabled": True, "signal_url": "https://signal.example.com"}}

        def get(self, key, default=None):
            return self.data.get(key, default)

        def set(self, key, value):
            self.data[key] = value

        def get_device_identity(self):
            return {"device_id": "dev-1", "device_name": "Host"}

    service = WebRtcClientService(config_store=Store(), config_dir_provider=lambda: tmp_path)
    probes = []

    async def probe(urls):
        probes.append(urls)
        await asyncio.sleep(0.05)
        return True

    monkeypatch.setattr(client_module, "probe_stun", probe)
    monkeypatch.setattr(client_module, "SIGNAL_CHECK_TIMEOUT", 0.05)
    app = FastAPI()
    app.state.webrtc_client = service

    @app.middleware("http")
    async def actor(request, call_next):
        if request.headers.get("x-project"):
            request.scope["gateway_remote_actor"] = SimpleNamespace(project_id="p1")
        return await call_next(request)

    @app.get("/api/health")
    async def health():
        return {"status": "ok"}

    app.include_router(router)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://127.0.0.1:8765") as client:
        assert (await client.post("/api/webrtc-p2p/check", headers={"x-project": "1"})).status_code == 403
        assert (await client.post("/api/webrtc-p2p/check", headers={"Origin": "https://other.example"})).status_code == 403
        offline = await client.post("/api/webrtc-p2p/check")
        assert offline.json() == {"signaling": False, "stun": None}
        assert probes == []

        service.online = True
        service._stun_urls = ["stun:127.0.0.1:3478"]
        service._signal_checked.set()
        pending = asyncio.create_task(client.post("/api/webrtc-p2p/check"))
        await asyncio.sleep(0.01)
        assert (await client.get("/api/health")).status_code == 200
        assert pending.done() is False
        assert (await pending).json() == {"signaling": True, "stun": True}
        assert probes == [["stun:127.0.0.1:3478"]]

        # Disabling WebRTC clears readiness and does not perform network checks.
        await service.update_settings(enabled=False, signal_url="https://signal.example.com")
        assert (await client.post("/api/webrtc-p2p/check")).json() == {"signaling": False, "stun": None}
        assert len(probes) == 1
