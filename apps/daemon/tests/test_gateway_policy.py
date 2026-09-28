import base64
import hashlib
import json
import time

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from services.gateway_client.policy import ManagedPolicyCache, verify_policy_snapshot, require_managed_capability
from services.remote_access import ActorSnapshot, actor_context
from types import SimpleNamespace


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


def test_managed_task_creation_requires_matching_live_capability(monkeypatch):
    import main

    cache = ManagedPolicyCache()
    monkeypatch.setattr(main, "gateway_client", SimpleNamespace(
        managed_config=object(), policy_cache=cache,
    ))
    actor = ActorSnapshot("user-1", "alice", "device-1", "Alice PC", "managed")
    with actor_context(actor):
        with pytest.raises(PermissionError):
            require_managed_capability("task.create")
        token, pem, fingerprint = _signed_policy(task_create=True)
        cache.apply(verify_policy_snapshot(token, pem, fingerprint,
                                           "gateway-test", "device-1", "user-1"))
        require_managed_capability("task.create")
    with actor_context(ActorSnapshot("user-2", "bob", "device-1", "Alice PC", "managed")):
        with pytest.raises(PermissionError):
            require_managed_capability("task.create")


def test_project_scoped_task_creation_and_explicit_denial(monkeypatch):
    import main

    token, pem, fingerprint = _signed_policy(
        task_create_project_ids=["project-1"],
        task_create_denied_project_ids=["project-2"],
    )
    cache = ManagedPolicyCache()
    cache.apply(verify_policy_snapshot(token, pem, fingerprint,
                                       "gateway-test", "device-1", "user-1"))
    monkeypatch.setattr(main, "gateway_client", SimpleNamespace(
        managed_config=object(), policy_cache=cache,
    ))
    actor = ActorSnapshot("user-1", "alice", "device-1", "Alice PC", "managed")
    with actor_context(actor):
        require_managed_capability("task.create", project_id="project-1")
        with pytest.raises(PermissionError):
            require_managed_capability("task.create", project_id="project-2")
        with pytest.raises(PermissionError):
            require_managed_capability("task.create", project_id="project-3")
    assert cache.allows("task.create", project_id="project-1")
    assert not cache.allows("task.create", project_id="project-2")

    broad, pem, fingerprint = _signed_policy(
        task_create=True, task_create_denied_project_ids=["project-2"],
    )
    policy = verify_policy_snapshot(broad, pem, fingerprint,
                                    "gateway-test", "device-1", "user-1")
    assert policy.allows("task.create", project_id="project-1")
    assert not policy.allows("task.create", project_id="project-2")

    invalid, pem, fingerprint = _signed_policy(task_create_project_ids=["", 4])
    with pytest.raises(ValueError):
        verify_policy_snapshot(invalid, pem, fingerprint,
                               "gateway-test", "device-1", "user-1")


def test_remote_project_task_creation_uses_its_own_capability(monkeypatch):
    import main

    monkeypatch.setattr(main, "gateway_client", SimpleNamespace(
        managed_config=object(), policy_cache=ManagedPolicyCache(),
    ))
    actor = ActorSnapshot("worker", "Worker", "device-1", "PC", "managed",
                          project_id="host-1", access_level="edit",
                          remote_task_create=True)
    with actor_context(actor):
        require_managed_capability("task.create", project_id="host-1")
        with pytest.raises(PermissionError):
            require_managed_capability("task.create", project_id="host-2")
    with actor_context(ActorSnapshot("worker", "Worker", "device-1", "PC", "managed",
                                     project_id="host-1", access_level="read",
                                     remote_task_create=True)):
        with pytest.raises(PermissionError):
            require_managed_capability("task.create", project_id="host-1")
