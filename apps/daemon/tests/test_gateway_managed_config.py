import base64
import hashlib
import json

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization

from services.gateway_client.managed_config import InvalidManagedGatewayConfig, load_managed_config
from services.gateway_client import GatewayClientService


def _write_signed_bundle(path, *, tamper=False, min_version=1):
    path.mkdir()
    key = Ed25519PrivateKey.generate()
    payload = {
        "gateway_id": "gateway-1",
        "gateway_origin": "https://gateway.example.com",
        "gateway_public_key_fingerprint": "a" * 64,
        "deployment_channel": "stable",
        "min_protocol_version": min_version,
    }
    body = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    (path / "managed-root.pem").write_bytes(key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ))
    if tamper:
        payload["gateway_origin"] = "https://attacker.example.com"
    (path / "managed-gateway.json").write_text(json.dumps({
        "payload": payload,
        "signature": base64.b64encode(key.sign(body)).decode(),
    }))
    return hashlib.sha256(key.public_key().public_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )).hexdigest()


def test_unconfigured_installation_stays_local(tmp_path):
    assert load_managed_config(tmp_path / "managed-gateway", None) is None
    with pytest.raises(InvalidManagedGatewayConfig):
        load_managed_config(tmp_path / "managed-gateway", "a" * 64)


def test_valid_signed_bundle_is_loaded(tmp_path):
    pin = _write_signed_bundle(tmp_path / "managed-gateway")
    config = load_managed_config(tmp_path / "managed-gateway", pin)
    assert config.gateway_id == "gateway-1"
    with pytest.raises(InvalidManagedGatewayConfig):
        load_managed_config(tmp_path / "managed-gateway", None)


def test_tampered_or_incomplete_bundle_is_rejected(tmp_path):
    bundle = tmp_path / "managed-gateway"
    pin = _write_signed_bundle(bundle, tamper=True)
    with pytest.raises(InvalidManagedGatewayConfig):
        load_managed_config(bundle, pin)
    (bundle / "managed-gateway.json").unlink()
    with pytest.raises(InvalidManagedGatewayConfig):
        load_managed_config(bundle, pin)

    valid_bundle = tmp_path / "another-gateway"
    valid_pin = _write_signed_bundle(valid_bundle)
    replacement = Ed25519PrivateKey.generate().public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    (valid_bundle / "managed-root.pem").write_bytes(replacement)
    with pytest.raises(InvalidManagedGatewayConfig):
        load_managed_config(valid_bundle, valid_pin)

    unsupported_bundle = tmp_path / "future-gateway"
    future_pin = _write_signed_bundle(unsupported_bundle, min_version=2)
    with pytest.raises(InvalidManagedGatewayConfig):
        load_managed_config(unsupported_bundle, future_pin)


@pytest.mark.asyncio
async def test_invalid_bundle_blocks_client_start_without_changing_projects(tmp_path, monkeypatch):
    project = tmp_path / "project"
    project.mkdir()
    marker = project / "keep.txt"
    marker.write_text("original")
    bundle = tmp_path / "managed-gateway"
    pin = _write_signed_bundle(bundle, tamper=True)
    monkeypatch.setenv("WORKSTEP_MANAGED_BUNDLE_DIR", str(bundle))
    monkeypatch.setenv("WORKSTEP_MANAGED_ROOT_PIN", pin)
    with pytest.raises(InvalidManagedGatewayConfig):
        await GatewayClientService().start()
    assert marker.read_text() == "original"
    monkeypatch.delenv("WORKSTEP_MANAGED_BUNDLE_DIR")
    with pytest.raises(InvalidManagedGatewayConfig):
        await GatewayClientService().start()
