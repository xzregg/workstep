"""Read a signed, installation-owned managed Gateway bundle."""

import base64
import hashlib
import hmac
import json
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from workstep_gateway_protocol import (
    PROTOCOL_VERSION,
    ManagedGatewayPayload,
    SignedManagedGatewayConfig,
)


class InvalidManagedGatewayConfig(ValueError):
    pass


def load_managed_config(bundle_dir: Path, expected_root_fingerprint: str | None) -> ManagedGatewayPayload | None:
    if not bundle_dir.exists():
        if expected_root_fingerprint:
            raise InvalidManagedGatewayConfig("Managed Gateway bundle is missing")
        return None
    try:
        document = json.loads((bundle_dir / "managed-gateway.json").read_text())
        signed = SignedManagedGatewayConfig.model_validate(document)
        encoded = json.dumps(
            signed.payload.model_dump(), sort_keys=True, separators=(",", ":"),
        ).encode()
        public_key = serialization.load_pem_public_key(
            (bundle_dir / "managed-root.pem").read_bytes()
        )
        if not isinstance(public_key, Ed25519PublicKey):
            raise ValueError("unsupported managed bundle signing key")
        fingerprint = hashlib.sha256(public_key.public_bytes(
            encoding=serialization.Encoding.DER,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        )).hexdigest()
        if not expected_root_fingerprint or not hmac.compare_digest(fingerprint, expected_root_fingerprint):
            raise ValueError("managed package signing root pin mismatch")
        public_key.verify(base64.b64decode(signed.signature, validate=True), encoded)
        if signed.payload.min_protocol_version > PROTOCOL_VERSION:
            raise ValueError("managed bundle requires a newer Gateway protocol")
        return signed.payload
    except Exception as exc:
        raise InvalidManagedGatewayConfig("Invalid signed managed Gateway bundle") from exc
