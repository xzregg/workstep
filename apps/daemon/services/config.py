"""Global config store — single ~/.workstep/config.json for all settings."""

import json
import logging
import os
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

CONFIG_DIR = Path.home() / ".workstep"
CONFIG_FILE = CONFIG_DIR / "config.json"

CLAUDE_PERMISSION_MODES = {
    "acceptEdits",
    "auto",
    "bypassPermissions",
    "manual",
    "dontAsk",
    "plan",
}

CODEX_SANDBOX_MODES = {"read-only", "workspace-write", "danger-full-access"}
CODEX_REASONING_EFFORTS = {"minimal", "low", "medium", "high"}
CODEX_APPROVAL_POLICIES = {"never", "on-failure", "on-request", "full-auto"}
CODEX_SDK_APPROVAL_MODES = {"auto_review", "deny_all"}

QODER_PERMISSION_MODES = {
    "default",
    "acceptEdits",
    "bypassPermissions",
    "plan",
    "dontAsk",
    "auto",
}


class ConfigStore:
    """Centralized config read/write for ~/.workstep/config.json.

    Structure:
    {
        "projects": {"/path/to/proj": "显示名称"},
        "daemon": {"port": 8765, ...},
        "engines": {"default": "claude", ...}
    }
    """

    def __init__(self):
        self._cache: dict[str, Any] | None = None

    def _load(self) -> dict:
        if self._cache is not None:
            return self._cache
        if not CONFIG_FILE.exists():
            self._cache = {}
            return self._cache
        try:
            self._cache = json.loads(CONFIG_FILE.read_text())
        except Exception as e:
            logger.warning("Failed to load config: %s", e)
            self._cache = {}
        return self._cache

    def _save(self):
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        CONFIG_FILE.write_text(json.dumps(self._cache, ensure_ascii=False, indent=2))
        CONFIG_FILE.chmod(0o600)

    def get(self, key: str, default: Any = None) -> Any:
        """Get a config section."""
        return self._load().get(key, default)

    def set(self, key: str, value: Any):
        """Set a config section and persist."""
        data = self._load()
        data[key] = value
        self._save()

    def delete(self, key: str):
        """Remove a config section and persist."""
        data = self._load()
        if key in data:
            del data[key]
            self._save()

    def invalidate(self):
        """Clear cache, force reload on next access."""
        self._cache = None

    def get_engine_default_model(self, engine_id: str) -> str:
        defaults = self.get("engine_default_models", {})
        if not isinstance(defaults, dict):
            return ""
        value = defaults.get(engine_id, "")
        return value if isinstance(value, str) else ""

    def set_engine_default_model(self, engine_id: str, model: str):
        defaults = self.get("engine_default_models", {})
        if not isinstance(defaults, dict):
            defaults = {}
        defaults = dict(defaults)
        if model:
            defaults[engine_id] = model
        else:
            defaults.pop(engine_id, None)
        self.set("engine_default_models", defaults)

    def get_coordinator_default_engine(self) -> str:
        value = self.get("coordinator_default_engine", "")
        return value if isinstance(value, str) else ""

    def get_execution_default_engine(self) -> str:
        value = self.get("execution_default_engine", "")
        return value if isinstance(value, str) else ""

    def set_execution_default_engine(self, engine: str) -> None:
        self.set("execution_default_engine", engine)

    def is_engine_verified(self, engine_id: str) -> bool:
        verified = self.get("verified_engines", {})
        return isinstance(verified, dict) and verified.get(engine_id) is True

    def set_engine_verified(self, engine_id: str, verified: bool) -> None:
        values = self.get("verified_engines", {})
        if not isinstance(values, dict):
            values = {}
        values = dict(values)
        if verified:
            values[engine_id] = True
        else:
            values.pop(engine_id, None)
        self.set("verified_engines", values)

    def get_coordinator_default_model(self) -> str:
        value = self.get("coordinator_default_model", "")
        return value if isinstance(value, str) else ""

    def get_coordinator_default_fast_model(self) -> str:
        value = self.get("coordinator_default_fast_model", "")
        return value if isinstance(value, str) else ""

    def get_coordinator_default_vision_model(self) -> str:
        value = self.get("coordinator_default_vision_model", "")
        return value if isinstance(value, str) else ""

    def set_coordinator_defaults(
        self,
        engine: str,
        model: str = "",
        fast_model: str = "",
        vision_model: str = "",
    ) -> None:
        self.set("coordinator_default_engine", engine)
        self.set("coordinator_default_model", model)
        self.set("coordinator_default_fast_model", fast_model)
        self.set("coordinator_default_vision_model", vision_model)

    def get_engine_binary_path(self, engine_id: str) -> str:
        paths = self.get("engine_binary_paths", {})
        if not isinstance(paths, dict):
            return ""
        value = paths.get(engine_id, "")
        return value if isinstance(value, str) else ""

    def set_engine_binary_path(self, engine_id: str, path: str):
        paths = self.get("engine_binary_paths", {})
        if not isinstance(paths, dict):
            paths = {}
        paths = dict(paths)
        if path:
            paths[engine_id] = path
        else:
            paths.pop(engine_id, None)
        self.set("engine_binary_paths", paths)

    def get_api_engine_config(self) -> dict[str, Any]:
        raw = self.get("api_engine", {})
        if not isinstance(raw, dict):
            raw = {}
        provider = raw.get("provider") or os.environ.get("API_PROVIDER", "openai")
        if provider not in {"openai", "anthropic"}:
            provider = "openai"
        default_base_url = (
            "https://api.anthropic.com/v1"
            if provider == "anthropic"
            else "https://api.openai.com/v1"
        )
        return {
            "provider": provider,
            "base_url": raw.get("base_url")
            or os.environ.get("API_BASE", default_base_url),
            "api_key": raw.get("api_key")
            or os.environ.get("API_KEY")
            or os.environ.get("OPENAI_API_KEY", ""),
            "model": raw.get("model")
            or self.get_engine_default_model("api")
            or os.environ.get("API_MODEL", ""),
        }

    def set_api_engine_config(
        self,
        *,
        provider: str,
        base_url: str,
        api_key: str | None,
        model: str,
    ) -> None:
        current = self.get_api_engine_config()
        self.set(
            "api_engine",
            {
                "provider": provider,
                "base_url": base_url,
                "api_key": current["api_key"] if api_key is None else api_key,
                "model": model,
            },
        )
        self.set_engine_default_model("api", model)

    def get_pydantic_ai_engine_config(self) -> dict[str, Any]:
        raw = self.get("pydantic_ai_engine", {})
        if not isinstance(raw, dict):
            raw = {}
        provider = raw.get("provider") or os.environ.get(
            "PYDANTIC_AI_PROVIDER", "openai"
        )
        if provider not in {"openai", "anthropic"}:
            provider = "openai"
        default_base_url = (
            "https://api.anthropic.com/v1"
            if provider == "anthropic"
            else "https://api.openai.com/v1"
        )
        return {
            "provider": provider,
            "base_url": raw.get("base_url")
            or os.environ.get("PYDANTIC_AI_BASE_URL", default_base_url),
            "api_key": raw.get("api_key")
            or os.environ.get("PYDANTIC_AI_API_KEY", ""),
            "model": raw.get("model")
            or self.get_engine_default_model("pydantic_ai")
            or os.environ.get("PYDANTIC_AI_MODEL", ""),
        }

    def set_pydantic_ai_engine_config(
        self,
        *,
        provider: str,
        base_url: str,
        api_key: str | None,
        model: str,
    ) -> None:
        current = self.get_pydantic_ai_engine_config()
        self.set(
            "pydantic_ai_engine",
            {
                "provider": provider,
                "base_url": base_url,
                "api_key": current["api_key"] if api_key is None else api_key,
                "model": model,
            },
        )
        self.set_engine_default_model("pydantic_ai", model)

    def get_claude_permission_mode(self) -> str:
        mode = self.get("claude_permission_mode", "")
        return mode if mode in CLAUDE_PERMISSION_MODES else ""

    def set_claude_permission_mode(self, mode: str):
        if mode not in CLAUDE_PERMISSION_MODES:
            raise ValueError(f"Unsupported Claude permission mode: {mode}")
        self.set("claude_permission_mode", mode)

    # --- Claude Agent SDK config ---

    def get_claude_agent_sdk_config(self) -> dict[str, Any]:
        raw = self.get("claude_agent_sdk_engine", {})
        if not isinstance(raw, dict):
            raw = {}
        max_turns = raw.get("max_turns", "")
        return {
            "permission_mode": self.get_claude_permission_mode(),
            "max_turns": str(max_turns) if max_turns not in (None, "") else "",
            "fallback_model": str(raw.get("fallback_model", "") or ""),
            "max_budget_usd": str(raw.get("max_budget_usd", "") or ""),
        }

    def set_claude_agent_sdk_config(
        self,
        max_turns: str = "",
        permission_mode: str | None = None,
        fallback_model: str = "",
        max_budget_usd: str = "",
    ) -> None:
        if permission_mode is not None:
            self.set_claude_permission_mode(permission_mode)
        raw = self.get("claude_agent_sdk_engine", {})
        if not isinstance(raw, dict):
            raw = {}
        raw = dict(raw)
        max_turns = str(max_turns or "").strip()
        if max_turns:
            try:
                value = int(max_turns)
            except ValueError:
                raise ValueError("最大轮数必须是正整数")
            if value <= 0:
                raise ValueError("最大轮数必须是正整数")
            raw["max_turns"] = value
        else:
            raw.pop("max_turns", None)
        fallback_model = str(fallback_model or "").strip()
        if fallback_model:
            raw["fallback_model"] = fallback_model
        else:
            raw.pop("fallback_model", None)
        budget = str(max_budget_usd or "").strip()
        if budget:
            try:
                budget_value = float(budget)
            except ValueError:
                raise ValueError("美元预算必须是数字")
            if budget_value <= 0:
                raise ValueError("美元预算必须大于 0")
            raw["max_budget_usd"] = budget_value
        else:
            raw.pop("max_budget_usd", None)
        self.set("claude_agent_sdk_engine", raw)

    # --- Codex CLI config ---

    def get_codex_config(self) -> dict[str, str]:
        raw = self.get("codex_engine", {})
        if not isinstance(raw, dict):
            raw = {}
        return {
            "sandbox_mode": raw.get("sandbox_mode", "workspace-write"),
            "model_reasoning_effort": raw.get("model_reasoning_effort", ""),
            "approval_policy": raw.get("approval_policy", ""),
        }

    def set_codex_config(
        self,
        sandbox_mode: str = "",
        model_reasoning_effort: str = "",
        approval_policy: str = "",
    ) -> None:
        sandbox_mode = str(sandbox_mode or "").strip() or "workspace-write"
        if sandbox_mode not in CODEX_SANDBOX_MODES:
            raise ValueError("不支持的沙箱模式")
        effort = str(model_reasoning_effort or "").strip()
        if effort and effort not in CODEX_REASONING_EFFORTS:
            raise ValueError("不支持的推理强度")
        policy = str(approval_policy or "").strip()
        if policy and policy not in CODEX_APPROVAL_POLICIES:
            raise ValueError("不支持的审批策略")
        self.set("codex_engine", {
            "sandbox_mode": sandbox_mode,
            "model_reasoning_effort": effort,
            "approval_policy": policy,
        })

    # --- Qoder Agent SDK config ---

    def get_qoder_sdk_config(self) -> dict[str, Any]:
        raw = self.get("qoder_sdk_engine", {})
        if not isinstance(raw, dict):
            raw = {}
        return {
            "personal_access_token": raw.get("personal_access_token")
            or os.environ.get("QODER_PERSONAL_ACCESS_TOKEN", ""),
            "permission_mode": raw.get("permission_mode") or "default",
            "model": raw.get("model")
            or self.get_engine_default_model("qoder_sdk")
            or "",
            "allowed_tools": str(raw.get("allowed_tools") or ""),
            "max_turns": str(raw.get("max_turns") or ""),
            "include_partial_messages": raw.get("include_partial_messages", True),
        }

    def set_qoder_sdk_config(
        self,
        *,
        personal_access_token: str | None = None,
        permission_mode: str = "default",
        model: str = "",
        allowed_tools: str = "",
        max_turns: str = "",
        include_partial_messages: bool = True,
    ) -> None:
        raw = self.get("qoder_sdk_engine", {})
        if not isinstance(raw, dict):
            raw = {}
        raw = dict(raw)
        if personal_access_token is not None:
            token = str(personal_access_token).strip()
            if token:
                raw["personal_access_token"] = token
            else:
                raw.pop("personal_access_token", None)
        permission_mode = str(permission_mode or "").strip() or "default"
        if permission_mode not in QODER_PERMISSION_MODES:
            raise ValueError(f"Unsupported Qoder permission mode: {permission_mode}")
        raw["permission_mode"] = permission_mode
        model = str(model or "").strip()
        if model:
            raw["model"] = model
        else:
            raw.pop("model", None)
        allowed_tools = str(allowed_tools or "").strip()
        if allowed_tools:
            raw["allowed_tools"] = allowed_tools
        else:
            raw.pop("allowed_tools", None)
        max_turns = str(max_turns or "").strip()
        if max_turns:
            try:
                value = int(max_turns)
            except ValueError:
                raise ValueError("最大轮数必须是正整数")
            if value <= 0:
                raise ValueError("最大轮数必须是正整数")
            raw["max_turns"] = value
        else:
            raw.pop("max_turns", None)
        raw["include_partial_messages"] = bool(include_partial_messages)
        self.set("qoder_sdk_engine", raw)

    # --- Codex Agent SDK config ---

    def get_codex_sdk_config(self) -> dict[str, str]:
        raw = self.get("codex_sdk_engine", {})
        if not isinstance(raw, dict):
            raw = {}
        return {
            "model_reasoning_effort": raw.get("model_reasoning_effort", ""),
            "approval_mode": raw.get("approval_mode", ""),
            "sandbox": raw.get("sandbox", "workspace-write"),
        }

    def set_codex_sdk_config(
        self,
        model_reasoning_effort: str = "",
        approval_mode: str = "",
        sandbox: str = "",
    ) -> None:
        effort = str(model_reasoning_effort or "").strip()
        if effort and effort not in CODEX_REASONING_EFFORTS:
            raise ValueError("不支持的推理强度")
        mode = str(approval_mode or "").strip()
        if mode and mode not in CODEX_SDK_APPROVAL_MODES:
            raise ValueError("不支持的审批模式")
        sandbox = str(sandbox or "").strip() or "workspace-write"
        if sandbox not in CODEX_SANDBOX_MODES:
            raise ValueError("不支持的沙箱模式")
        self.set("codex_sdk_engine", {
            "model_reasoning_effort": effort,
            "approval_mode": mode,
            "sandbox": sandbox,
        })


# Global singleton
config_store = ConfigStore()
