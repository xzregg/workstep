"""Tests for the reusable database-free WebRTC signaling hub and FastAPI router."""

from __future__ import annotations

import base64
import hashlib
import secrets

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi import FastAPI
from fastapi.testclient import TestClient

from workstep_webrtc_signal import SignalingHub, create_webrtc_router


def _device_credentials(pair_key: str = "secret-pair-key-123"):
    private_key = Ed25519PrivateKey.generate()
    public_pem = private_key.public_key().public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode("ascii")
    salt = secrets.token_hex(16)
    verifier = hashlib.sha256(f"{salt}:{pair_key}".encode("utf-8")).hexdigest()
    return private_key, public_pem, salt, verifier


def _sign_registration(private_key: Ed25519PrivateKey, nonce: str, device_id: str, verifier: str) -> str:
    payload = f"workstep-webrtc-device-v1:{nonce}:{device_id}:{verifier}".encode("utf-8")
    return base64.urlsafe_b64encode(private_key.sign(payload)).rstrip(b"=").decode("ascii")


def _make_app(*, authorizer=None):
    hub = SignalingHub()
    app = FastAPI()
    app.include_router(
        create_webrtc_router(
            hub,
            stun_urls_provider=lambda _req: ["stun:127.0.0.1:3478"],
            authorizer=authorizer,
        )
    )
    return app, hub


def test_device_ed25519_registration_pairing_and_direct_only_signaling():
    app, _hub = _make_app()
    private_key, public_pem, salt, verifier = _device_credentials()

    with TestClient(app) as client:
        with client.websocket_connect("/ws/webrtc/device") as device_ws:
            challenge = device_ws.receive_json()
            assert challenge["type"] == "challenge"
            nonce = challenge["nonce"]

            # Bad signature must fail registration.
            with client.websocket_connect("/ws/webrtc/device") as bad_ws:
                bad_challenge = bad_ws.receive_json()
                bad_ws.send_json({
                    "type": "register",
                    "device_id": "dev-1",
                    "device_name": "Lab Mac",
                    "public_key_pem": public_pem,
                    "signature": "invalid-sig",
                    "pair_key_salt": salt,
                    "pair_key_verifier": verifier,
                })
                err_frame = bad_ws.receive_json()
                assert err_frame["type"] == "error"
                assert err_frame["code"] == "invalid_signature"
                closed = bad_ws.receive()
                assert closed["type"] == "websocket.close"

            device_ws.send_json({
                "type": "register",
                "device_id": "dev-1",
                "device_name": "Lab Mac",
                "public_key_pem": public_pem,
                "signature": _sign_registration(private_key, nonce, "dev-1", verifier),
                "pair_key_salt": salt,
                "pair_key_verifier": verifier,
            })
            ack = device_ws.receive_json()
            assert ack["type"] == "registered"
            assert ack["device_id"] == "dev-1"

            cfg = client.get("/api/webrtc/config", params={"device_id": "dev-1"})
            assert cfg.status_code == 200
            assert cfg.json() == {
                "online": True,
                "device_id": "dev-1",
                "device_name": "Lab Mac",
                "stun_urls": ["stun:127.0.0.1:3478"],
                "direct_only": True,
                "pair_key_salt": salt,
                "session_authorized": False,
            }

            # Wrong pair key fails; correct key mints session & ticket.
            bad_pair = client.post("/api/webrtc/pair", json={"device_id": "dev-1", "pair_proof": "0" * 64})
            assert bad_pair.status_code == 403

            pair = client.post("/api/webrtc/pair", json={"device_id": "dev-1", "pair_proof": verifier})
            assert pair.status_code == 200
            pair_data = pair.json()
            assert pair_data["device_name"] == "Lab Mac"
            assert pair_data["p2p_ticket"]
            assert pair_data["direct_only"] is True
            assert pair_data["stun_urls"] == ["stun:127.0.0.1:3478"]

            with client.websocket_connect(
                f"/ws/webrtc/client?device_id=dev-1&token={pair_data['session_token']}"
            ) as peer_ws:
                ready = peer_ws.receive_json()
                assert ready["type"] == "client_ready"

                # Relay candidate must be rejected in direct-only mode.
                peer_ws.send_json({
                    "type": "ice_candidate",
                    "candidate": "candidate:1 1 udp 16777295 203.0.113.2 50000 typ relay raddr 10.0.0.1 rport 50000",
                    "sdpMid": "0",
                    "sdpMLineIndex": 0,
                })
                err = peer_ws.receive_json()
                assert err["type"] == "error"
                assert err["code"] == "relay_not_allowed"

                # Relay candidate inside SDP must also be rejected.
                peer_ws.send_json({
                    "type": "offer",
                    "sdp": "v=0\r\na=candidate:1 1 udp 100 1.2.3.4 9000 typ relay\r\n",
                })
                err2 = peer_ws.receive_json()
                assert err2["type"] == "error"
                assert err2["code"] == "relay_not_allowed"

                # Non-relay offer/answer/ice_candidate pass between peer and device.
                peer_ws.send_json({
                    "type": "offer",
                    "sdp": "v=0\r\na=candidate:1 1 udp 2122260223 192.168.1.10 50000 typ host\r\n",
                })
                forwarded_offer = device_ws.receive_json()
                assert forwarded_offer["type"] == "offer"
                assert forwarded_offer["session_id"] == pair_data["session_id"]
                assert forwarded_offer["p2p_ticket"] == pair_data["p2p_ticket"]

                device_ws.send_json({
                    "type": "answer",
                    "session_id": pair_data["session_id"],
                    "sdp": "v=0\r\na=candidate:2 1 udp 1686052607 198.51.100.2 40000 typ srflx\r\n",
                })
                forwarded_answer = peer_ws.receive_json()
                assert forwarded_answer["type"] == "answer"
                assert "typ srflx" in forwarded_answer["sdp"]


def test_pairing_rate_limit_and_custom_authorizer_hook():
    def deny_user(request, device_id):
        if request.headers.get("x-test-user") != "alice":
            return False, "Custom authorizer denied"
        return True, None

    app, _ = _make_app(authorizer=deny_user)
    private_key, public_pem, salt, verifier = _device_credentials()

    with TestClient(app) as client:
        with client.websocket_connect("/ws/webrtc/device") as device_ws:
            nonce = device_ws.receive_json()["nonce"]
            device_ws.send_json({
                "type": "register",
                "device_id": "dev-2",
                "device_name": "Studio",
                "public_key_pem": public_pem,
                "signature": _sign_registration(private_key, nonce, "dev-2", verifier),
                "pair_key_salt": salt,
                "pair_key_verifier": verifier,
            })
            assert device_ws.receive_json()["type"] == "registered"

            denied = client.post("/api/webrtc/pair", json={"device_id": "dev-2", "pair_proof": verifier})
            assert denied.status_code == 403

            allowed = client.post(
                "/api/webrtc/pair",
                headers={"x-test-user": "alice"},
                json={"device_id": "dev-2", "pair_proof": verifier},
            )
            assert allowed.status_code == 200
            assert allowed.json()["session_token"]


def _sign_gateway_binding(
    gw_private_key: Ed25519PrivateKey,
    nonce: str,
    device_id: str,
    webrtc_public_pem: str,
) -> tuple[str, str]:
    webrtc_key = serialization.load_pem_public_key(webrtc_public_pem.encode("ascii"))
    webrtc_fp = hashlib.sha256(
        webrtc_key.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    ).hexdigest()
    payload = f"workstep-webrtc-gateway-bind-v1:{nonce}:{device_id}:{webrtc_fp}".encode("utf-8")
    sig = base64.urlsafe_b64encode(gw_private_key.sign(payload)).rstrip(b"=").decode("ascii")
    gw_pem = gw_private_key.public_key().public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode("ascii")
    return gw_pem, sig


def test_gateway_binding_snapshot_never_grants_passwordless_access():
    app, hub = _make_app()
    private_key, public_pem, salt, verifier = _device_credentials()
    gw_key = Ed25519PrivateKey.generate()

    with TestClient(app) as client:
        # Bad gateway binding signature must be rejected.
        with client.websocket_connect("/ws/webrtc/device") as bad_ws:
            nonce = bad_ws.receive_json()["nonce"]
            gw_pem, _ = _sign_gateway_binding(gw_key, nonce, "dev-gw", public_pem)
            bad_ws.send_json({
                "type": "register",
                "device_id": "dev-gw",
                "device_name": "Gateway Box",
                "public_key_pem": public_pem,
                "signature": _sign_registration(private_key, nonce, "dev-gw", verifier),
                "pair_key_salt": salt,
                "pair_key_verifier": verifier,
                "gateway_public_key_pem": gw_pem,
                "gateway_binding_signature": "bad-gateway-sig",
            })
            err = bad_ws.receive_json()
            assert err["type"] == "error"
            assert err["code"] == "invalid_signature"

        # Valid gateway binding populates hub.list_devices() and hub.get_device().
        with client.websocket_connect("/ws/webrtc/device") as device_ws:
            nonce = device_ws.receive_json()["nonce"]
            gw_pem, gw_sig = _sign_gateway_binding(gw_key, nonce, "dev-gw", public_pem)
            expected_gw_fp = hashlib.sha256(
                gw_key.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
            ).hexdigest()
            device_ws.send_json({
                "type": "register",
                "device_id": "dev-gw",
                "device_name": "Gateway Box",
                "public_key_pem": public_pem,
                "signature": _sign_registration(private_key, nonce, "dev-gw", verifier),
                "pair_key_salt": salt,
                "pair_key_verifier": verifier,
                "gateway_public_key_pem": gw_pem,
                "gateway_binding_signature": gw_sig,
            })
            assert device_ws.receive_json()["type"] == "registered"

            dev = hub.get_device("dev-gw")
            assert dev is not None
            assert dev.gateway_key_fingerprint == expected_gw_fp
            listed = hub.list_devices()
            assert len(listed) == 1
            assert listed[0]["device_id"] == "dev-gw"
            assert listed[0]["device_name"] == "Gateway Box"
            assert listed[0]["gateway_key_fingerprint"] == expected_gw_fp
            assert listed[0]["online"] is True

            # Unauthenticated visitor cannot pair without pair_key.
            anon_cfg = client.get("/api/webrtc/config", params={"device_id": "dev-gw"}).json()
            assert anon_cfg["session_authorized"] is False
            anon_pair = client.post("/api/webrtc/pair", json={"device_id": "dev-gw", "pair_proof": ""})
            assert anon_pair.status_code == 403

            # A gateway session never bypasses the device secret.
            auth_headers = {"x-gateway-session": "allow:dev-gw"}
            auth_cfg = client.get("/api/webrtc/config", params={"device_id": "dev-gw"}, headers=auth_headers).json()
            assert auth_cfg["session_authorized"] is False
            auth_pair = client.post(
                "/api/webrtc/pair",
                headers=auth_headers,
                json={"device_id": "dev-gw", "pair_proof": ""},
            )
            assert auth_pair.status_code == 403


def test_normalize_stun_urls_and_live_signaling_forwarding():
    import pytest
    from workstep_gateway_protocol.webrtc import (
        DEFAULT_PUBLIC_STUN_URLS,
        normalize_stun_url,
        normalize_stun_urls,
    )

    assert DEFAULT_PUBLIC_STUN_URLS == (
        "stun:stun.miwifi.com:3478",
        "stun:stun.chat.bilibili.com:3478",
        "stun:stun.yy.com:3478",
        "stun:stun.cloudflare.com:3478",
        "stun:stun.l.google.com:19302",
    )

    assert normalize_stun_url("stun:stun.miwifi.com:3478") == "stun:stun.miwifi.com:3478"
    assert normalize_stun_url("stun.cloudflare.com:3478") == "stun:stun.cloudflare.com:3478"
    assert normalize_stun_url("stun.cloudflare.com") == "stun:stun.cloudflare.com:3478"
    assert normalize_stun_url("STUN:Stun.L.Google.com:19302") == "stun:stun.l.google.com:19302"
    assert normalize_stun_url("[2001:db8::1]:3478") == "stun:[2001:db8::1]:3478"
    assert normalize_stun_url("stun:[2001:db8::1]") == "stun:[2001:db8::1]:3478"

    assert normalize_stun_urls([
        "stun.miwifi.com:3478",
        "stun:stun.miwifi.com:3478",
        "stun:stun.chat.bilibili.com",
        "stun.l.google.com:19302",
    ]) == [
        "stun:stun.miwifi.com:3478",
        "stun:stun.chat.bilibili.com:3478",
        "stun:stun.l.google.com:19302",
    ]

    for bad in (
        "",
        "   ",
        "turn:turn.example.com:3478",
        "turns:turn.example.com:5349",
        "stuns:stun.example.com:5349",
        "http://stun.example.com:3478",
        "https://stun.example.com",
        "stun:user@stun.example.com:3478",
        "stun:stun.example.com/path",
        "stun:stun.example.com?transport=tcp",
        "stun:stun.example.com#frag",
        "stun:stun.example.com:0",
        "stun:stun.example.com:70000",
        "stun:-bad.example:3478",
        "stun:bad..example:3478",
        "stun:has space.example:3478",
    ):
        with pytest.raises(ValueError):
            normalize_stun_url(bad)

    with pytest.raises(ValueError):
        normalize_stun_urls([f"stun:s{i}.example.com:3478" for i in range(17)])

    hub = SignalingHub()
    dynamic_stun = ["stun:stun.miwifi.com:3478", "stun:stun.cloudflare.com:3478"]
    app = FastAPI()
    app.include_router(create_webrtc_router(hub, stun_urls_provider=lambda _req: list(dynamic_stun)))
    private_key, public_pem, salt, verifier = _device_credentials()

    with TestClient(app) as client:
        with client.websocket_connect("/ws/webrtc/device") as device_ws:
            nonce = device_ws.receive_json()["nonce"]
            device_ws.send_json({
                "type": "register",
                "device_id": "dev-multi-stun",
                "device_name": "MultiStunBox",
                "public_key_pem": public_pem,
                "signature": _sign_registration(private_key, nonce, "dev-multi-stun", verifier),
                "pair_key_salt": salt,
                "pair_key_verifier": verifier,
            })
            assert device_ws.receive_json()["type"] == "registered"

            pair_res = client.post(
                "/api/webrtc/pair",
                json={"device_id": "dev-multi-stun", "pair_proof": verifier},
            )
            assert pair_res.status_code == 200
            pair_data = pair_res.json()
            assert pair_data["stun_urls"] == dynamic_stun

            with client.websocket_connect(
                f"/ws/webrtc/client?device_id=dev-multi-stun&token={pair_data['session_token']}"
            ) as peer_ws:
                assert peer_ws.receive_json()["type"] == "client_ready"
                peer_ws.send_json({
                    "type": "offer",
                    "sdp": "v=0\r\na=candidate:1 1 udp 2122260223 192.168.1.10 50000 typ host\r\n",
                    "stun_urls": ["stun:evil.example:3478"],
                })
                forwarded = device_ws.receive_json()
                assert forwarded["type"] == "offer"
                assert forwarded["stun_urls"] == dynamic_stun
