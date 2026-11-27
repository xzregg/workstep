"""Tests for WebRTC P2P settings API, pairing key rotation, and non-blocking health canary."""

from __future__ import annotations

import asyncio
import threading
import time
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient


class _InMemoryConfigStore:
    def __init__(self, *, sleep_on_set: float = 0.0, sleep_on_get: float = 0.0):
        self.data: dict = {
            "device": {"device_id": "dev-host-001", "device_name": "Host Mac"},
        }
        self.sleep_on_set = sleep_on_set
        self.sleep_on_get = sleep_on_get
        self.entered_io = threading.Event()

    def get(self, key: str, default=None):
        if self.sleep_on_get and key == "webrtc_p2p":
            self.entered_io.set()
            time.sleep(self.sleep_on_get)
        return self.data.get(key, default)

    def set(self, key: str, value):
        if self.sleep_on_set and key == "webrtc_p2p":
            self.entered_io.set()
            time.sleep(self.sleep_on_set)
        self.data[key] = value

    def get_device_identity(self):
        return dict(self.data["device"])


@pytest.mark.asyncio
async def test_webrtc_p2p_settings_crud_and_key_rotation(tmp_path, monkeypatch):
    from api.webrtc_p2p import router
    from services import config as config_module
    from services.webrtc_p2p.client import WebRtcClientService

    store = _InMemoryConfigStore()
    monkeypatch.setattr(config_module, "CONFIG_DIR", tmp_path)
    service = WebRtcClientService(config_store=store, config_dir_provider=lambda: tmp_path)
    app = FastAPI()
    app.include_router(router)
    app.state.webrtc_client = service
    app.state.gateway_client = None

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://127.0.0.1:8765") as client:
        res = await client.get("/api/webrtc-p2p/settings")
        assert res.status_code == 200
        body = res.json()
        assert body["device_id"] == "dev-host-001"
        assert body["device_name"] == "Host Mac"
        assert body["enabled"] is False
        assert body["pair_key"]  # auto-generated on first access
        initial_key = body["pair_key"]

        # Reject invalid signal URL
        bad = await client.put(
            "/api/webrtc-p2p/settings",
            headers={"Origin": "http://127.0.0.1:8765"},
            json={"enabled": True, "signal_url": "ftp://invalid.example"},
        )
        assert bad.status_code == 400

        # Reject non-loopback plain HTTP signal URL (requires HTTPS or private network)
        bad_public_http = await client.put(
            "/api/webrtc-p2p/settings",
            headers={"Origin": "http://127.0.0.1:8765"},
            json={"enabled": True, "signal_url": "http://8.8.8.8:8780"},
        )
        assert bad_public_http.status_code == 400

        saved = await client.put(
            "/api/webrtc-p2p/settings",
            headers={"Origin": "http://127.0.0.1:8765"},
            json={"enabled": True, "signal_url": "https://signal.example.com:8780"},
        )
        assert saved.status_code == 200
        saved_json = saved.json()
        assert saved_json["enabled"] is True
        assert saved_json["signal_url"] == "https://signal.example.com:8780"
        assert saved_json["p2p_url"] == "https://signal.example.com:8780/p2p/dev-host-001/"

        rotated = await client.post(
            "/api/webrtc-p2p/rotate-key",
            headers={"Origin": "http://127.0.0.1:8765"},
        )
        assert rotated.status_code == 200
        new_key = rotated.json()["pair_key"]
        assert new_key and new_key != initial_key
        assert service.verify_pair_key(new_key) is True
        assert service.verify_pair_key(initial_key) is False


@pytest.mark.asyncio
async def test_webrtc_p2p_settings_blocks_project_scoped_and_remote_webrtc_visitors(tmp_path):
    from api.webrtc_p2p import router
    from services.webrtc_p2p.client import WebRtcClientService

    store = _InMemoryConfigStore()
    service = WebRtcClientService(config_store=store, config_dir_provider=lambda: tmp_path)
    app = FastAPI()

    @app.middleware("http")
    async def inject_remote(request, call_next):
        mode = request.headers.get("x-test-actor")
        if mode == "project":
            request.scope["gateway_remote_actor"] = SimpleNamespace(
                user_id="u1", username="u1", device_id="dev-1", project_id="proj-1",
            )
        elif mode == "webrtc":
            request.scope["webrtc_remote_actor"] = SimpleNamespace(
                user_id="p2p-1", username="p2p-1", device_id="dev-1", project_id=None,
            )
        return await call_next(request)

    app.include_router(router)
    app.state.webrtc_client = service
    app.state.gateway_client = None

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://127.0.0.1:8765") as client:
        for actor_mode in ("project", "webrtc"):
            assert (
                await client.get("/api/webrtc-p2p/settings", headers={"x-test-actor": actor_mode})
            ).status_code == 403
            assert (
                await client.put(
                    "/api/webrtc-p2p/settings",
                    headers={"Origin": "http://127.0.0.1:8765", "x-test-actor": actor_mode},
                    json={"enabled": True, "signal_url": "http://127.0.0.1:8780"},
                )
            ).status_code == 403
            assert (
                await client.post(
                    "/api/webrtc-p2p/rotate-key",
                    headers={"Origin": "http://127.0.0.1:8765", "x-test-actor": actor_mode},
                )
            ).status_code == 403


@pytest.mark.asyncio
async def test_webrtc_p2p_settings_slow_disk_does_not_block_health(tmp_path):
    from api.webrtc_p2p import router
    from services.webrtc_p2p.client import WebRtcClientService

    store = _InMemoryConfigStore(sleep_on_set=0.45)
    service = WebRtcClientService(config_store=store, config_dir_provider=lambda: tmp_path)
    app = FastAPI()
    app.include_router(router)
    app.state.webrtc_client = service
    app.state.gateway_client = None

    @app.get("/api/health")
    async def health():
        return {"status": "ok"}

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://127.0.0.1:8765") as client:
        pending = asyncio.create_task(
            client.put(
                "/api/webrtc-p2p/settings",
                headers={"Origin": "http://127.0.0.1:8765"},
                json={"enabled": True, "signal_url": "http://127.0.0.1:8780"},
            )
        )
        assert await asyncio.to_thread(store.entered_io.wait, 2.0)
        started = time.monotonic()
        health_res = await client.get("/api/health")
        elapsed = time.monotonic() - started
        assert health_res.status_code == 200
        assert elapsed < 0.15
        assert (await pending).status_code == 200


@pytest.mark.asyncio
async def test_webrtc_client_attaches_gateway_binding_signature_when_authorized(tmp_path, monkeypatch):
    import base64
    import hashlib
    import json
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from services.webrtc_p2p.client import GATEWAY_BIND_PREFIX, WebRtcClientService

    gateway_key = Ed25519PrivateKey.generate()
    gateway_pem = gateway_key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode("ascii")
    gw_id = "gw-main"
    gw_fp = "fp-gw-123"
    ident_dir = tmp_path / "gateway-identities"
    ident_dir.mkdir(parents=True)
    platform_name = "platform-" + hashlib.sha256(f"{gw_id}:{gw_fp}".encode()).hexdigest() + ".json"
    (ident_dir / platform_name).write_text(json.dumps({"app_instance_id": "inst-1", "private_key": gateway_pem}))

    captured: list[dict] = []

    class _FakeWs:
        def __init__(self, with_gateway_check: bool):
            self._step = 0
            self._with_gateway_check = with_gateway_check

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def recv(self):
            if self._step == 0:
                self._step = 1
                return json.dumps({"type": "challenge", "nonce": "nonce-test-123"})
            if self._step == 1:
                self._step = 2
                return json.dumps({"type": "registered", "device_id": "dev-host-001"})
            await asyncio.sleep(0.05)
            raise asyncio.CancelledError()

        async def send(self, text: str):
            data = json.loads(text)
            if data.get("type") == "register":
                captured.append(data)

    def _connector(*_args, **_kwargs):
        return _FakeWs(True)

    # 1) Unbound / not authorized in gateway_platform -> no gateway binding attached.
    store = _InMemoryConfigStore()
    store.data["webrtc_p2p"] = {
        "enabled": True,
        "signal_url": "https://signal.example.com",
        "pair_key": "k1",
        "pair_key_salt": "s1",
        "pair_key_verifier": "a" * 64,
    }
    svc = WebRtcClientService(config_store=store, config_dir_provider=lambda: tmp_path, connector=_connector)
    async def _fast_stun(*_a, **_kw):
        return ["stun:127.0.0.1:3478"]
    monkeypatch.setattr(svc, "_fetch_stun_urls", _fast_stun)
    task = asyncio.create_task(svc._run_loop("https://signal.example.com"))
    for _ in range(40):
        if len(captured) >= 1:
            break
        await asyncio.sleep(0.01)
    await svc.close()
    try:
        await task
    except asyncio.CancelledError:
        pass
    assert len(captured) == 1
    assert "gateway_public_key_pem" not in captured[0]

    # 2) Authorized in gateway_platform -> gateway binding signature attached & verifiable.
    captured.clear()
    store.data["gateway_platform"] = {
        "url": "https://gw.example.com",
        "gateway_id": gw_id,
        "fingerprint": gw_fp,
        "enabled": True,
        "authorized": True,
    }
    svc2 = WebRtcClientService(config_store=store, config_dir_provider=lambda: tmp_path, connector=_connector)
    monkeypatch.setattr(svc2, "_fetch_stun_urls", _fast_stun)
    task2 = asyncio.create_task(svc2._run_loop("https://gw.example.com"))
    for _ in range(40):
        if len(captured) >= 1:
            break
        await asyncio.sleep(0.01)
    await svc2.close()
    try:
        await task2
    except asyncio.CancelledError:
        pass
    assert len(captured) == 1
    reg = captured[0]
    assert reg["gateway_public_key_pem"].startswith("-----BEGIN PUBLIC KEY-----")
    webrtc_pub = serialization.load_pem_public_key(reg["public_key_pem"].encode("ascii"))
    webrtc_fp = hashlib.sha256(
        webrtc_pub.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    ).hexdigest()
    expected_msg = f"{GATEWAY_BIND_PREFIX}:nonce-test-123:dev-host-001:{webrtc_fp}".encode("utf-8")
    sig_b64 = reg["gateway_binding_signature"]
    sig_bytes = base64.urlsafe_b64decode(sig_b64 + "=" * (-len(sig_b64) % 4))
    gateway_key.public_key().verify(sig_bytes, expected_msg)


@pytest.mark.asyncio
async def test_webrtc_client_reconnects_on_dead_signaling_and_uses_live_offer_stun_urls(tmp_path, monkeypatch):
    import json
    from services.webrtc_p2p import client as client_mod
    from services.webrtc_p2p.client import WebRtcClientService

    connections = 0
    captured_stun_lists: list[list[str]] = []

    class _FakePeer:
        def __init__(self, *, stun_urls, **_kwargs):
            captured_stun_lists.append(list(stun_urls))

        async def accept_offer(self, _sdp: str) -> str:
            return "v=0\r\n"

        async def close(self) -> None:
            return None

    monkeypatch.setattr(client_mod, "WebRtcPeerSession", _FakePeer)

    class _FakeWs:
        def __init__(self, idx: int):
            self.idx = idx
            self._step = 0
            self._closed_evt = asyncio.Event()
            self.sent: list[dict] = []

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def recv(self):
            if self._step == 0:
                self._step = 1
                return json.dumps({"type": "challenge", "nonce": f"nonce-{self.idx}"})
            if self._step == 1:
                self._step = 2
                return json.dumps({"type": "registered", "device_id": "dev-host-001"})
            if self.idx == 1:
                # Simulate silent LAN IP change: socket never delivers pong or EOF until heartbeat closes it.
                await self._closed_evt.wait()
                raise ConnectionError("closed after heartbeat timeout")
            if self._step == 2:
                self._step = 3
                return json.dumps({
                    "type": "offer",
                    "session_id": "sess-live-1",
                    "p2p_ticket": "ticket-1",
                    "sdp": "v=0\r\n",
                    "stun_urls": ["stun:stun.miwifi.com:3478", "stun:stun.cloudflare.com:3478"],
                })
            await self._closed_evt.wait()
            raise asyncio.CancelledError()

        async def send(self, text: str):
            self.sent.append(json.loads(text))

        async def close(self):
            self._closed_evt.set()

    def _connector(*_args, **_kwargs):
        nonlocal connections
        connections += 1
        return _FakeWs(connections)

    store = _InMemoryConfigStore()
    store.data["webrtc_p2p"] = {
        "enabled": True,
        "signal_url": "https://signal.example.com",
        "pair_key": "k1",
        "pair_key_salt": "s1",
        "pair_key_verifier": "a" * 64,
    }
    svc = WebRtcClientService(config_store=store, config_dir_provider=lambda: tmp_path, connector=_connector)
    svc.heartbeat_interval = 0.03
    svc.heartbeat_timeout = 0.09

    async def _fast_stun(*_a, **_kw):
        return ["stun:127.0.0.1:3478"]

    monkeypatch.setattr(svc, "_fetch_stun_urls", _fast_stun)

    task = asyncio.create_task(svc._run_loop("https://signal.example.com"))
    svc._task = task
    try:
        for _ in range(150):
            if connections >= 2 and captured_stun_lists:
                break
            await asyncio.sleep(0.02)
        assert connections >= 2
        assert captured_stun_lists == [["stun:stun.miwifi.com:3478", "stun:stun.cloudflare.com:3478"]]
    finally:
        await svc.close()
        if not task.done():
            task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
