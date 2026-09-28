"""Verify a Gateway-issued, task-scoped visitor ticket on the managed device."""

import base64
import hashlib
import json
import time

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey


def _decode(part: str) -> bytes:
    if not part or len(part) > 8192 or any(
        char not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"
        for char in part
    ):
        raise ValueError("Invalid share ticket encoding")
    return base64.urlsafe_b64decode(part + "===")


def verify_share_ticket(ticket: str, public_key_pem: str,
                        expected_fingerprint: str, gateway_id: str,
                        device_id: str) -> dict[str, str]:
    """Return only the authorized scope; reject malformed or stale credentials."""
    try:
        if not isinstance(ticket, str) or len(ticket) > 8192:
            raise ValueError("Invalid share ticket")
        public_key = serialization.load_pem_public_key(public_key_pem.encode())
        if not isinstance(public_key, Ed25519PublicKey):
            raise ValueError("Invalid share signing key")
        der = public_key.public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        if hashlib.sha256(der).hexdigest() != expected_fingerprint:
            raise ValueError("Unpinned share signing key")
        header, payload, signature = ticket.split(".")
        if json.loads(_decode(header)) != {"alg": "EdDSA", "typ": "JWT"}:
            raise ValueError("Invalid share ticket algorithm")
        public_key.verify(_decode(signature), f"{header}.{payload}".encode())
        claims = json.loads(_decode(payload))
        now = int(time.time())
        if (not isinstance(claims, dict) or claims.get("kind") != "platform.share"
                or claims.get("iss") != gateway_id
                or claims.get("gateway_id") != gateway_id
                or claims.get("aud") != device_id
                or claims.get("device_id") != device_id
                or type(claims.get("iat")) is not int
                or type(claims.get("exp")) is not int
                or claims["iat"] > now + 5 or claims["exp"] <= now
                or claims["exp"] - claims["iat"] > 60
                or not isinstance(claims.get("jti"), str)
                or len(claims["jti"]) < 20
                or claims.get("mode") not in ("read_only", "interactive")):
            raise ValueError("Invalid share ticket claims")
        scope = {}
        for name, limit in (("share_id", 128), ("project_id", 64),
                            ("host_project_id", 128), ("task_id", 128)):
            value = claims.get(name)
            if (not isinstance(value, str) or not value or len(value) > limit
                    or not value[0].isalnum()
                    or any(not (char.isascii() and (char.isalnum() or char in "_-"))
                           for char in value)):
                raise ValueError("Invalid share ticket scope")
            scope[name] = value
        scope["mode"] = claims["mode"]
        return scope
    except (InvalidSignature, UnicodeError, TypeError, KeyError, json.JSONDecodeError,
            ValueError) as exc:
        raise ValueError("Invalid Gateway share ticket") from exc
