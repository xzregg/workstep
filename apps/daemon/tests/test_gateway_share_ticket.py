import pytest

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization

from services.gateway_client.share_ticket import verify_share_ticket


def _ticket(*, device_id="device-1", mode="read_only", task_id="task-1"):
    import base64
    import json
    import time
    import hashlib

    key = Ed25519PrivateKey.generate()
    pem = key.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode()
    der = key.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    fingerprint = hashlib.sha256(der).hexdigest()
    encode = lambda value: base64.urlsafe_b64encode(json.dumps(value).encode()).rstrip(b"=").decode()
    now = int(time.time())
    header = encode({"alg": "EdDSA", "typ": "JWT"})
    payload = encode({
        "iss": "gateway-1", "gateway_id": "gateway-1", "kind": "platform.share",
        "aud": "device-1", "device_id": device_id, "share_id": "share-1",
        "project_id": "project-1", "host_project_id": "host-1",
        "task_id": task_id, "mode": mode, "jti": "a" * 24,
        "iat": now, "exp": now + 60,
    })
    signing_input = f"{header}.{payload}"
    ticket = f"{signing_input}.{base64.urlsafe_b64encode(key.sign(signing_input.encode())).rstrip(b'=').decode()}"
    return ticket, pem, fingerprint


def test_share_ticket_requires_pinned_key_device_and_exact_scope():
    ticket, pem, fingerprint = _ticket()
    scope = verify_share_ticket(ticket, pem, fingerprint, "gateway-1", "device-1")
    assert scope == {
        "share_id": "share-1", "project_id": "project-1", "host_project_id": "host-1",
        "task_id": "task-1", "mode": "read_only",
    }
    for kwargs in ({"expected_fingerprint": "0" * 64}, {"device_id": "device-2"},
                   {"gateway_id": "gateway-2"}):
        params = {"expected_fingerprint": fingerprint, "device_id": "device-1",
                  "gateway_id": "gateway-1"} | kwargs
        with pytest.raises(ValueError):
            verify_share_ticket(ticket, pem, **params)
    with pytest.raises(ValueError):
        verify_share_ticket(ticket + "x", pem, fingerprint, "gateway-1", "device-1")
    for bad in ({"mode": "admin"}, {"task_id": "../task"}):
        malformed, key, pin = _ticket(**bad)
        with pytest.raises(ValueError):
            verify_share_ticket(malformed, key, pin, "gateway-1", "device-1")
