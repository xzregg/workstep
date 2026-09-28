import base64
import hashlib
import json
import time

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from services.gateway_client.policy import ManagedPolicyCache, verify_policy_snapshot


def _signed_policy(**overrides):
    private_key = Ed25519PrivateKey.generate()
    public_key = private_key.public_key()
    pem = public_key.public_bytes(serialization.Encoding.PEM,
                                  serialization.PublicFormat.SubjectPublicKeyInfo).decode()
    fingerprint = hashlib.sha256(public_key.public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo,
    )).hexdigest()
    now = int(time.time())
    claims = {"iss": "gateway-test", "kind": "policy.snapshot",
              "gateway_id": "gateway-test", "device_id": "device-1", "user_id": "user-1",
              "policy_revision": 2, "iat": now, "exp": now + 600,
              "allowed_provider_ids": [], "allowed_models": [],
              "allow_local_providers": False, "task_create": False,
              "project_publish": False, "task_share": False, "engine_install": False}
    claims.update(overrides)
    header = base64.urlsafe_b64encode(b'{"alg":"EdDSA","typ":"JWT"}').rstrip(b"=").decode()
    payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).rstrip(b"=").decode()
    data = f"{header}.{payload}"
    signature = base64.urlsafe_b64encode(private_key.sign(data.encode())).rstrip(b"=").decode()
    return f"{data}.{signature}", pem, fingerprint


def test_policy_snapshot_is_pinned_bound_and_expires():
    token, pem, fingerprint = _signed_policy()
    policy = verify_policy_snapshot(token, pem, fingerprint, "gateway-test", "device-1", "user-1")
    assert policy.revision == 2
    assert policy.allows("task.create") is False
    assert policy.valid is True
    with pytest.raises(ValueError):
        verify_policy_snapshot(token, pem, "0" * 64, "gateway-test", "device-1", "user-1")
    with pytest.raises(ValueError):
        verify_policy_snapshot(token, pem, fingerprint, "gateway-test", "other-device", "user-1")
    expired, pem, fingerprint = _signed_policy(exp=int(time.time()) - 1)
    with pytest.raises(ValueError):
        verify_policy_snapshot(expired, pem, fingerprint, "gateway-test", "device-1", "user-1")


def test_policy_cache_refuses_older_revision_and_expires(monkeypatch):
    cache = ManagedPolicyCache()
    token, pem, fingerprint = _signed_policy(policy_revision=2)
    newer = verify_policy_snapshot(token, pem, fingerprint, "gateway-test", "device-1", "user-1")
    cache.apply(newer)
    token, pem, fingerprint = _signed_policy(policy_revision=1)
    older = verify_policy_snapshot(token, pem, fingerprint, "gateway-test", "device-1", "user-1")
    with pytest.raises(ValueError):
        cache.apply(older)
    assert cache.current.revision == 2
    monkeypatch.setattr("services.gateway_client.policy.time.time",
                        lambda: cache.current.expires_at + 1)
    assert cache.current.valid is False
    assert cache.allows("task.create") is False
