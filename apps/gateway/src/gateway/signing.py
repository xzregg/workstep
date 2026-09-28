"""Persistent Gateway Ed25519 key for device-scoped authorization."""

import base64
import binascii
import hashlib
import json
import os
import secrets
import time
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


class GatewaySigner:
    def __init__(self, private_key: Ed25519PrivateKey):
        self.private_key = private_key
        self.public_key_pem = private_key.public_key().public_bytes(
            serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo,
        ).decode()
        der = private_key.public_key().public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        self.fingerprint = hashlib.sha256(der).hexdigest()

    @classmethod
    def load_or_create(cls, path: Path) -> "GatewaySigner":
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            raw = path.read_bytes()
        except FileNotFoundError:
            private_key = Ed25519PrivateKey.generate()
            raw = private_key.private_bytes(
                serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            )
            try:
                descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError:
                raw = path.read_bytes()
            else:
                with os.fdopen(descriptor, "wb") as output:
                    output.write(raw)
                    output.flush()
                    os.fsync(output.fileno())
        private_key = serialization.load_pem_private_key(raw, password=None)
        if not isinstance(private_key, Ed25519PrivateKey):
            raise ValueError("Gateway signing key must be Ed25519")
        return cls(private_key)

    def sign_device_authorization(self, *, gateway_id: str, device_id: str, user_id: str,
                                  username: str, app_instance_id: str, device_public_key: str,
                                  policy_revision: int = 0) -> str:
        now = int(time.time())
        header = _b64(json.dumps({"alg": "EdDSA", "typ": "JWT"}, separators=(",", ":")).encode())
        payload = _b64(json.dumps({
            "iss": gateway_id, "gateway_id": gateway_id, "device_id": device_id,
            "user_id": user_id, "username": username,
            "app_instance_id": app_instance_id, "policy_revision": policy_revision,
            "device_public_key": device_public_key,
            "iat": now, "exp": now + 900,
        }, separators=(",", ":"), sort_keys=True).encode())
        signing_input = f"{header}.{payload}"
        return f"{signing_input}.{_b64(self.private_key.sign(signing_input.encode()))}"

    def sign_policy_snapshot(self, *, gateway_id: str, device_id: str, user_id: str,
                             revision: int = 0, task_create: bool = False,
                             ttl_seconds: int = 600) -> str:
        now = int(time.time())
        header = _b64(json.dumps({"alg": "EdDSA", "typ": "JWT"}, separators=(",", ":")).encode())
        payload = _b64(json.dumps({
            "iss": gateway_id, "kind": "policy.snapshot", "gateway_id": gateway_id,
            "device_id": device_id, "user_id": user_id,
            "policy_revision": revision, "iat": now, "exp": now + ttl_seconds,
            "allowed_provider_ids": [], "allowed_models": [],
            "allow_local_providers": False, "task_create": task_create,
            "project_publish": False, "task_share": False, "engine_install": False,
        }, separators=(",", ":"), sort_keys=True).encode())
        signing_input = f"{header}.{payload}"
        return f"{signing_input}.{_b64(self.private_key.sign(signing_input.encode()))}"

    def sign_device_access_ticket(self, *, gateway_id: str, device_id: str,
                                  user_id: str, audience: str) -> str:
        now = int(time.time())
        header = _b64(json.dumps({"alg": "EdDSA", "typ": "JWT"}, separators=(",", ":")).encode())
        payload = _b64(json.dumps({
            "iss": gateway_id, "gateway_id": gateway_id, "kind": "device.access",
            "device_id": device_id, "user_id": user_id, "aud": audience,
            "jti": secrets.token_urlsafe(24), "iat": now, "exp": now + 60,
        }, separators=(",", ":"), sort_keys=True).encode())
        signing_input = f"{header}.{payload}"
        return f"{signing_input}.{_b64(self.private_key.sign(signing_input.encode()))}"

    def verify_device_access_ticket(self, ticket: str, *, gateway_id: str,
                                    audience: str) -> dict:
        if len(ticket) > 8192:
            raise ValueError("Invalid device access ticket")
        try:
            header, payload, signature = ticket.split(".")
            def decode(part: str) -> bytes:
                if not part or any(char not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-" for char in part):
                    raise ValueError("Invalid ticket encoding")
                return base64.urlsafe_b64decode(part + "===")
            if json.loads(decode(header)) != {"alg": "EdDSA", "typ": "JWT"}:
                raise ValueError("Invalid ticket header")
            self.private_key.public_key().verify(decode(signature), f"{header}.{payload}".encode())
            claims = json.loads(decode(payload))
            now = int(time.time())
            if (not isinstance(claims, dict) or claims.get("kind") != "device.access"
                    or claims.get("iss") != gateway_id or claims.get("gateway_id") != gateway_id
                    or claims.get("aud") != audience
                    or not isinstance(claims.get("iat"), int)
                    or not isinstance(claims.get("exp"), int)
                    or claims["iat"] > now + 5 or claims["exp"] <= now
                    or claims["exp"] - claims["iat"] > 60
                    or not isinstance(claims.get("jti"), str) or len(claims["jti"]) < 20
                    or not isinstance(claims.get("device_id"), str)
                    or not isinstance(claims.get("user_id"), str)):
                raise ValueError("Invalid ticket claims")
            return claims
        except (ValueError, TypeError, UnicodeDecodeError, json.JSONDecodeError,
                binascii.Error, InvalidSignature) as exc:
            raise ValueError("Invalid device access ticket") from exc
