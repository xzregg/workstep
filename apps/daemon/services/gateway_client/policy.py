"""Pinned, time-bounded managed permission snapshots."""

import base64
import hashlib
import json
import time
from dataclasses import dataclass

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey


def _decode(value: str) -> bytes:
    if not value or len(value) > 16384 or any(c not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-" for c in value):
        raise ValueError("Invalid policy encoding")
    try:
        return base64.urlsafe_b64decode(value + "===")
    except Exception as exc:
        raise ValueError("Invalid policy encoding") from exc


@dataclass(frozen=True)
class ManagedPolicy:
    gateway_id: str
    device_id: str
    user_id: str
    revision: int
    issued_at: int
    expires_at: int
    allowed_provider_ids: frozenset[str]
    allowed_models: frozenset[str]
    allow_local_providers: bool
    task_create: bool
    project_publish: bool
    task_share: bool
    engine_install: bool
    task_create_project_ids: frozenset[str] = frozenset()
    task_create_denied_project_ids: frozenset[str] = frozenset()

    @property
    def valid(self) -> bool:
        return self.expires_at > int(time.time())

    def allows(self, action: str, *, project_id: str | None = None) -> bool:
        if not self.valid:
            return False
        if action == "task.create":
            if project_id is None:
                return self.task_create
            if project_id in self.task_create_denied_project_ids:
                return False
            return self.task_create or project_id in self.task_create_project_ids
        return {
            "provider.local": self.allow_local_providers,
            "project.publish": self.project_publish,
            "task.share": self.task_share,
            "engine.install": self.engine_install,
        }.get(action, False)


def verify_policy_snapshot(token: str, public_key_pem: str, expected_fingerprint: str,
                           gateway_id: str, device_id: str, user_id: str) -> ManagedPolicy:
    try:
        public_key = serialization.load_pem_public_key(public_key_pem.encode())
        if not isinstance(public_key, Ed25519PublicKey):
            raise ValueError("Gateway policy key must be Ed25519")
        fingerprint = hashlib.sha256(public_key.public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo,
        )).hexdigest()
        if fingerprint != expected_fingerprint:
            raise ValueError("Gateway policy key mismatch")
        header, payload, signature = token.split(".")
        if json.loads(_decode(header)) != {"alg": "EdDSA", "typ": "JWT"}:
            raise ValueError("Invalid policy algorithm")
        public_key.verify(_decode(signature), f"{header}.{payload}".encode())
        claims = json.loads(_decode(payload))
        now = int(time.time())
        if (claims.get("iss") != gateway_id or claims.get("gateway_id") != gateway_id
                or claims.get("kind") != "policy.snapshot"
                or claims.get("device_id") != device_id or claims.get("user_id") != user_id
                or type(claims.get("policy_revision")) is not int or claims["policy_revision"] < 0
                or type(claims.get("iat")) is not int or type(claims.get("exp")) is not int
                or claims["iat"] > now + 60 or claims["exp"] <= now
                or claims["exp"] - claims["iat"] > 3600):
            raise ValueError("Policy identity, revision or lifetime invalid")
        for name in ("allowed_provider_ids", "allowed_models"):
            values = claims.get(name)
            if not isinstance(values, list) or len(values) > 1000 or any(
                    not isinstance(value, str) or not value for value in values):
                raise ValueError("Invalid policy catalog")
        for name in ("task_create_project_ids", "task_create_denied_project_ids"):
            values = claims.get(name, [])
            if (not isinstance(values, list) or len(values) > 1000
                    or any(not isinstance(value, str) or not value or len(value) > 128
                           for value in values)):
                raise ValueError("Invalid project capability scope")
        for name in ("allow_local_providers", "task_create", "project_publish",
                     "task_share", "engine_install"):
            if type(claims.get(name)) is not bool:
                raise ValueError("Invalid policy capability")
        return ManagedPolicy(
            gateway_id=gateway_id, device_id=device_id, user_id=user_id,
            revision=claims["policy_revision"], issued_at=claims["iat"],
            expires_at=claims["exp"],
            allowed_provider_ids=frozenset(claims["allowed_provider_ids"]),
            allowed_models=frozenset(claims["allowed_models"]),
            allow_local_providers=claims["allow_local_providers"],
            task_create=claims["task_create"], project_publish=claims["project_publish"],
            task_share=claims["task_share"], engine_install=claims["engine_install"],
            task_create_project_ids=frozenset(claims.get("task_create_project_ids", [])),
            task_create_denied_project_ids=frozenset(
                claims.get("task_create_denied_project_ids", [])),
        )
    except (InvalidSignature, KeyError, TypeError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError("Invalid Gateway policy snapshot") from exc


class ManagedPolicyCache:
    def __init__(self):
        self.current: ManagedPolicy | None = None

    def apply(self, policy: ManagedPolicy) -> None:
        current = self.current
        if current and (
            policy.gateway_id != current.gateway_id or policy.device_id != current.device_id
            or policy.user_id != current.user_id or policy.revision < current.revision
            or (policy.revision == current.revision and policy.issued_at < current.issued_at)
        ):
            raise ValueError("Stale or mismatched managed policy")
        self.current = policy

    def allows(self, action: str, *, project_id: str | None = None) -> bool:
        return bool(self.current and self.current.allows(action, project_id=project_id))

    def clear(self) -> None:
        self.current = None


def require_managed_capability(action: str, *, creator_fields: dict | None = None,
                               project_id: str | None = None) -> None:
    """Fail closed at a shared service entry when this daemon is Gateway-managed."""
    from main import gateway_client
    from services.remote_access import get_current_actor

    if gateway_client.managed_config is None:
        return
    actor = get_current_actor()
    if actor is not None and actor.source == "managed" and actor.project_id is not None:
        if (action == "task.create" and actor.project_id == project_id
                and actor.access_level == "edit" and actor.remote_task_create):
            return
        raise PermissionError(f"Managed capability denied: {action}")
    user_id = actor.actor_id if actor is not None and actor.source == "managed" else None
    if user_id is None and actor is None and creator_fields:
        user_id = creator_fields.get("creator_id")
    policy = gateway_client.policy_cache.current
    if (not user_id or policy is None or policy.user_id != user_id
            or not gateway_client.policy_cache.allows(action, project_id=project_id)):
        raise PermissionError(f"Managed capability denied: {action}")
