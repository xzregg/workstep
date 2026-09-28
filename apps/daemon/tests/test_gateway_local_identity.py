import base64
import hashlib
import json
import time

import httpx
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from services.gateway_client.identity import ManagedAuthorizationVerifier, ManagedLocalSessions


def _b64(value):
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode()


def _fixture():
    gateway_key = Ed25519PrivateKey.generate()
    gateway_public = gateway_key.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode()
    gateway_fingerprint = hashlib.sha256(gateway_key.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo,
    )).hexdigest()
    device_key = Ed25519PrivateKey.generate()
    device_public = device_key.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode()
    header = _b64(json.dumps({"alg": "EdDSA", "typ": "JWT"}).encode())
    payload = _b64(json.dumps({
        "gateway_id": "gateway-test", "iss": "gateway-test", "user_id": "user-1",
        "username": "alice", "display_name": "Alice Display",
        "device_id": "device-1", "device_public_key": device_public,
        "app_instance_id": "app-instance-12345", "policy_revision": 2,
        "iat": int(time.time()), "exp": int(time.time()) + 900,
    }).encode())
    signed = f"{header}.{payload}"
    authorization = f"{signed}.{_b64(gateway_key.sign(signed.encode()))}"
    proof = _b64(device_key.sign(authorization.encode()))
    return gateway_public, gateway_fingerprint, authorization, proof


@pytest.mark.asyncio
async def test_pinned_gateway_and_device_proof_create_local_actor():
    public, fingerprint, authorization, proof = _fixture()

    def handler(request):
        assert str(request.url) == "https://gateway.test/api/platform/gateway-key"
        return httpx.Response(200, json={"gateway_id": "gateway-test",
                                         "fingerprint": fingerprint, "public_key_pem": public})

    verifier = ManagedAuthorizationVerifier(
        "gateway-test", "https://gateway.test", fingerprint,
        client_factory=lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    actor = await verifier.verify(authorization, proof)
    assert (actor.user_id, actor.username, actor.device_id, actor.app_instance_id) == (
        "user-1", "alice", "device-1", "app-instance-12345",
    )
    assert actor.display_name == "Alice Display"
    sessions = ManagedLocalSessions()
    token = sessions.create(actor)
    assert sessions.resolve(token).user_id == "user-1"
    assert sessions.resolve("wrong-token") is None

    with pytest.raises(ValueError, match="device proof"):
        await verifier.verify(authorization, "bad-proof")
    wrong_pin = ManagedAuthorizationVerifier(
        "gateway-test", "https://gateway.test", "0" * 64,
        client_factory=lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    with pytest.raises(ValueError, match="fingerprint"):
        await wrong_pin.verify(authorization, proof)
