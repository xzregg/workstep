"""Integration tests for Gateway WebRTC signaling, UDP STUN, account auto-pair, and admin visibility."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import os
import secrets
import socket
import struct

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi.testclient import TestClient

from gateway.app import create_app
from gateway.config import GatewaySettings
from gateway.models import Device


def _ed25519_pair():
    priv = Ed25519PrivateKey.generate()
    der = priv.public_key().public_bytes(
        serialization.Encoding.DER,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    pem = priv.public_key().public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode("ascii")
    fp = hashlib.sha256(der).hexdigest()
    return priv, pem, fp


def _b64u(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _sign_webrtc_register(
    webrtc_priv: Ed25519PrivateKey,
    webrtc_pem: str,
    nonce: str,
    device_id: str,
    pair_key: str,
    gw_priv: Ed25519PrivateKey | None = None,
) -> dict:
    salt = secrets.token_hex(16)
    verifier = hashlib.sha256(f"{salt}:{pair_key}".encode("utf-8")).hexdigest()
    sig = _b64u(webrtc_priv.sign(f"workstep-webrtc-device-v1:{nonce}:{device_id}:{verifier}".encode("utf-8")))
    payload = {
        "type": "register",
        "device_id": device_id,
        "device_name": f"Device-{device_id}",
        "public_key_pem": webrtc_pem,
        "signature": sig,
        "pair_key_salt": salt,
        "pair_key_verifier": verifier,
    }
    if gw_priv is not None:
        webrtc_fp = hashlib.sha256(
            webrtc_priv.public_key().public_bytes(
                serialization.Encoding.DER,
                serialization.PublicFormat.SubjectPublicKeyInfo,
            )
        ).hexdigest()
        gw_pem = gw_priv.public_key().public_bytes(
            serialization.Encoding.PEM,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        ).decode("ascii")
        gw_sig = _b64u(
            gw_priv.sign(f"workstep-webrtc-gateway-bind-v1:{nonce}:{device_id}:{webrtc_fp}".encode("utf-8"))
        )
        payload["gateway_public_key_pem"] = gw_pem
        payload["gateway_binding_signature"] = gw_sig
    return payload


def _setup_owner_and_member(client: TestClient):
    setup = client.post(
        "/api/platform/setup",
        json={
            "username": "owner",
            "display_name": "Owner",
            "password": "OwnerPassphrase-2026!",
            "recovery_username": "recovery",
            "recovery_password": "RecoveryPassphrase-2026!",
            "registration_mode": "open",
        },
    )
    assert setup.status_code == 201, setup.text
    owner_csrf = setup.json()["csrf_token"]

    alice = client.post(
        "/api/auth/register",
        json={"username": "alice", "display_name": "Alice", "password": "AlicePassphrase-2026!"},
    )
    assert alice.status_code == 201, alice.text
    alice_id = alice.json()["user"]["id"]
    client.post("/api/auth/logout", headers={"X-CSRF-Token": alice.json()["csrf_token"]})

    bob = client.post(
        "/api/auth/register",
        json={"username": "bob", "display_name": "Bob", "password": "BobPassphrase-2026!"},
    )
    assert bob.status_code == 201, bob.text
    client.post("/api/auth/logout", headers={"X-CSRF-Token": bob.json()["csrf_token"]})

    login = client.post(
        "/api/auth/login",
        json={"username": "owner", "password": "OwnerPassphrase-2026!"},
    )
    assert login.status_code == 200
    owner_csrf = login.json()["csrf_token"]
    assert client.post(
        "/api/auth/step-up",
        json={"password": "OwnerPassphrase-2026!"},
        headers={"X-CSRF-Token": owner_csrf},
    ).status_code == 200
    return owner_csrf, alice_id


def test_gateway_webrtc_p2p_page_signaling_account_autopair_and_admin_visibility(tmp_path):
    portal = tmp_path / "gateway-web"
    portal.mkdir()
    (portal / "index.html").write_text("<html><body>Gateway Portal</body></html>")

    workspace = tmp_path / "workspace-web"
    workspace.mkdir()
    (workspace / "index.html").write_text(
        '<html><head><script src="/workspace-assets/entry.js"></script></head><body>WorkStep UI</body></html>'
    )
    (workspace / "entry.js").write_text("/* workstep bundle */")

    settings = GatewaySettings(
        data_dir=tmp_path / "data",
        public_origin="https://gateway.test",
        stun_port=0,
        web_dist=portal,
        workspace_web_dist=workspace,
    )
    app = create_app(settings)

    with TestClient(app, base_url="https://gateway.test") as client:
        assert client.get("/api/health").json() == {"status": "ok"}

        # /p2p/<device_id>/ serves workspace_web_dist without share-transport tag and coexists with portal.
        p2p_page = client.get("/p2p/dev-unbound/chat")
        assert p2p_page.status_code == 200
        assert "/workspace-assets/entry.js" in p2p_page.text
        assert "workstep-share-transport" not in p2p_page.text
        assert "no-store" in p2p_page.headers.get("cache-control", "")
        assert client.get("/workspace-assets/entry.js").text == "/* workstep bundle */"
        assert "Gateway Portal" in client.get("/admin/devices").text

        owner_csrf, alice_id = _setup_owner_and_member(client)

        gw_priv, gw_pem, gw_fp = _ed25519_pair()
        other_priv, other_pem, other_fp = _ed25519_pair()

        async def seed_devices():
            async with app.state.database.session() as session:
                async with session.begin():
                    session.add(
                        Device(
                            id="gw-dev-1",
                            name="Office Mac",
                            public_key=gw_pem,
                            public_key_fingerprint=gw_fp,
                            app_instance_id="app-inst-1",
                            status="active",
                            version="1.0.0",
                        )
                    )
                    session.add(
                        Device(
                            id="gw-dev-other",
                            name="Other Mac",
                            public_key=other_pem,
                            public_key_fingerprint=other_fp,
                            app_instance_id="app-inst-2",
                            status="active",
                            version="1.0.0",
                        )
                    )

        client.portal.call(seed_devices)
        assert client.post(
            "/api/admin/devices/gw-dev-1/users",
            headers={"X-CSRF-Token": owner_csrf},
            json={"user_id": alice_id},
        ).status_code == 200

        group_resp = client.post(
            "/api/admin/device-groups",
            headers={"X-CSRF-Token": owner_csrf},
            json={"name": "Dept A"},
        )
        assert group_resp.status_code == 201
        dept_group_id = group_resp.json()["id"]
        assert client.put(
            f"/api/admin/device-groups/{dept_group_id}/devices/gw-dev-other",
            headers={"X-CSRF-Token": owner_csrf},
        ).status_code == 204
        dept_admin = client.post(
            "/api/admin/users",
            headers={"X-CSRF-Token": owner_csrf},
            json={
                "username": "deptadmin",
                "display_name": "Dept Admin",
                "password": "DeptPassphrase-2026!",
            },
        ).json()
        assert client.post(
            f"/api/admin/users/{dept_admin['id']}/roles",
            headers={"X-CSRF-Token": owner_csrf},
            json={"role": "device_admin", "scope_type": "device_group", "scope_id": dept_group_id},
        ).status_code == 201

        unbound_priv, unbound_pem, _ = _ed25519_pair()
        bound_priv, bound_pem, _ = _ed25519_pair()

        with (
            client.websocket_connect("/ws/webrtc/device") as unbound_ws,
            client.websocket_connect("/ws/webrtc/device") as bound_ws,
        ):
            n1 = unbound_ws.receive_json()["nonce"]
            unbound_ws.send_json(_sign_webrtc_register(unbound_priv, unbound_pem, n1, "dev-unbound", "k-unbound"))
            assert unbound_ws.receive_json()["type"] == "registered"

            n2 = bound_ws.receive_json()["nonce"]
            bound_ws.send_json(
                _sign_webrtc_register(bound_priv, bound_pem, n2, "dev-bound", "k-bound", gw_priv=gw_priv)
            )
            assert bound_ws.receive_json()["type"] == "registered"

            # Owner (super_admin) sees both bound and unbound WebRTC devices in /api/admin/devices.
            admin_list = client.get("/api/admin/devices")
            assert admin_list.status_code == 200
            admin_payload = admin_list.json()
            webrtc_rows = {row["device_id"]: row for row in admin_payload["webrtc_devices"]}
            assert set(webrtc_rows) == {"dev-unbound", "dev-bound"}
            assert webrtc_rows["dev-unbound"]["gateway_bound"] is False
            assert webrtc_rows["dev-unbound"]["p2p_path"] == "/p2p/dev-unbound/"
            assert webrtc_rows["dev-bound"]["gateway_bound"] is True
            assert webrtc_rows["dev-bound"]["bound_device_id"] == "gw-dev-1"
            assert webrtc_rows["dev-bound"]["bound_device_name"] == "Office Mac"

            managed_by_id = {d["id"]: d for d in admin_payload["devices"]}
            assert managed_by_id["gw-dev-1"]["webrtc_online"] is True
            assert managed_by_id["gw-dev-1"]["webrtc_p2p_path"] == "/p2p/dev-bound/"
            assert managed_by_id["gw-dev-other"]["webrtc_online"] is False

            # Device-group admin (scoped) does NOT see unbound WebRTC device or out-of-scope bound device.
            client.post("/api/auth/logout", headers={"X-CSRF-Token": owner_csrf})
            da_login = client.post(
                "/api/auth/login",
                json={"username": "deptadmin", "password": "DeptPassphrase-2026!"},
            )
            assert da_login.status_code == 200
            da_csrf = da_login.json()["csrf_token"]
            client.post(
                "/api/auth/password",
                headers={"X-CSRF-Token": da_csrf},
                json={
                    "current_password": "DeptPassphrase-2026!",
                    "new_password": "DeptNewPassphrase-2026!",
                },
            )
            scoped_list = client.get("/api/admin/devices")
            assert scoped_list.status_code == 200
            assert scoped_list.json()["webrtc_devices"] == []
            client.post("/api/auth/logout", headers={"X-CSRF-Token": da_csrf})

            # Unauthenticated visitor: neither device grants session_authorized.
            assert client.get("/api/webrtc/config", params={"device_id": "dev-bound"}).json()["session_authorized"] is False
            assert client.post("/api/webrtc/pair", json={"device_id": "dev-bound", "pair_key": ""}).status_code == 403
            # Valid pair_key always works for unbound device.
            unbound_pair = client.post("/api/webrtc/pair", json={"device_id": "dev-unbound", "pair_key": "k-unbound"})
            assert unbound_pair.status_code == 200
            assert unbound_pair.json()["p2p_ticket"]

            # Bob (unauthorized for gw-dev-1): no session auto-pair.
            bob_login = client.post("/api/auth/login", json={"username": "bob", "password": "BobPassphrase-2026!"})
            assert bob_login.status_code == 200
            assert client.get("/api/webrtc/config", params={"device_id": "dev-bound"}).json()["session_authorized"] is False
            assert client.post("/api/webrtc/pair", json={"device_id": "dev-bound", "pair_key": ""}).status_code == 403
            client.post("/api/auth/logout", headers={"X-CSRF-Token": bob_login.json()["csrf_token"]})

            # Alice (granted access to gw-dev-1): session_authorized=True and passwordless pair succeeds!
            alice_login = client.post(
                "/api/auth/login",
                json={"username": "alice", "password": "AlicePassphrase-2026!"},
            )
            assert alice_login.status_code == 200
            alice_cfg = client.get("/api/webrtc/config", params={"device_id": "dev-bound"}).json()
            assert alice_cfg["online"] is True
            assert alice_cfg["session_authorized"] is True
            # Still requires pair_key for signaling-only unbound device.
            assert client.get("/api/webrtc/config", params={"device_id": "dev-unbound"}).json()["session_authorized"] is False

            # Cross-origin POST with Alice's session cookie must NOT auto-pair without pair_key.
            cross_origin_pair = client.post(
                "/api/webrtc/pair",
                headers={"Origin": "https://evil.example"},
                json={"device_id": "dev-bound", "pair_key": ""},
            )
            assert cross_origin_pair.status_code == 403

            auto_pair = client.post(
                "/api/webrtc/pair",
                headers={"Origin": "https://gateway.test"},
                json={"device_id": "dev-bound", "pair_key": ""},
            )
            assert auto_pair.status_code == 200
            assert auto_pair.json()["p2p_ticket"]
            assert auto_pair.json()["session_token"]

            # If Alice's access or device status is disabled by owner, passwordless pair stops immediately.
            client.post("/api/auth/logout", headers={"X-CSRF-Token": alice_login.json()["csrf_token"]})
            owner_login2 = client.post("/api/auth/login", json={"username": "owner", "password": "OwnerPassphrase-2026!"})
            csrf2 = owner_login2.json()["csrf_token"]
            client.post("/api/auth/step-up", json={"password": "OwnerPassphrase-2026!"}, headers={"X-CSRF-Token": csrf2})
            assert client.post("/api/admin/devices/gw-dev-1/disable", headers={"X-CSRF-Token": csrf2}).status_code == 204
            client.post("/api/auth/logout", headers={"X-CSRF-Token": csrf2})

            client.post("/api/auth/login", json={"username": "alice", "password": "AlicePassphrase-2026!"})
            assert client.get("/api/webrtc/config", params={"device_id": "dev-bound"}).json()["session_authorized"] is False
            assert client.post("/api/webrtc/pair", json={"device_id": "dev-bound", "pair_key": ""}).status_code == 403


def test_gateway_starts_built_in_udp_stun_server(tmp_path):
    from workstep_gateway_protocol.webrtc import DEFAULT_PUBLIC_STUN_URLS

    settings = GatewaySettings(
        data_dir=tmp_path / "data",
        public_origin="https://gateway.test",
        stun_host="127.0.0.1",
        stun_port=0,
    )
    app = create_app(settings)
    with TestClient(app, base_url="https://gateway.test") as client:
        stun_port = app.state.stun_port
        assert stun_port > 0
        cfg = client.get("/api/webrtc/config").json()
        assert cfg["stun_urls"] == [*DEFAULT_PUBLIC_STUN_URLS, f"stun:gateway.test:{stun_port}"]

        tx_id = os.urandom(12)
        req_packet = struct.pack("!HHI", 0x0001, 0, 0x2112A442) + tx_id
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.settimeout(2.0)
            sock.sendto(req_packet, ("127.0.0.1", stun_port))
            resp, _ = sock.recvfrom(1500)
        msg_type, msg_len, cookie = struct.unpack("!HHI", resp[:8])
        assert msg_type == 0x0101
        assert cookie == 0x2112A442
        assert resp[8:20] == tx_id
        assert msg_len == 12


def test_gateway_multi_stun_admin_config_propagates_to_pair_and_offer(tmp_path):
    settings = GatewaySettings(data_dir=tmp_path / "data", public_origin="https://gateway.test", stun_port=0)
    app = create_app(settings)
    with TestClient(app, base_url="https://gateway.test") as client:
        owner_csrf, _alice_id = _setup_owner_and_member(client)
        updated = client.put(
            "/api/admin/webrtc-stun",
            headers={"X-CSRF-Token": owner_csrf},
            json={"stun_urls": ["stun:stun.miwifi.com:3478", "stun:stun.cloudflare.com:3478"]},
        )
        assert updated.status_code == 200
        expected_stun = ["stun:stun.miwifi.com:3478", "stun:stun.cloudflare.com:3478"] + (
            [f"stun:gateway.test:{app.state.stun_port}"] if app.state.stun_port > 0 else []
        )

        priv, pem, _ = _ed25519_pair()
        with client.websocket_connect("/ws/webrtc/device") as device_ws:
            nonce = device_ws.receive_json()["nonce"]
            device_ws.send_json(_sign_webrtc_register(priv, pem, nonce, "dev-multi-gw", "k-multi"))
            assert device_ws.receive_json()["type"] == "registered"

            pair = client.post("/api/webrtc/pair", json={"device_id": "dev-multi-gw", "pair_key": "k-multi"})
            assert pair.status_code == 200
            pair_data = pair.json()
            assert pair_data["stun_urls"] == expected_stun

            with client.websocket_connect(
                f"/ws/webrtc/client?device_id=dev-multi-gw&token={pair_data['session_token']}"
            ) as peer_ws:
                assert peer_ws.receive_json()["type"] == "client_ready"
                peer_ws.send_json({
                    "type": "offer",
                    "sdp": "v=0\r\na=candidate:1 1 udp 2122260223 192.168.1.10 50000 typ host\r\n",
                })
                forwarded = device_ws.receive_json()
                assert forwarded["stun_urls"] == expected_stun
