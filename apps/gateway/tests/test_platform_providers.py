import base64
import json

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from fastapi.testclient import TestClient
from sqlalchemy import select

from gateway.app import create_app
from gateway.config import GatewaySettings
from gateway.models import Device, DeviceProviderApplication, PlatformProvider, UserDevice
from gateway.providers_api import compile_provider_bundle


def _claims(token):
    return json.loads(base64.urlsafe_b64decode(token.split(".")[1] + "==="))


def test_admin_assigns_encrypted_provider_without_exposing_secret(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test"))
    with TestClient(app, base_url="https://gateway.test") as client:
        setup = client.post("/api/platform/setup", json={
            "username": "owner", "display_name": "Owner", "password": "OwnerPassphrase-2026!",
            "recovery_username": "recovery", "recovery_password": "RecoveryPassphrase-2026!",
            "registration_mode": "open",
        })
        owner_id = setup.json()["user"]["id"]
        csrf = setup.json()["csrf_token"]
        async def seed_device():
            async with app.state.database.session() as session:
                async with session.begin():
                    session.add(Device(id="device-1", name="Office PC", public_key="test",
                                       status="active", app_instance_id="app-1", version="1.0"))
                    session.add(UserDevice(id="assignment-1", user_id=owner_id,
                                           device_id="device-1", access_level="edit"))
        client.portal.call(seed_device)
        body = {"name": "Company API", "type": "custom", "protocols": ["openai_responses"],
                "protocol_base_urls": {"openai_responses": "https://api.example.test"},
                "api_key": "secret-api-key", "models": ["model-a"],
                "prices": {"model-a": {"input_per_million": "1.00",
                                        "output_per_million": "2.00"}}}
        assert client.post("/api/admin/providers", json=body,
                           headers={"X-CSRF-Token": csrf}).status_code == 403
        client.post("/api/auth/step-up", json={"password": "OwnerPassphrase-2026!"},
                    headers={"X-CSRF-Token": csrf})
        assert client.post("/api/admin/providers", json={
            **body, "protocols": ["unknown"],
            "protocol_base_urls": {"unknown": "https://api.example.test"},
        }, headers={"X-CSRF-Token": csrf}).status_code == 422
        created = client.post("/api/admin/providers", json=body,
                              headers={"X-CSRF-Token": csrf})
        assert created.status_code == 200, created.text
        provider_id = created.json()["id"]
        assert "secret-api-key" not in created.text
        async def stored_ciphertext():
            async with app.state.database.session() as session:
                return await session.scalar(select(PlatformProvider.secret_ciphertext).where(
                    PlatformProvider.id == provider_id,
                ))
        assert "secret-api-key" not in client.portal.call(stored_ciphertext)
        listed = client.get("/api/admin/providers")
        assert listed.status_code == 200
        assert listed.json()["providers"][0]["has_key"] is True
        assert "secret-api-key" not in listed.text
        assigned = client.post(f"/api/admin/providers/{provider_id}/assign", json={
            "subject_type": "user", "subject_id": owner_id,
        }, headers={"X-CSRF-Token": csrf})
        assert assigned.status_code == 200, assigned.text
        device_key = X25519PrivateKey.generate()
        pem = device_key.public_key().public_bytes(
            serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo,
        ).decode()
        bundle = client.portal.call(compile_provider_bundle, app.state.database,
                                    app.state.gateway_signer, "gateway-test", "device-1",
                                    owner_id, pem)
        assert "secret-api-key" not in bundle
        assert _claims(bundle)["revision"] >= 1
        assert _claims(bundle)["kind"] == "provider.bundle"
        async def record_application():
            async with app.state.database.session() as session:
                async with session.begin():
                    session.add(DeviceProviderApplication(
                        device_id="device-1", desired_revision=_claims(bundle)["revision"],
                        applied_revision=_claims(bundle)["revision"],
                    ))
        client.portal.call(record_application)
        status = client.get("/api/admin/providers/applications")
        assert status.status_code == 200, status.text
        assert status.json()["devices"][0]["applied_revision"] == _claims(bundle)["revision"]
        assert "secret-api-key" not in status.text
        assignments = client.get(f"/api/admin/providers/{provider_id}/assignments")
        assert assignments.status_code == 200
        assert assignments.json()["assignments"][0]["subject_id"] == owner_id
        rotated = client.put(f"/api/admin/providers/{provider_id}", json={
            **body, "api_key": "rotated-secret-key", "price_version": "v2",
        }, headers={"X-CSRF-Token": csrf})
        assert rotated.status_code == 200, rotated.text
        assert "rotated-secret-key" not in rotated.text
        assert rotated.json()["revision"] == 2
        revoked = client.post(f"/api/admin/providers/{provider_id}/assign/revoke", json={
            "subject_type": "user", "subject_id": owner_id,
        }, headers={"X-CSRF-Token": csrf})
        assert revoked.status_code == 204
        assert client.post(f"/api/admin/providers/{provider_id}/assign", json={
            "subject_type": "user", "subject_id": owner_id,
        }, headers={"X-CSRF-Token": csrf}).status_code == 200
        disabled = client.post(f"/api/admin/providers/{provider_id}/disable",
                               headers={"X-CSRF-Token": csrf})
        assert disabled.status_code == 204
        later = client.portal.call(compile_provider_bundle, app.state.database,
                                   app.state.gateway_signer, "gateway-test", "device-1",
                                   owner_id, pem)
        assert _claims(later)["revision"] > _claims(bundle)["revision"]
