"""Pinned verification and decryption of managed provider bundles."""

import base64
import binascii
import hashlib
import json
import time
from dataclasses import dataclass

from cryptography.exceptions import InvalidSignature, InvalidTag
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF


def _decode(value: str) -> bytes:
    if (not isinstance(value, str) or not value or len(value) > 1024 * 1024
            or any(c not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-" for c in value)):
        raise ValueError("Invalid provider bundle encoding")
    return base64.urlsafe_b64decode(value + "===")


@dataclass(frozen=True)
class ManagedProviderBundle:
    revision: int
    providers: list[dict]
    default_provider_id: str


def verify_provider_bundle(token: str, public_key_pem: str, expected_fingerprint: str,
                           gateway_id: str, device_id: str, user_id: str,
                           recipient_private_key: X25519PrivateKey,
                           *, current_revision: int) -> ManagedProviderBundle:
    try:
        if not isinstance(token, str) or len(token) > 1024 * 1024:
            raise ValueError("Provider bundle too large")
        public_key = serialization.load_pem_public_key(public_key_pem.encode())
        if not isinstance(public_key, Ed25519PublicKey):
            raise ValueError("Gateway provider key must be Ed25519")
        fingerprint = hashlib.sha256(public_key.public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo,
        )).hexdigest()
        if fingerprint != expected_fingerprint:
            raise ValueError("Gateway provider key mismatch")
        header, payload, signature = token.split(".")
        if json.loads(_decode(header)) != {"alg": "EdDSA", "typ": "JWT"}:
            raise ValueError("Invalid provider bundle algorithm")
        public_key.verify(_decode(signature), f"{header}.{payload}".encode())
        claims = json.loads(_decode(payload))
        now = int(time.time())
        if (not isinstance(claims, dict) or claims.get("iss") != gateway_id
                or claims.get("gateway_id") != gateway_id
                or claims.get("kind") != "provider.bundle"
                or claims.get("device_id") != device_id or claims.get("user_id") != user_id
                or type(claims.get("revision")) is not int
                or claims["revision"] < current_revision
                or type(claims.get("iat")) is not int
                or type(claims.get("exp")) is not int
                or claims["iat"] > now + 60 or claims["exp"] <= now
                or claims["exp"] - claims["iat"] > 600):
            raise ValueError("Provider bundle scope or lifetime invalid")
        ephemeral_raw = _decode(claims["ephemeral_public_key"])
        nonce = _decode(claims["nonce"])
        ciphertext = _decode(claims["ciphertext"])
        if len(ephemeral_raw) != 32 or len(nonce) != 12 or len(ciphertext) < 16:
            raise ValueError("Invalid encrypted provider bundle")
        ephemeral = X25519PublicKey.from_public_bytes(ephemeral_raw)
        shared = recipient_private_key.exchange(ephemeral)
        key = HKDF(algorithm=hashes.SHA256(), length=32, salt=None,
                   info=b"workstep-provider-device-v1").derive(shared)
        plaintext = AESGCM(key).decrypt(
            nonce, ciphertext,
            f"{gateway_id}:{device_id}:{user_id}:{claims['revision']}".encode(),
        )
        data = json.loads(plaintext)
        providers = data.get("providers") if isinstance(data, dict) else None
        if (not isinstance(providers, list) or len(providers) > 100
                or any(not isinstance(provider, dict) for provider in providers)):
            raise ValueError("Invalid managed provider catalog")
        default_provider_id = data.get("default_provider_id", "")
        if (not isinstance(default_provider_id, str)
                or default_provider_id and default_provider_id not in {
                    provider.get("id") for provider in providers
                }):
            raise ValueError("Invalid managed default provider")
        return ManagedProviderBundle(revision=claims["revision"], providers=providers,
                                     default_provider_id=default_provider_id)
    except (InvalidSignature, InvalidTag, KeyError, TypeError, ValueError,
            UnicodeError, json.JSONDecodeError, binascii.Error) as exc:
        raise ValueError("Invalid Gateway provider bundle") from exc
