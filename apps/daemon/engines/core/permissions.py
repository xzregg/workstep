"""Serializable engine-owned translation of WorkStep execution controls."""

from copy import deepcopy
from dataclasses import dataclass, field
from typing import Any


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
        if not isinstance(self.overrides, dict) or set(self.overrides) - set(CHAT_PERMISSION_MODES):
            raise ValueError("权限映射包含未知模式")
        if any(not isinstance(value, dict) for value in self.overrides.values()):
            raise ValueError("权限映射必须返回配置对象")
        if not isinstance(self.plan_overrides, dict):
            raise ValueError("计划模式映射必须为配置对象")
        if self.consent_key is not None and not isinstance(self.consent_key, str):
            raise ValueError("审批配置字段必须为字符串")
        if not isinstance(self.consent_values, dict) or any(
            not isinstance(key, str) or (value is not None and type(value) is not bool)
            for key, value in self.consent_values.items()
        ):
            raise ValueError("审批配置映射必须为布尔值或 null")

    def permission_overrides(self, mode: str) -> dict:
        if not mode:
            return {}
        if mode not in self.overrides:
            raise ValueError(f"当前引擎未声明支持权限模式：{mode}")
        return deepcopy(self.overrides[mode])

    def configured_consent(self, config: dict) -> bool | None:
        if self.consent_key is None:
            return None
        value = config.get(self.consent_key, self.consent_default)
        return self.consent_values.get(value) if isinstance(value, str) else None
