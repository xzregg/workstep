"""Serializable engine-owned translation of WorkStep execution controls."""

from copy import deepcopy
from dataclasses import dataclass, field
from typing import Any
import json

NATIVE_PERMISSION_PREFIX = "native-permissions:v1:"


def encode_permission_selection(engine_id: str, values: dict) -> str:
    return NATIVE_PERMISSION_PREFIX + json.dumps(
        {"engine": engine_id, "values": values}, ensure_ascii=False, sort_keys=True,
        separators=(",", ":"),
    )


def decode_permission_selection(value: str) -> dict | None:
    if not value.startswith(NATIVE_PERMISSION_PREFIX):
        return None
    if len(value) > 16384:
        raise ValueError("Permission configuration is too long")
    try:
        selection = json.loads(value[len(NATIVE_PERMISSION_PREFIX):])
    except (ValueError, TypeError) as exc:
        raise ValueError("Invalid permission configuration format") from exc
    if (not isinstance(selection, dict) or set(selection) != {"engine", "values"}
            or not isinstance(selection["engine"], str) or not selection["engine"]
            or not isinstance(selection["values"], dict)
            or any(not isinstance(key, str) or type(item) not in (str, bool)
                   for key, item in selection["values"].items())):
        raise ValueError("Invalid permission configuration format")
    return selection


CHAT_PERMISSION_MODES = (
    "read-only", "workspace-write", "danger-full-access", "auto", "ask",
)


@dataclass(frozen=True)
class EnginePermissionPolicy:
    """Declare native config mappings in the adapter, including custom workers.

    The defaults cover the common ACP approval bridge only. Native execution
    restrictions require explicit adapter mappings; unknown modes never fall
    back silently. A declaration does not implement the underlying SDK policy.
    """

    overrides: dict[str, dict[str, Any]] = field(default_factory=lambda: {"auto": {}, "ask": {}})
    plan_overrides: dict[str, Any] = field(default_factory=dict)
    consent_key: str | None = None
    consent_values: dict[str, bool | None] = field(default_factory=dict)
    consent_default: str | None = None

    def __post_init__(self):
        if not isinstance(self.overrides, dict) or any(not isinstance(key, str) or not key for key in self.overrides):
            raise ValueError("Permission mapping must use a non-empty schema name")
        if any(not isinstance(value, dict) for value in self.overrides.values()):
            raise ValueError("Permission mapping must return a configuration object")
        if not isinstance(self.plan_overrides, dict):
            raise ValueError("Plan mode mapping must be a configuration object")
        if self.consent_key is not None and not isinstance(self.consent_key, str):
            raise ValueError("Approval configuration fields must be strings")
        if not isinstance(self.consent_values, dict) or any(
            not isinstance(key, str) or (value is not None and type(value) is not bool)
            for key, value in self.consent_values.items()
        ):
            raise ValueError("Approval configuration mapping must be a boolean or null")

    def permission_overrides(self, mode: str) -> dict:
        if not mode:
            return {}
        if mode not in self.overrides:
            raise ValueError(f"Current engine does not declare support for permission mode: {mode}")
        return deepcopy(self.overrides[mode])

    def configured_consent(self, config: dict) -> bool | None:
        if self.consent_key is None:
            return None
        value = config.get(self.consent_key, self.consent_default)
        return self.consent_values.get(value) if isinstance(value, str) else None
