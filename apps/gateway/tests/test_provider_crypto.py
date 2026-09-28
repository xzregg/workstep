import base64
import json

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives import hashes

from gateway.signing import GatewaySigner


def _decode(value):
    return base64.urlsafe_b64decode(value + "===")


def test_provider_secret_is_encrypted_at_rest_and_bundle_is_bound_to_device(tmp_path):
    signer = GatewaySigner.load_or_create(tmp_path / "signing.pem")
    stored = signer.encrypt_provider_secret("provider-1", "secret-api-key")
    assert "secret-api-key" not in stored
    assert signer.decrypt_provider_secret("provider-1", stored) == "secret-api-key"
    with pytest.raises(ValueError):
        signer.decrypt_provider_secret("provider-2", stored)

    device_key = X25519PrivateKey.generate()
    public_pem = device_key.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode()
    bundle = signer.sign_provider_bundle(
        gateway_id="gateway-test", device_id="device-1", user_id="user-1",
        revision=3, config_public_key_pem=public_pem,
        providers=[{"id": "provider-1", "api_key": "secret-api-key"}],
    )
    assert "secret-api-key" not in bundle
    header, payload, signature = bundle.split(".")
    signer.private_key.public_key().verify(_decode(signature), f"{header}.{payload}".encode())
    claims = json.loads(_decode(payload))
    assert claims["device_id"] == "device-1"
    assert claims["kind"] == "provider.bundle"
    ephemeral = X25519PublicKey.from_public_bytes(
        _decode(claims["ephemeral_public_key"]),
    )
    shared = device_key.exchange(ephemeral)
    key = HKDF(algorithm=hashes.SHA256(), length=32, salt=None,
               info=b"workstep-provider-device-v1").derive(shared)
    plaintext = AESGCM(key).decrypt(_decode(claims["nonce"]),
                                    _decode(claims["ciphertext"]),
                                    b"gateway-test:device-1:user-1:3")
    assert json.loads(plaintext)["providers"][0]["api_key"] == "secret-api-key"
