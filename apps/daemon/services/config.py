"""Global config store — single ~/.workstep/config.json for all settings."""

import json
import hashlib
import copy
import logging
import locale
import os
import platform
from functools import wraps
import threading
import uuid
from pathlib import Path
from urllib.parse import urlsplit
from typing import Any

logger = logging.getLogger(__name__)

CONFIG_DIR = Path(
    os.environ.get("WORKSTEP_CONFIG_DIR") or Path.home() / ".workstep"
).expanduser()
CONFIG_FILE = CONFIG_DIR / "config.json"
DEFAULT_EXECUTION_ENGINE = "pydantic_ai"


def resolve_execution_engine(engine_id: str | None) -> str:
    """Resolve an optional per-step engine to the current global default."""
    normalized = str(engine_id or "").strip()
    get_default = getattr(config_store, "get_execution_default_engine", None)
    return (
        normalized
        or (get_default() if callable(get_default) else "")
        or DEFAULT_EXECUTION_ENGINE
    )

from services.provider_protocols import PROVIDER_PROTOCOLS


def default_provider_protocols(type_id: str) -> list[str]:
    """Return the default wire-protocol list for one provider preset.

    一个 ``base_url`` 可能同时说多种协议；列表顺序即默认偏好，首项是
    向后兼容的单值 ``protocol``。
    """
    if type_id == "anthropic":
        return ["anthropic_messages"]
    if type_id == "openai":
        return ["openai_responses", "openai_chat_completions"]
    if type_id == "custom":
        return ["openai_chat_completions", "openai_responses"]
    return ["openai_chat_completions"]


def default_provider_protocol(type_id: str) -> str:
    """Return the backward-compatible (first) protocol for one preset."""
    return default_provider_protocols(type_id)[0]


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
        self._lock = threading.RLock()
        self._managed_gateway_id: str | None = None
        self._managed_provider_guard = None

    def _load(self) -> dict:
        with self._lock:
            if self._cache is not None:
                return self._cache
            if not CONFIG_FILE.exists():
                self._cache = {}
                return self._cache
            try:
                try:
                    text = CONFIG_FILE.read_text(encoding="utf-8")
                except UnicodeDecodeError:
                    # Pre-UTF-8 Windows versions used the machine's locale.
                    # Preserve those settings; the next save migrates to UTF-8.
                    text = CONFIG_FILE.read_text(encoding=locale.getencoding())
                self._cache = json.loads(text)
            except Exception as e:
                logger.warning("Failed to load config: %s", e)
                self._cache = {}
            return self._cache

    def _save(self):
        with self._lock:
            CONFIG_DIR.mkdir(parents=True, exist_ok=True)
            temporary = CONFIG_FILE.with_name(
                f".{CONFIG_FILE.name}.{os.getpid()}.{threading.get_ident()}.tmp"
            )
            try:
                temporary.write_text(
                    json.dumps(self._cache, ensure_ascii=False, indent=2), encoding="utf-8"
                )
                temporary.chmod(0o600)
                os.replace(temporary, CONFIG_FILE)
            finally:
                temporary.unlink(missing_ok=True)

    def get(self, key: str, default: Any = None) -> Any:
        """Get a config section."""
        with self._lock:
            return self._load().get(key, default)

    def set(self, key: str, value: Any):
        """Set a config section and persist."""
        with self._lock:
            data = self._load()
            data[key] = value
            self._save()

    def delete(self, key: str):
        """Remove a config section and persist."""
        with self._lock:
            data = self._load()
            if key in data:
                del data[key]
                self._save()

    def invalidate(self):
        """Clear cache, force reload on next access."""
        with self._lock:
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

    def model_supports_multimodal(
        self,
        engine_id: str,
        model: str,
        provider_id: str = "",
    ) -> bool:
        """Return the per-model direct-image setting for the active source."""
        if not model:
            return False
        prices = self.get_model_pricing().get("prices", [])
        effective_provider = provider_id or self.get_engine_provider(engine_id)
        if effective_provider:
            provider_setting = next(
                (
                    item for item in prices
                    if isinstance(item, dict)
                    and item.get("model") == model
                    and item.get("provider_id") == effective_provider
                ),
                None,
            )
            if provider_setting is not None:
                return provider_setting.get("supports_multimodal") is True
        engine_setting = next(
            (
                item for item in prices
                if isinstance(item, dict)
                and item.get("model") == model
                and item.get("engine_id") == engine_id
            ),
            None,
        )
        if engine_setting is not None:
            return engine_setting.get("supports_multimodal") is True
        legacy_setting = next(
            (
                item for item in prices
                if isinstance(item, dict)
                and item.get("model") == model
                and not item.get("provider_id")
                and not item.get("engine_id")
            ),
            None,
        )
        return bool(
            legacy_setting
            and legacy_setting.get("supports_multimodal") is True
        )

    # --- Execution-engine model list cache (global config, not per-project DB) ---

    def get_engine_models(self, engine_id: str) -> dict:
        cache = self.get("engine_models", {})
        if not isinstance(cache, dict):
            return {}
        entry = cache.get(engine_id)
        return dict(entry) if isinstance(entry, dict) else {}

    def get_engine_model_caches(self) -> dict[str, dict]:
        cache = self.get("engine_models", {})
        if not isinstance(cache, dict):
            return {}
        return {
            str(engine_id): dict(entry)
            for engine_id, entry in cache.items()
            if isinstance(entry, dict)
        }

    def set_engine_models(
        self,
        engine_id: str,
        models: list[dict],
        fetched_at: str,
    ) -> None:
        cache = self.get("engine_models", {})
        if not isinstance(cache, dict):
            cache = {}
        cache = dict(cache)
        cache[engine_id] = {
            "models": models,
            "fetched_at": fetched_at,
        }
        self.set("engine_models", cache)

    def clear_engine_models(self, engine_id: str) -> None:
        cache = self.get("engine_models", {})
        if not isinstance(cache, dict) or engine_id not in cache:
            return
        cache = dict(cache)
        cache.pop(engine_id, None)
        self.set("engine_models", cache)

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

    def get_open_mode(self) -> bool:
        return self.get("open_mode", False) is True

    def get_git_scan_depth(self) -> int:
        """Project root is depth 0; discover repositories down to depth 5 by default."""
        value = self.get("git_scan_depth", 5)
        return value if type(value) is int and 0 <= value <= 9007199254740991 else 5

    def set_open_mode(self, enabled: bool) -> None:
        self.set("open_mode", enabled)

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

    def is_engine_enabled(self, engine_id: str) -> bool:
        """Visibility in engine selectors; never gates existing execution."""
        values = self.get("engine_visibility", {})
        value = values.get(engine_id) if isinstance(values, dict) else None
        return value if isinstance(value, bool) else engine_id not in {"claude", "codex"}

    def set_engine_enabled(self, engine_id: str, enabled: bool) -> None:
        with self._lock:
            values = self.get("engine_visibility", {})
            values = dict(values) if isinstance(values, dict) else {}
            values[engine_id] = enabled
            self.set("engine_visibility", values)

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
        return value if isinstance(value, str) else ""

    def set_coordinator_defaults(
        self,
        engine: str,
        model: str = "",
        fast_model: str = "",
        vision_model: str = "",
        thinking_effort: str = "",
    ) -> None:
        self.set("coordinator_default_engine", engine)
        self.set("coordinator_default_model", model)
        self.set("coordinator_default_fast_model", fast_model)
        self.set("coordinator_default_vision_model", vision_model)
        self.set("coordinator_default_thinking_effort", thinking_effort)

    def get_assistant_defaults(self, name: str) -> dict:
        """Resolve one assistant's default engine/model settings.

        Every assistant follows the global execution engine by default;
        per-assistant overrides (``assistant_defaults.<name>``) win when set.
        The task coordinator keeps its legacy explicit coordinator settings,
        but an empty coordinator engine follows the same global default.
        """
        managed_default = self.get_managed_default_provider()
        merged = {
            "engine": self.get_execution_default_engine() or DEFAULT_EXECUTION_ENGINE,
            "model": "",
            "fast_model": "",
            "vision_model": "",
            "thinking_effort": "",
            "provider_id": managed_default,
        }
        if name == "task_coordinator":
            coordinator = {
                "engine": self.get_coordinator_default_engine(),
                "model": self.get_coordinator_default_model(),
                "fast_model": self.get_coordinator_default_fast_model(),
                "vision_model": self.get_coordinator_default_vision_model(),
                "thinking_effort": self.get_coordinator_default_thinking_effort(),
            }
            for key, value in coordinator.items():
                if value:
                    merged[key] = value
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

    def get_assistant_config(self, name: str) -> dict:
        """Return only the explicit per-assistant overrides.

        Empty values mean "follow the engine/default", so callers that need
        to render saved settings must not substitute the resolved defaults.
        """
        values = {
            "engine": "",
            "model": "",
            "fast_model": "",
            "vision_model": "",
            "thinking_effort": "",
            "provider_id": "",
        }
        if name == "task_coordinator":
            values.update({
                "engine": self.get_coordinator_default_engine(),
                "model": self.get_coordinator_default_model(),
                "fast_model": self.get_coordinator_default_fast_model(),
                "vision_model": self.get_coordinator_default_vision_model(),
                "thinking_effort": self.get_coordinator_default_thinking_effort(),
            })
        overrides = self.get("assistant_defaults", {})
        if not isinstance(overrides, dict):
            return values
        overlay = overrides.get(name)
        if not isinstance(overlay, dict):
            return values
        for key in values:
            value = overlay.get(key)
            if isinstance(value, str) and value.strip():
                values[key] = value.strip()
        return values

    def get_engine_thinking_effort(self, engine_id: str) -> str:
        """Return an engine's own configured thinking effort, if declared."""
        engine_id = (engine_id or "").strip()
        if not engine_id:
            return ""
        custom = self.get("custom_engine_config", {})
        raw = (custom.get(engine_id, {}) if isinstance(custom, dict) else {}) or self.get(f"{engine_id}_engine", {})
        if not isinstance(raw, dict):
            return ""
        for key in (
            "model_reasoning_effort",
            "thinking_effort",
            "reasoning_effort",
        ):
            value = str(raw.get(key) or "").strip()
            if value:
                return value
        return ""

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
        the global execution engine when empty. ``provider_id`` is the built-in
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
        """Engine idle timeout in seconds; defaults to twenty minutes.

        A positive value enables the watchdog; 0 disables it. The longer
        default allows quiet thinking and tools while bounding stalled runs.
        """
        value = self.get("engine_idle_timeout_seconds", 1200)
        try:
            value = int(value)
        except (TypeError, ValueError):
            return 1200
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

    def get_engine_provider(self, engine_id: str) -> str:
        bindings = self.get("engine_providers", {})
        if not isinstance(bindings, dict):
            return ""
        value = bindings.get(engine_id, "")
        return value.strip() if isinstance(value, str) else ""

    def set_engine_provider(self, engine_id: str, provider_id: str) -> None:
        bindings = self.get("engine_providers", {})
        if not isinstance(bindings, dict):
            bindings = {}
        bindings = dict(bindings)
        provider_id = str(provider_id or "").strip()
        if provider_id:
            bindings[engine_id] = provider_id
        else:
            bindings.pop(engine_id, None)
        self.set("engine_providers", bindings)

    # Legacy entry points delegate to engine-owned adapters. New engines use
    # generic get/set storage or CustomEngineBase; do not add adapters here.
    def get_pydantic_ai_engine_config(self) -> dict[str, Any]:
        from engines._config.pydantic_ai import get_pydantic_ai_engine_config
        return get_pydantic_ai_engine_config(self)

    def set_pydantic_ai_engine_config(
        self,
        *,
        provider_id: str,
        model: str,
        mcp_servers: list | None = None,
        harness: str = "auto",
        sandbox: str = "",
        fast_model: str = "",
    ) -> None:
        from engines._config.pydantic_ai import set_pydantic_ai_engine_config
        return set_pydantic_ai_engine_config(
            self,
            provider_id=provider_id,
            model=model,
            mcp_servers=mcp_servers,
            harness=harness,
            sandbox=sandbox,
            fast_model=fast_model,
        )

    def get_deepseek_harness_config(self) -> dict[str, Any]:
        from engines._config.deepseek_harness import get_deepseek_harness_config
        return get_deepseek_harness_config(self)

    def set_deepseek_harness_config(
        self,
        *,
        provider_id: str,
        model: str,
        max_tokens: str = "",
        preset: str = "standard",
    ) -> None:
        from engines._config.deepseek_harness import set_deepseek_harness_config
        return set_deepseek_harness_config(
            self,
            provider_id=provider_id,
            model=model,
            max_tokens=max_tokens,
            preset=preset,
        )

    def get_claude_permission_mode(self) -> str:
        from engines._config.claude import get_claude_permission_mode
        return get_claude_permission_mode(self)

    def set_claude_permission_mode(self, mode: str):
        from engines._config.claude import set_claude_permission_mode
        return set_claude_permission_mode(self, mode)

    # --- Claude Code CLI config ---

    def get_claude_code_config(self) -> dict[str, str]:
        from engines._config.claude import get_claude_code_config
        return get_claude_code_config(self)

    def set_claude_code_model_map(self, model_map: Any) -> None:
        from engines._config.claude import set_claude_code_model_map
        return set_claude_code_model_map(self, model_map)

    def set_claude_code_config(
        self,
        model_map: Any = None,
        custom_settings: Any = None,
    ) -> None:
        from engines._config.claude import set_claude_code_config
        return set_claude_code_config(self, model_map, custom_settings)

    # --- Claude Agent SDK config ---

    def get_claude_agent_sdk_config(self) -> dict[str, Any]:
        from engines._config.claude import get_claude_agent_sdk_config
        return get_claude_agent_sdk_config(self)

    def set_claude_agent_sdk_config(
        self,
        max_turns: str = "",
        permission_mode: str | None = None,
        fallback_model: str = "",
        model_map: str | dict[str, Any] | None = None,
        custom_settings: str | dict[str, Any] | None = None,
    ) -> None:
        from engines._config.claude import set_claude_agent_sdk_config
        return set_claude_agent_sdk_config(
            self,
            max_turns,
            permission_mode,
            fallback_model,
            model_map,
            custom_settings,
        )

    # --- Codex CLI config ---

    def get_codex_config(self) -> dict[str, str]:
        from engines._config.codex import get_codex_config
        return get_codex_config(self)

    def set_codex_config(
        self,
        sandbox_mode: str = "",
        model_reasoning_effort: str = "",
        approval_policy: str = "",
        custom_config: str = "",
    ) -> None:
        from engines._config.codex import set_codex_config
        return set_codex_config(
            self,
            sandbox_mode,
            model_reasoning_effort,
            approval_policy,
            custom_config,
        )

    # --- Qoder Agent SDK config ---

    def get_qoder_sdk_config(self) -> dict[str, Any]:
        from engines._config.qoder import get_qoder_sdk_config
        return get_qoder_sdk_config(self)

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
        from engines._config.qoder import set_qoder_sdk_config
        return set_qoder_sdk_config(
            self,
            personal_access_token=personal_access_token,
            permission_mode=permission_mode,
            model=model,
            allowed_tools=allowed_tools,
            max_turns=max_turns,
            include_partial_messages=include_partial_messages,
        )

    # --- OpenCode engine config ---

    def get_opencode_config(self) -> dict[str, Any]:
        from engines._config.opencode import get_opencode_config
        return get_opencode_config(self)

    def set_opencode_config(self, permission_mode: str = "ask") -> None:
        from engines._config.opencode import set_opencode_config
        return set_opencode_config(self, permission_mode)

    # --- Codex Agent SDK config ---

    def get_codex_sdk_config(self) -> dict[str, str]:
        from engines._config.codex import get_codex_sdk_config
        return get_codex_sdk_config(self)

    def set_codex_sdk_config(
        self,
        model_reasoning_effort: str = "",
        approval_mode: str = "",
        sandbox: str = "",
        custom_config: str = "",
    ) -> None:
        from engines._config.codex import set_codex_sdk_config
        return set_codex_sdk_config(
            self,
            model_reasoning_effort,
            approval_mode,
            sandbox,
            custom_config,
        )


    # --- Providers (global LLM API suppliers) ---

    def set_managed_gateway_id(self, gateway_id: str | None, provider_guard=None) -> None:
        with self._lock:
            self._managed_gateway_id = gateway_id
            self._managed_provider_guard = provider_guard

    @property
    def managed_gateway_id(self) -> str | None:
        return self._managed_gateway_id

    def get_managed_default_provider(self) -> str:
        if not self._managed_gateway_id:
            return ""
        state = self.get("managed_provider_state", {})
        if not isinstance(state, dict) or state.get("gateway_id") != self._managed_gateway_id:
            return ""
        provider_id = state.get("default_provider_id", "")
        if not isinstance(provider_id, str) or not provider_id:
            return ""
        return provider_id if any(provider.get("id") == provider_id
                                  for provider in self.get_providers()) else ""

    def claim_managed_command(self, command_id: str, idempotency_key: str,
                              replay_only: bool = False) -> tuple[dict, bool]:
        with self._lock:
            data = self._load()
            receipts = data.get("managed_command_receipts", {})
            if not isinstance(receipts, dict):
                receipts = {}
            current = receipts.get(command_id)
            if current is not None:
                if current.get("idempotency_key") != idempotency_key:
                    raise ValueError("Managed command identity conflict")
                return dict(current), False
            if replay_only:
                return {"status": "failed", "error": "Previous execution not found"}, False
            receipts = dict(receipts)
            for old_id, old_receipt in list(receipts.items()):
                if len(receipts) < 1000:
                    break
                if old_receipt.get("status") in ("succeeded", "failed"):
                    receipts.pop(old_id)
            if len(receipts) >= 1000:
                raise RuntimeError("Managed command receipt store is full")
            receipt = {"idempotency_key": idempotency_key, "status": "running",
                       "error": None}
            receipts[command_id] = receipt
            data["managed_command_receipts"] = receipts
            self._save()
            return dict(receipt), True

    def finish_managed_command(self, command_id: str, idempotency_key: str,
                               status: str, error: str | None) -> None:
        if status not in ("succeeded", "failed"):
            raise ValueError("Invalid managed command result")
        with self._lock:
            data = self._load()
            receipts = data.get("managed_command_receipts", {})
            current = receipts.get(command_id) if isinstance(receipts, dict) else None
            if not current or current.get("idempotency_key") != idempotency_key:
                raise ValueError("Managed command receipt missing")
            current["status"] = status
            current["error"] = error[:512] if error else None
            self._save()

    def get_providers(self, *, include_unmanaged: bool = False) -> list[dict[str, Any]]:
        raw = self.get("providers", [])
        if not isinstance(raw, list):
            return []
        providers: list[dict[str, Any]] = []
        changed = False
        for item in raw:
            if not isinstance(item, dict):
                continue
            normalized = dict(item)
            type_id = str(normalized.get("type") or "custom")
            protocols: list[str] = []
            raw_protocols = normalized.get("protocols")
            if isinstance(raw_protocols, (list, tuple)):
                for value in raw_protocols:
                    value = str(value or "").strip()
                    if value in PROVIDER_PROTOCOLS and value not in protocols:
                        protocols.append(value)
            if not protocols:
                # 旧版单值记录读时迁移为列表（首项=默认协议）。
                legacy = str(normalized.get("protocol") or "").strip()
                protocols = [
                    legacy
                    if legacy in PROVIDER_PROTOCOLS
                    else default_provider_protocol(type_id)
                ]
            legacy_base_url = str(normalized.get("base_url") or "").strip().rstrip("/")
            raw_base_urls = normalized.get("protocol_base_urls")
            protocol_base_urls = {
                protocol: str(
                    (
                        raw_base_urls.get(protocol)
                        if isinstance(raw_base_urls, dict)
                        else ""
                    )
                    or legacy_base_url
                ).strip().rstrip("/")
                for protocol in protocols
            }
            if (
                normalized.get("protocols") != protocols
                or normalized.get("protocol") != protocols[0]
                or normalized.get("protocol_base_urls") != protocol_base_urls
                or normalized.get("base_url") != protocol_base_urls[protocols[0]]
            ):
                changed = True
            normalized["protocols"] = protocols
            normalized["protocol"] = protocols[0]
            normalized["protocol_base_urls"] = protocol_base_urls
            normalized["base_url"] = protocol_base_urls[protocols[0]]
            providers.append(normalized)
        if changed:
            self._load()["providers"] = providers
            self._save()
        if self._managed_gateway_id and not include_unmanaged:
            return [item for item in providers
                    if not item.get("managed") or (
                        item.get("managed_gateway_id") == self._managed_gateway_id
                        and self._managed_provider_guard is not None
                        and self._managed_provider_guard(str(item.get("id"))))]
        return providers

    def get_provider(self, provider_id: str) -> dict[str, Any] | None:
        for item in self.get_providers():
            if item.get("id") == provider_id:
                return item
        return None

    def save_provider(self, provider: dict[str, Any]) -> dict[str, Any]:
        providers = self.get_providers(include_unmanaged=True)
        if any(item.get("id") == provider.get("id") and item.get("managed") for item in providers):
            raise PermissionError("Managed providers cannot be changed locally")
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
        """Provider, protocol and model used by one-shot prompt enhancement."""
        raw = self.get("prompt_enhance", {})
        if not isinstance(raw, dict):
            raw = {}
        return {
            "provider_id": str(raw.get("provider_id") or ""),
            "model": str(raw.get("model") or ""),
            "protocol": str(raw.get("protocol") or ""),
        }

    def set_prompt_enhance_config(
        self, *, provider_id: str, model: str, protocol: str = ""
    ) -> None:
        """Save the prompt enhancement provider, protocol and model."""
        self.set("prompt_enhance", {
            "provider_id": str(provider_id or "").strip(),
            "model": str(model or "").strip(),
            "protocol": str(protocol or "").strip(),
        })

    # ── concurrency limits (global defaults, per-project overrides live in DB) ──

    def get_concurrency_config(self) -> dict:
        """Global task/chat concurrency defaults.

        ``max_tasks`` / ``max_chats`` are non-negative ints where ``0`` means
        "unlimited"; ``schedule_exempt`` exempts scheduled tasks from the task
        channel. Per-project values override these (see project_settings).
        """
        raw = self.get("concurrency", {})
        if not isinstance(raw, dict):
            raw = {}

        def as_limit(value, default: int) -> int:
            try:
                parsed = int(value)
            except (TypeError, ValueError):
                return default
            return parsed if parsed >= 0 else default

        return {
            "max_tasks": as_limit(raw.get("max_tasks"), 0),
            "max_chats": as_limit(raw.get("max_chats"), 0),
            "schedule_exempt": bool(raw.get("schedule_exempt", False)),
        }

    def set_concurrency_config(
        self, *, max_tasks: int, max_chats: int, schedule_exempt: bool
    ) -> None:
        """Save global concurrency defaults (0 = unlimited)."""
        self.set("concurrency", {
            "max_tasks": int(max_tasks) if int(max_tasks) > 0 else 0,
            "max_chats": int(max_chats) if int(max_chats) > 0 else 0,
            "schedule_exempt": bool(schedule_exempt),
        })

    def delete_provider(self, provider_id: str) -> bool:
        providers = self.get_providers(include_unmanaged=True)
        if any(item.get("id") == provider_id and item.get("managed") for item in providers):
            raise PermissionError("Managed providers cannot be changed locally")
        remaining = [item for item in providers if item.get("id") != provider_id]
        if len(remaining) == len(providers):
            return False
        self.set("providers", remaining)
        return True

    def apply_managed_providers(self, gateway_id: str, revision: int,
                                desired: list[dict[str, Any]],
                                after_apply=None, *, user_id: str = "",
                                default_provider_id: str = "") -> bool:
        """Replace only this Gateway's managed entries in one config-file write."""
        if (not gateway_id or self._managed_gateway_id != gateway_id
                or type(revision) is not int or revision < 0
                or not isinstance(user_id, str)
                or not isinstance(desired, list) or len(desired) > 100):
            raise ValueError("Invalid managed provider scope")
        ids: set[str] = set()
        names: set[str] = set()
        normalized: list[dict[str, Any]] = []
        for item in desired:
            if not isinstance(item, dict):
                raise ValueError("Invalid managed provider")
            provider_id, name = item.get("id"), item.get("name")
            protocols = item.get("protocols")
            urls = item.get("protocol_base_urls")
            api_key = item.get("api_key")
            models = item.get("models", [])
            if (not isinstance(provider_id, str) or not provider_id or provider_id in ids
                    or not isinstance(name, str) or not name or name in names
                    or not isinstance(item.get("type"), str)
                    or not isinstance(protocols, list) or not protocols or len(protocols) > 8
                    or any(not isinstance(protocol, str) or protocol not in PROVIDER_PROTOCOLS
                           for protocol in protocols)
                    or not isinstance(urls, dict) or set(urls) != set(protocols)
                    or not isinstance(api_key, str) or not api_key or len(api_key) > 4096
                    or not isinstance(models, list) or len(models) > 1000
                    or any(not isinstance(model, str) or not model or len(model) > 128
                           for model in models)
                    or len(set(models)) != len(models)):
                raise ValueError("Invalid managed provider")
            for url in urls.values():
                parsed = urlsplit(url) if isinstance(url, str) else None
                if (parsed is None or parsed.scheme not in {"http", "https"} or not parsed.hostname
                        or parsed.username or parsed.password or parsed.fragment or len(url) > 2048):
                    raise ValueError("Invalid managed provider endpoint")
            ids.add(provider_id)
            names.add(name)
            normalized.append({**item, "managed": True, "managed_gateway_id": gateway_id,
                               "managed_revision": revision, "enabled": True})
        if (not isinstance(default_provider_id, str)
                or default_provider_id and default_provider_id not in ids):
            raise ValueError("Invalid managed default provider")
        canonical = json.dumps(normalized, sort_keys=True, separators=(",", ":"))
        if default_provider_id:
            canonical += ":" + default_provider_id
        digest = hashlib.sha256(canonical.encode()).hexdigest()
        with self._lock:
            data = self._load()
            state = data.get("managed_provider_state", {})
            if isinstance(state, dict) and state.get("gateway_id") == gateway_id:
                current_revision = state.get("revision", -1)
                if revision < current_revision:
                    raise ValueError("Stale managed provider revision")
                if revision == current_revision and state.get("user_id", "") == user_id:
                    if state.get("digest") != digest:
                        raise ValueError("Managed provider revision conflict")
                    return False
            existing = self.get_providers(include_unmanaged=True)
            retained = [item for item in existing
                        if item.get("managed_gateway_id") != gateway_id]
            if any(item.get("id") in ids or item.get("name") in names for item in retained):
                raise ValueError("Managed provider conflicts with a local provider")
            previous = copy.deepcopy(data)
            cache = data.get("provider_models", {})
            cache = dict(cache) if isinstance(cache, dict) else {}
            for item in existing:
                if item.get("managed_gateway_id") == gateway_id:
                    cache.pop(str(item.get("id")), None)
            for item in normalized:
                cache[item["id"]] = {"models": [{"id": model} for model in item.get("models", [])],
                                     "fetched_at": "managed"}
            data["providers"] = retained + normalized
            data["provider_models"] = cache
            data["managed_provider_state"] = {"gateway_id": gateway_id,
                                               "user_id": user_id,
                                               "revision": revision, "digest": digest,
                                               "default_provider_id": default_provider_id}
            try:
                self._save()
                if after_apply is not None:
                    after_apply()
            except Exception:
                self._cache = previous
                self._save()
                raise
            return True

    def is_provider_in_use(self, provider_id: str) -> bool:
        """Whether an API-driven engine currently uses this provider."""
        bindings = self.get("engine_providers", {})
        if isinstance(bindings, dict) and provider_id in bindings.values():
            return True
        assistant_defaults = self.get("assistant_defaults", {})
        if isinstance(assistant_defaults, dict) and any(
            isinstance(item, dict) and item.get("provider_id") == provider_id
            for item in assistant_defaults.values()
        ):
            return True
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

    def get_provider_models(self, provider_id: str, protocol: str = "") -> dict:
        """Saved model list for a provider: ``{"models": [...], "fetched_at": ...}``.

        Stored in the global ``~/.workstep/config.json`` so model dropdowns never
        hit the provider address again after the first fetch.
        """
        cache = self.get("provider_models", {})
        if not isinstance(cache, dict):
            return {}
        entry = cache.get(
            f"{provider_id}::{protocol}" if protocol else provider_id
        )
        if not isinstance(entry, dict) and protocol:
            # 旧版仅按供应商缓存；首次按协议读取时继续兼容旧缓存。
            entry = cache.get(provider_id)
        return dict(entry) if isinstance(entry, dict) else {}

    def set_provider_models(
        self,
        provider_id: str,
        models: list[dict],
        fetched_at: str,
        protocol: str = "",
    ) -> None:
        cache = self.get("provider_models", {})
        if not isinstance(cache, dict):
            cache = {}
        cache = dict(cache)
        entry = {
            "models": models,
            "fetched_at": fetched_at,
        }
        cache[provider_id] = entry
        if protocol:
            cache[f"{provider_id}::{protocol}"] = entry
        self.set("provider_models", cache)

    def clear_provider_models(self, provider_id: str) -> None:
        cache = self.get("provider_models", {})
        if not isinstance(cache, dict) or provider_id not in cache:
            return
        cache = dict(cache)
        cache.pop(provider_id, None)
        for key in list(cache):
            if key.startswith(f"{provider_id}::"):
                cache.pop(key, None)
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

# Config writes used to be serialized accidentally by the event loop. They now
# run in worker threads, so keep every read-modify-write method atomic as one
# unit (the lower-level set/delete methods use the same re-entrant lock).
def _serialize_config_mutation(method):
    @wraps(method)
    def synchronized(self: ConfigStore, *args, **kwargs):
        with self._lock:
            return method(self, *args, **kwargs)

    return synchronized


for _method_name, _method in tuple(vars(ConfigStore).items()):
    if _method_name in {"set", "delete", "invalidate", "migrate_legacy_config"} or (
        _method_name.startswith(("set_", "save_", "delete_", "clear_"))
        and callable(_method)
    ):
        setattr(ConfigStore, _method_name, _serialize_config_mutation(_method))


# Global singleton
config_store = ConfigStore()
