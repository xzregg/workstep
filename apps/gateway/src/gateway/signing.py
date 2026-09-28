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
from cryptography.exceptions import InvalidSignature, InvalidTag
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives import hashes


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
                                  display_name: str | None = None,
                                  policy_revision: int = 0) -> str:
        now = int(time.time())
        header = _b64(json.dumps({"alg": "EdDSA", "typ": "JWT"}, separators=(",", ":")).encode())
        payload = _b64(json.dumps({
            "iss": gateway_id, "gateway_id": gateway_id, "device_id": device_id,
            "user_id": user_id, "username": username,
            "display_name": display_name or username,
            "app_instance_id": app_instance_id, "policy_revision": policy_revision,
            "device_public_key": device_public_key,
            "iat": now, "exp": now + 900,
        }, separators=(",", ":"), sort_keys=True).encode())
        signing_input = f"{header}.{payload}"
        return f"{signing_input}.{_b64(self.private_key.sign(signing_input.encode()))}"

    def sign_policy_snapshot(self, *, gateway_id: str, device_id: str, user_id: str,
                             revision: int = 0, task_create: bool = False,
                             project_publish: bool = False,
                             task_create_project_ids: list[str] | None = None,
                             task_create_denied_project_ids: list[str] | None = None,
                             allowed_provider_ids: list[str] | None = None,
                             allowed_models: list[str] | None = None,
                             ttl_seconds: int = 600) -> str:
        now = int(time.time())
        header = _b64(json.dumps({"alg": "EdDSA", "typ": "JWT"}, separators=(",", ":")).encode())
        payload = _b64(json.dumps({
            "iss": gateway_id, "kind": "policy.snapshot", "gateway_id": gateway_id,
            "device_id": device_id, "user_id": user_id,
            "policy_revision": revision, "iat": now, "exp": now + ttl_seconds,
            "allowed_provider_ids": allowed_provider_ids or [],
            "allowed_models": allowed_models or [],
            "allow_local_providers": False, "task_create": task_create,
            "task_create_project_ids": task_create_project_ids or [],
            "task_create_denied_project_ids": task_create_denied_project_ids or [],
            "project_publish": project_publish, "task_share": False, "engine_install": False,
        }, separators=(",", ":"), sort_keys=True).encode())
        signing_input = f"{header}.{payload}"
        return f"{signing_input}.{_b64(self.private_key.sign(signing_input.encode()))}"

    def sign_device_access_ticket(self, *, gateway_id: str, device_id: str,
                                  user_id: str, audience: str) -> str:
        return self._sign_access_ticket(gateway_id=gateway_id, device_id=device_id,
                                        user_id=user_id, audience=audience,
                                        kind="device.access")

    def sign_project_access_ticket(self, *, gateway_id: str, device_id: str,
                                   user_id: str, audience: str, project_id: str,
                                   host_project_id: str, access_level: str) -> str:
        if access_level not in ("read", "edit") or not project_id or not host_project_id:
            raise ValueError("Invalid project access")
        return self._sign_access_ticket(gateway_id=gateway_id, device_id=device_id,
                                        user_id=user_id, audience=audience,
                                        kind="project.access", project_id=project_id,
                                        host_project_id=host_project_id,
                                        access_level=access_level)

    def sign_platform_share_ticket(self, *, gateway_id: str, device_id: str,
                                   share_id: str, project_id: str,
                                   host_project_id: str, task_id: str,
                                   mode: str) -> str:
        if mode not in ("read_only", "interactive"):
            raise ValueError("Invalid platform share mode")
        for value, limit in ((share_id, 128), (project_id, 64),
                             (host_project_id, 128), (task_id, 128)):
            if (not isinstance(value, str) or not value or len(value) > limit
                    or not value[0].isalnum()
                    or any(not (char.isascii() and (char.isalnum() or char in "_-"))
                           for char in value)):
                raise ValueError("Invalid platform share scope")
        now = int(time.time())
        header = _b64(json.dumps({"alg": "EdDSA", "typ": "JWT"}, separators=(",", ":")).encode())
        payload = _b64(json.dumps({
            "iss": gateway_id, "gateway_id": gateway_id, "kind": "platform.share",
            "aud": device_id, "device_id": device_id, "share_id": share_id,
            "project_id": project_id, "host_project_id": host_project_id,
            "task_id": task_id, "mode": mode,
            "jti": secrets.token_urlsafe(24), "iat": now, "exp": now + 60,
        }, separators=(",", ":"), sort_keys=True).encode())
        signing_input = f"{header}.{payload}"
        return f"{signing_input}.{_b64(self.private_key.sign(signing_input.encode()))}"

    def _sign_access_ticket(self, *, gateway_id: str, device_id: str,
                            user_id: str, audience: str, kind: str,
                            **scope) -> str:
        now = int(time.time())
        header = _b64(json.dumps({"alg": "EdDSA", "typ": "JWT"}, separators=(",", ":")).encode())
        payload = _b64(json.dumps({
            "iss": gateway_id, "gateway_id": gateway_id, "kind": kind,
            "device_id": device_id, "user_id": user_id, "aud": audience,
            "jti": secrets.token_urlsafe(24), "iat": now, "exp": now + 60,
            **scope,
        }, separators=(",", ":"), sort_keys=True).encode())
        signing_input = f"{header}.{payload}"
        return f"{signing_input}.{_b64(self.private_key.sign(signing_input.encode()))}"

    def verify_device_access_ticket(self, ticket: str, *, gateway_id: str,
                                    audience: str) -> dict:
        claims = self.verify_access_ticket(ticket, gateway_id=gateway_id,
                                           audience=audience)
        if claims["kind"] != "device.access":
            raise ValueError("Invalid device access ticket")
        return claims

    def verify_access_ticket(self, ticket: str, *, gateway_id: str,
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
            if (not isinstance(claims, dict)
                    or claims.get("kind") not in ("device.access", "project.access")
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
            if claims["kind"] == "project.access" and (
                    not isinstance(claims.get("project_id"), str)
                    or not claims["project_id"] or len(claims["project_id"]) > 64
                    or not isinstance(claims.get("host_project_id"), str)
                    or not claims["host_project_id"] or len(claims["host_project_id"]) > 128
                    or claims.get("access_level") not in ("read", "edit")):
                raise ValueError("Invalid project ticket scope")
            return claims
        except (ValueError, TypeError, UnicodeDecodeError, json.JSONDecodeError,
                binascii.Error, InvalidSignature) as exc:
            raise ValueError("Invalid device access ticket") from exc

    def _provider_vault_key(self) -> bytes:
        raw = self.private_key.private_bytes(
            serialization.Encoding.Raw, serialization.PrivateFormat.Raw,
            serialization.NoEncryption(),
        )
        return HKDF(algorithm=hashes.SHA256(), length=32, salt=None,
                    info=b"workstep-provider-vault-v1").derive(raw)

    def encrypt_provider_secret(self, provider_id: str, secret: str) -> str:
        nonce = os.urandom(12)
        ciphertext = AESGCM(self._provider_vault_key()).encrypt(
            nonce, secret.encode(), provider_id.encode(),
        )
        return _b64(nonce + ciphertext)

    def decrypt_provider_secret(self, provider_id: str, encrypted: str) -> str:
        try:
            raw = base64.urlsafe_b64decode(encrypted + "===")
            if len(raw) < 29:
                raise ValueError("Invalid encrypted provider secret")
            return AESGCM(self._provider_vault_key()).decrypt(
                raw[:12], raw[12:], provider_id.encode(),
            ).decode()
        except (ValueError, UnicodeDecodeError, binascii.Error, InvalidTag) as exc:
            raise ValueError("Invalid encrypted provider secret") from exc

    def sign_provider_bundle(self, *, gateway_id: str, device_id: str, user_id: str,
                             revision: int, config_public_key_pem: str,
                             providers: list[dict], default_provider_id: str = "") -> str:
        recipient = serialization.load_pem_public_key(config_public_key_pem.encode())
        if not isinstance(recipient, X25519PublicKey):
            raise ValueError("Device config key must be X25519")
        if len(providers) > 100:
            raise ValueError("Too many managed providers")
        if (not isinstance(default_provider_id, str) or
                default_provider_id and default_provider_id not in {
                    provider.get("id") for provider in providers
                }):
            raise ValueError("Default provider is unavailable")
        plaintext = json.dumps({"providers": providers,
                                "default_provider_id": default_provider_id}, separators=(",", ":"),
                               sort_keys=True).encode()
        if len(plaintext) > 512 * 1024:
            raise ValueError("Managed provider bundle is too large")
        ephemeral = X25519PrivateKey.generate()
        shared = ephemeral.exchange(recipient)
        key = HKDF(algorithm=hashes.SHA256(), length=32, salt=None,
                   info=b"workstep-provider-device-v1").derive(shared)
        nonce = os.urandom(12)
        ciphertext = AESGCM(key).encrypt(
            nonce, plaintext, f"{gateway_id}:{device_id}:{user_id}:{revision}".encode(),
        )
        now = int(time.time())
        header = _b64(json.dumps({"alg": "EdDSA", "typ": "JWT"}, separators=(",", ":")).encode())
        payload = _b64(json.dumps({
            "iss": gateway_id, "kind": "provider.bundle", "gateway_id": gateway_id,
            "device_id": device_id, "user_id": user_id, "revision": revision,
            "iat": now, "exp": now + 600,
            "ephemeral_public_key": _b64(ephemeral.public_key().public_bytes(
                serialization.Encoding.Raw, serialization.PublicFormat.Raw,
            )),
            "nonce": _b64(nonce), "ciphertext": _b64(ciphertext),
        }, separators=(",", ":"), sort_keys=True).encode())
        signing_input = f"{header}.{payload}"
        return f"{signing_input}.{_b64(self.private_key.sign(signing_input.encode()))}"

    def sign_device_command(self, *, gateway_id: str, id: str, batch_id: str,
                            device_id: str, idempotency_key: str, action: str,
                            engine_id: str, version: str | None,
                            accept_third_party_terms: bool, expires_at: int,
                            reconcile_only: bool = False) -> str:
        now = int(time.time())
        if (action not in {"install", "update", "rollback", "refresh", "test"}
                or expires_at <= now or expires_at > now + 3600):
            raise ValueError("Invalid device command")
        header = _b64(b'{"alg":"EdDSA","typ":"JWT"}')
        payload = _b64(json.dumps({
            "iss": gateway_id, "gateway_id": gateway_id,
            "kind": "device.command.reconcile" if reconcile_only else "device.command",
            "command_id": id, "batch_id": batch_id, "device_id": device_id,
            "idempotency_key": idempotency_key, "action": action,
            "engine_id": engine_id, "version": version,
            "accept_third_party_terms": accept_third_party_terms,
            "iat": now, "exp": expires_at,
        }, separators=(",", ":"), sort_keys=True).encode())
        signing_input = f"{header}.{payload}"
        return f"{signing_input}.{_b64(self.private_key.sign(signing_input.encode()))}"

    def sign_skill_manifest(self, *, gateway_id: str, device_id: str,
                            user_id: str, projects: list[dict]) -> str:
        now = int(time.time())
        header = _b64(b'{"alg":"EdDSA","typ":"JWT"}')
        payload_raw = json.dumps({
            "iss": gateway_id, "gateway_id": gateway_id,
            "kind": "skill.manifest", "device_id": device_id,
            "user_id": user_id, "projects": projects,
            "iat": now, "exp": now + 600,
        }, separators=(",", ":"), sort_keys=True).encode()
        if len(payload_raw) > 512 * 1024:
            raise ValueError("Skill manifest too large")
        payload = _b64(payload_raw)
        signing_input = f"{header}.{payload}"
        return f"{signing_input}.{_b64(self.private_key.sign(signing_input.encode()))}"

    def verify_skill_manifest(self, token: str, *, gateway_id: str,
                              device_id: str | None = None,
                              user_id: str | None = None) -> dict:
        if not isinstance(token, str) or len(token) > 750 * 1024:
            raise ValueError("Invalid Skill manifest")
        try:
            header, payload, signature = token.split(".")
            if json.loads(base64.urlsafe_b64decode(header + "===")) != {
                "alg": "EdDSA", "typ": "JWT",
            }:
                raise ValueError("Invalid Skill manifest header")
            self.private_key.public_key().verify(
                base64.urlsafe_b64decode(signature + "==="),
                f"{header}.{payload}".encode(),
            )
            claims = json.loads(base64.urlsafe_b64decode(payload + "==="))
            now = int(time.time())
            if (not isinstance(claims, dict)
                    or claims.get("kind") != "skill.manifest"
                    or claims.get("iss") != gateway_id
                    or claims.get("gateway_id") != gateway_id
                    or (device_id is not None and claims.get("device_id") != device_id)
                    or (user_id is not None and claims.get("user_id") != user_id)
                    or not isinstance(claims.get("device_id"), str)
                    or not isinstance(claims.get("user_id"), str)
                    or not isinstance(claims.get("projects"), list)
                    or not isinstance(claims.get("iat"), int)
                    or not isinstance(claims.get("exp"), int)
                    or claims["iat"] > now + 5 or claims["exp"] <= now
                    or claims["exp"] - claims["iat"] > 600):
                raise ValueError("Invalid Skill manifest claims")
            return claims
        except (ValueError, TypeError, KeyError, UnicodeDecodeError,
                binascii.Error, json.JSONDecodeError, InvalidSignature) as exc:
            raise ValueError("Invalid Skill manifest") from exc
