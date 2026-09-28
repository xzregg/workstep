"""Regenerate or verify the checked-in wire schema."""

import json
import sys
from pathlib import Path

from workstep_gateway_protocol import (
    PROTOCOL_VERSION,
    ControlEnvelope,
    Handshake,
    ProxyFrame,
    ManagedGatewayPayload,
    SignedManagedGatewayConfig,
)

SCHEMA = Path(__file__).resolve().parents[1] / "schema.json"


def render() -> str:
    schemas = {
        model.__name__: model.model_json_schema()
        for model in (Handshake, ControlEnvelope, ProxyFrame, ManagedGatewayPayload, SignedManagedGatewayConfig)
    }
    return json.dumps({"protocol_version": PROTOCOL_VERSION, "models": schemas}, indent=2, sort_keys=True) + "\n"


if __name__ == "__main__":
    expected = render()
    if "--check" in sys.argv:
        if not SCHEMA.exists() or SCHEMA.read_text() != expected:
            raise SystemExit("Gateway protocol schema is stale; run scripts/schema.py")
    else:
        SCHEMA.write_text(expected)
