"""Persistent Gateway Ed25519 key for device-scoped authorization."""

import base64
import hashlib
import json
import os
import time
from pathlib import Path

from cryptography.hazmat.primitives import serialization
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
                                  username: str, app_instance_id: str,
                                  policy_revision: int = 0) -> str:
        now = int(time.time())
        header = _b64(json.dumps({"alg": "EdDSA", "typ": "JWT"}, separators=(",", ":")).encode())
        payload = _b64(json.dumps({
            "iss": gateway_id, "gateway_id": gateway_id, "device_id": device_id,
            "user_id": user_id, "username": username,
            "app_instance_id": app_instance_id, "policy_revision": policy_revision,
            "iat": now, "exp": now + 900,
        }, separators=(",", ":"), sort_keys=True).encode())
        signing_input = f"{header}.{payload}"
        return f"{signing_input}.{_b64(self.private_key.sign(signing_input.encode()))}"
