"""Pinned Gateway authorization verification and local managed sessions."""

import base64
import hashlib
import json
import secrets
import time
from dataclasses import dataclass

import httpx
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey


def _decode(value: str) -> bytes:
    if not value or any(character not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-" for character in value):
        raise ValueError("Invalid authorization encoding")
    return base64.urlsafe_b64decode(value + "===")


@dataclass(frozen=True)
class ManagedActor:
    user_id: str
    username: str
    device_id: str
    app_instance_id: str
    policy_revision: int
    project_id: str | None = None
    project_access_level: str | None = None
    remote_task_create: bool = False


class ManagedAuthorizationVerifier:
    def __init__(self, gateway_id: str, gateway_origin: str, public_key_fingerprint: str,
                 client_factory=None):
        self.gateway_id = gateway_id
        self.gateway_origin = gateway_origin
        self.public_key_fingerprint = public_key_fingerprint
        self.client_factory = client_factory or (lambda: httpx.AsyncClient(timeout=10))

    async def verify(self, authorization: str, device_proof: str) -> ManagedActor:
        async with self.client_factory() as client:
            response = await client.get(f"{self.gateway_origin}/api/platform/gateway-key")
            if response.status_code != 200:
                raise ConnectionError("Gateway signing key unavailable")
            key_data = response.json()
        if key_data.get("gateway_id") != self.gateway_id:
            raise ValueError("Gateway ID mismatch")
        public_key = serialization.load_pem_public_key(key_data["public_key_pem"].encode())
        if not isinstance(public_key, Ed25519PublicKey):
            raise ValueError("Gateway key must be Ed25519")
        fingerprint = hashlib.sha256(public_key.public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo,
        )).hexdigest()
        if fingerprint != self.public_key_fingerprint or key_data.get("fingerprint") != fingerprint:
            raise ValueError("Gateway public key fingerprint mismatch")
        try:
            header, payload, signature = authorization.split(".")
            if json.loads(_decode(header)) != {"alg": "EdDSA", "typ": "JWT"}:
                raise ValueError("Unexpected authorization algorithm")
            public_key.verify(_decode(signature), f"{header}.{payload}".encode())
            claims = json.loads(_decode(payload))
            now = int(time.time())
            if (claims.get("gateway_id") != self.gateway_id
                    or claims.get("iss") != self.gateway_id
                    or not isinstance(claims.get("iat"), int)
                    or not isinstance(claims.get("exp"), int)
                    or claims["iat"] > now + 60 or claims["exp"] <= now
                    or claims["exp"] - claims["iat"] > 900):
                raise ValueError("Gateway authorization expired or mismatched")
            device_key = serialization.load_pem_public_key(claims["device_public_key"].encode())
            if not isinstance(device_key, Ed25519PublicKey):
                raise ValueError("Device key must be Ed25519")
            device_key.verify(_decode(device_proof), authorization.encode())
            for key in ("user_id", "username", "device_id", "app_instance_id"):
                if not isinstance(claims.get(key), str) or not claims[key]:
                    raise ValueError("Incomplete authorization identity")
            if not isinstance(claims.get("policy_revision"), int):
                raise ValueError("Invalid policy revision")
        except (InvalidSignature, KeyError, TypeError, json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise ValueError("Invalid Gateway authorization or device proof") from exc
        except ValueError as exc:
            if "proof" in str(exc):
                raise
            raise ValueError(f"Invalid Gateway authorization or device proof: {exc}") from exc
        return ManagedActor(
            user_id=claims["user_id"], username=claims["username"],
            device_id=claims["device_id"], app_instance_id=claims["app_instance_id"],
            policy_revision=claims["policy_revision"],
        )


class ManagedLocalSessions:
    def __init__(self):
        self._sessions: dict[str, tuple[ManagedActor, float]] = {}

    def create(self, actor: ManagedActor) -> str:
        token = secrets.token_urlsafe(32)
        self._sessions[hashlib.sha256(token.encode()).hexdigest()] = (actor, time.time() + 8 * 3600)
        return token

    def resolve(self, token: str | None) -> ManagedActor | None:
        if not token:
            return None
        digest = hashlib.sha256(token.encode()).hexdigest()
        item = self._sessions.get(digest)
        if not item:
            return None
        actor, expires_at = item
        if expires_at <= time.time():
            self._sessions.pop(digest, None)
            return None
        return actor

    def clear(self) -> None:
        self._sessions.clear()
