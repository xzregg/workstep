"""Global config store — single ~/.workstep/config.json for all settings."""

import json
import logging
import os
import platform
import uuid
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

CONFIG_DIR = Path(
    os.environ.get("WORKSTEP_CONFIG_DIR") or Path.home() / ".workstep"
).expanduser()
CONFIG_FILE = CONFIG_DIR / "config.json"
DEFAULT_EXECUTION_ENGINE = "pydantic_ai"

CLAUDE_PERMISSION_MODES = {
    "acceptEdits",
    "auto",
    "bypassPermissions",
    "manual",
    "dontAsk",
    "plan",
}

CODEX_SANDBOX_MODES = {"read-only", "workspace-write", "danger-full-access"}
CODEX_REASONING_EFFORTS = {"auto", "minimal", "low", "medium", "high", "xhigh"}
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
        "engines": {"default": "pydantic_ai", ...}
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

    def get_model_pricing(self) -> dict[str, Any]:
        value = self.get("model_pricing", {})
        if not isinstance(value, dict):
            value = {}
        currency = value.get("currency")
        rate = value.get("usd_to_cny_rate")
        prices = value.get("prices")
        return {
            "currency": currency if currency in {"USD", "CNY"} else "USD",
            "usd_to_cny_rate": float(rate)
            if isinstance(rate, (int, float)) and not isinstance(rate, bool) and rate > 0
            else 7.2,
            "prices": prices if isinstance(prices, list) else [],
        }

    def set_model_pricing(self, pricing: dict[str, Any]) -> None:
        self.set("model_pricing", pricing)

    def get_coordinator_default_engine(self) -> str:
        value = self.get("coordinator_default_engine", "")
        return value if isinstance(value, str) else ""

    def get_execution_default_engine(self) -> str:
        value = self.get("execution_default_engine", "")
        return value if isinstance(value, str) else ""

    def set_execution_default_engine(self, engine: str) -> None:
        self.set("execution_default_engine", engine)

    def get_user_name(self) -> str:
        user = self.get("user", {})
        if not isinstance(user, dict):
            return ""
        name = user.get("name", "")
        return name.strip() if isinstance(name, str) else ""

    def set_user_name(self, name: str) -> None:
        user = self.get("user", {})
        if not isinstance(user, dict):
            user = {}
        user = dict(user)
        user["name"] = name.strip()
        self.set("user", user)

    def get_device_identity(self) -> dict[str, str]:
        """Return the stable identity of this WorkStep installation.

        The user-facing name and the device identity intentionally live in
        separate config sections: changing the current user's display name
        must not invalidate credentials previously issued to this device.
        """
        device = self.get("device", {})
        if not isinstance(device, dict):
            device = {}
        device_id = device.get("device_id")
        device_name = device.get("device_name")
        if not isinstance(device_id, str) or not device_id.strip():
            device_id = str(uuid.uuid4())
        if not isinstance(device_name, str) or not device_name.strip():
            device_name = platform.node().strip() or "WorkStep Device"
        normalized = {
            "device_id": device_id.strip(),
            "device_name": device_name.strip(),
        }
        if normalized != device:
            self.set("device", normalized)
        return normalized

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

    def get_coordinator_default_thinking_effort(self) -> str:
        value = self.get("coordinator_default_thinking_effort", "")
        return value if value in CODEX_REASONING_EFFORTS else ""

    def set_coordinator_defaults(
        self,
        engine: str,
        model: str = "",
        fast_model: str = "",
        vision_model: str = "",
        thinking_effort: str = "",
    ) -> None:
        if thinking_effort and thinking_effort not in CODEX_REASONING_EFFORTS:
            raise ValueError(f"Unsupported thinking effort: {thinking_effort}")
        self.set("coordinator_default_engine", engine)
        self.set("coordinator_default_model", model)
        self.set("coordinator_default_fast_model", fast_model)
        self.set("coordinator_default_vision_model", vision_model)
        self.set("coordinator_default_thinking_effort", thinking_effort)

    def get_assistant_defaults(self, name: str) -> dict:
        """Resolve one assistant's default engine/model settings.

        Every assistant falls back to the coordinator defaults; per-assistant
        overrides (``assistant_defaults.<name>``) win when set.
        """
        merged = {
            "engine": self.get_coordinator_default_engine(),
            "model": self.get_coordinator_default_model(),
            "fast_model": self.get_coordinator_default_fast_model(),
            "vision_model": self.get_coordinator_default_vision_model(),
            "thinking_effort": self.get_coordinator_default_thinking_effort(),
            "provider_id": "",
        }
        overrides = self.get("assistant_defaults", {})
        if not isinstance(overrides, dict):
            return merged
        overlay = overrides.get(name)
        if not isinstance(overlay, dict):
            return merged
        for key in (
            "engine",
            "model",
            "fast_model",
            "vision_model",
            "thinking_effort",
            "provider_id",
        ):
            value = overlay.get(key)
            if isinstance(value, str) and value.strip():
                merged[key] = value.strip()
        return merged

    def set_assistant_defaults(
        self,
        name: str,
        engine: str = "",
        model: str = "",
        fast_model: str = "",
        vision_model: str = "",
        thinking_effort: str = "",
        provider_id: str = "",
    ) -> None:
        """Save one assistant's defaults.

        ``task_coordinator`` keeps using the legacy coordinator keys so
        existing saved settings and the per-task coordinator config keep
        working; other assistants store per-name overrides that fall back to
        the coordinator defaults when empty. ``provider_id`` is the built-in
        engine's dynamic config override (empty = follow the engine config).
        """
        if name == "task_coordinator":
            self.set_coordinator_defaults(
                engine, model, fast_model, vision_model, thinking_effort
            )
            # 供应商是内置引擎的动态配置：单独存 overlay，走旧键的引擎/模型
            # 不受影响，读取时经 get_assistant_defaults 合并。
            overrides = self.get("assistant_defaults", {})
            if not isinstance(overrides, dict):
                overrides = {}
            overrides = dict(overrides)
            current = dict(overrides.get(name) or {})
            provider_id = (provider_id or "").strip()
            if provider_id:
                current["provider_id"] = provider_id
            else:
                current.pop("provider_id", None)
            if current:
                overrides[name] = current
            else:
                overrides.pop(name, None)
            self.set("assistant_defaults", overrides)
            return
        overrides = self.get("assistant_defaults", {})
        if not isinstance(overrides, dict):
            overrides = {}
        overrides = dict(overrides)
        current = dict(overrides.get(name) or {})
        for key, value in (
            ("engine", engine),
            ("model", model),
            ("fast_model", fast_model),
            ("vision_model", vision_model),
            ("thinking_effort", thinking_effort),
            ("provider_id", provider_id),
        ):
            value = (value or "").strip()
            if value:
                current[key] = value
            else:
                current.pop(key, None)
        if current:
            overrides[name] = current
        else:
            overrides.pop(name, None)
        self.set("assistant_defaults", overrides)

    def get_engine_idle_timeout_seconds(self) -> int:
        """Stage-level engine idle timeout in seconds; 0 disables the watchdog.

        When the engine produces no events for this long (e.g. a stalled API
        connection), the runner terminates it and fails the stage, preserving
        the session so a re-run can resume it.
        """
        value = self.get("engine_idle_timeout_seconds", 600)
        try:
            value = int(value)
        except (TypeError, ValueError):
            return 600
        return max(0, value)

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

    def get_pydantic_ai_engine_config(self) -> dict[str, Any]:
        raw = self.get("pydantic_ai_engine", {})
        if not isinstance(raw, dict):
            raw = {}
        return {
            "provider_id": raw.get("provider_id")
            or os.environ.get("PYDANTIC_AI_PROVIDER_ID", ""),
            "model": raw.get("model")
            or self.get_engine_default_model("pydantic_ai")
            or os.environ.get("PYDANTIC_AI_MODEL", ""),
            "mcp_servers": raw.get("mcp_servers") or [],
            "harness": raw.get("harness") or "auto",
        }

    def set_pydantic_ai_engine_config(
        self,
        *,
        provider_id: str,
        model: str,
        mcp_servers: list | None = None,
        harness: str = "auto",
    ) -> None:
        self.set(
            "pydantic_ai_engine",
            {
                "provider_id": provider_id,
                "model": model,
                "mcp_servers": list(mcp_servers or []),
                "harness": harness,
            },
        )
        self.set_engine_default_model("pydantic_ai", model)

    def get_deepseek_harness_config(self) -> dict[str, Any]:
        """Return the official DeepSeek Harness SDK adapter configuration."""
        raw = self.get("deepseek_harness_engine", {})
        if not isinstance(raw, dict):
            raw = {}
        preset = str(raw.get("preset") or "standard")
        return {
            "provider_id": str(raw.get("provider_id") or ""),
            "model": str(
                raw.get("model")
                or self.get_engine_default_model("deepseek_harness")
                or "deepseek-v4-flash"
            ),
            "max_tokens": str(raw.get("max_tokens") or ""),
            "preset": preset if preset == "standard" else "standard",
        }

    def set_deepseek_harness_config(
        self,
        *,
        provider_id: str,
        model: str,
        max_tokens: str = "",
        preset: str = "standard",
    ) -> None:
        self.set(
            "deepseek_harness_engine",
            {
                "provider_id": str(provider_id or "").strip(),
                "model": str(model or "").strip() or "deepseek-v4-flash",
                "max_tokens": str(max_tokens or "").strip(),
                "preset": str(preset or "").strip() or "standard",
            },
        )
        self.set_engine_default_model(
            "deepseek_harness",
            str(model or "").strip() or "deepseek-v4-flash",
        )

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
        }

    def set_claude_agent_sdk_config(
        self,
        max_turns: str = "",
        permission_mode: str | None = None,
        fallback_model: str = "",
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


    # --- Providers (global LLM API suppliers) ---

    def get_providers(self) -> list[dict[str, Any]]:
        raw = self.get("providers", [])
        if not isinstance(raw, list):
            return []
        return [dict(item) for item in raw if isinstance(item, dict)]

    def get_provider(self, provider_id: str) -> dict[str, Any] | None:
        for item in self.get_providers():
            if item.get("id") == provider_id:
                return item
        return None

    def save_provider(self, provider: dict[str, Any]) -> dict[str, Any]:
        providers = self.get_providers()
        provider_id = str(provider.get("id") or "")
        replaced = False
        for index, item in enumerate(providers):
            if item.get("id") == provider_id:
                providers[index] = provider
                replaced = True
                break
        if not replaced:
            providers.append(provider)
        self.set("providers", providers)
        return dict(provider)

    def get_prompt_enhance_config(self) -> dict[str, str]:
        """Provider + model used by the one-shot prompt enhancement."""
        raw = self.get("prompt_enhance", {})
        if not isinstance(raw, dict):
            raw = {}
        return {
            "provider_id": str(raw.get("provider_id") or ""),
            "model": str(raw.get("model") or ""),
        }

    def set_prompt_enhance_config(self, *, provider_id: str, model: str) -> None:
        """Save the prompt enhancement provider + model (empty clears)."""
        self.set("prompt_enhance", {
            "provider_id": str(provider_id or "").strip(),
            "model": str(model or "").strip(),
        })

    def delete_provider(self, provider_id: str) -> bool:
        providers = self.get_providers()
        remaining = [item for item in providers if item.get("id") != provider_id]
        if len(remaining) == len(providers):
            return False
        self.set("providers", remaining)
        return True

    def is_provider_in_use(self, provider_id: str) -> bool:
        """Whether an API-driven engine currently uses this provider."""
        for section in ("pydantic_ai_engine", "deepseek_harness_engine"):
            raw = self.get(section, {})
            if (
                isinstance(raw, dict)
                and bool(raw.get("provider_id"))
                and raw.get("provider_id") == provider_id
            ):
                return True
        return False

    # --- Provider model list cache (global config, not per-project DB) ---

    def get_provider_models(self, provider_id: str) -> dict:
        """Saved model list for a provider: ``{"models": [...], "fetched_at": ...}``.

        Stored in the global ``~/.workstep/config.json`` so model dropdowns never
        hit the provider address again after the first fetch.
        """
        cache = self.get("provider_models", {})
        if not isinstance(cache, dict):
            return {}
        entry = cache.get(provider_id)
        return dict(entry) if isinstance(entry, dict) else {}

    def set_provider_models(
        self,
        provider_id: str,
        models: list[dict],
        fetched_at: str,
    ) -> None:
        cache = self.get("provider_models", {})
        if not isinstance(cache, dict):
            cache = {}
        cache = dict(cache)
        cache[provider_id] = {
            "models": models,
            "fetched_at": fetched_at,
        }
        self.set("provider_models", cache)

    def clear_provider_models(self, provider_id: str) -> None:
        cache = self.get("provider_models", {})
        if not isinstance(cache, dict) or provider_id not in cache:
            return
        cache = dict(cache)
        cache.pop(provider_id, None)
        self.set("provider_models", cache)

    def migrate_legacy_config(self) -> None:
        """One-time migration after removing the ``api`` (API/BYOK) engine."""
        data = self._load()
        changed = False
        for key in ("execution_default_engine", "coordinator_default_engine"):
            if data.get(key) == "api":
                data[key] = ""
                changed = True
        if "api_engine" in data:
            del data["api_engine"]
            changed = True
        defaults = data.get("engine_default_models")
        if isinstance(defaults, dict) and "api" in defaults:
            defaults.pop("api", None)
            changed = True
        verified = data.get("verified_engines")
        if isinstance(verified, dict) and "api" in verified:
            verified.pop("api", None)
            changed = True
        if changed:
            self._save()


# Global singleton
config_store = ConfigStore()
