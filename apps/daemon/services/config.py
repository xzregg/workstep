"""Global config store — single ~/.workstep/config.json for all settings."""

import json
import logging
import os
import platform
from functools import wraps
import threading
import uuid
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

CONFIG_DIR = Path(
    os.environ.get("WORKSTEP_CONFIG_DIR") or Path.home() / ".workstep"
).expanduser()
CONFIG_FILE = CONFIG_DIR / "config.json"
DEFAULT_EXECUTION_ENGINE = "pydantic_ai"


def resolve_execution_engine(engine_id: str | None) -> str:
    """Resolve an optional per-stage engine to the current global default."""
    normalized = str(engine_id or "").strip()
    return (
        normalized
        or config_store.get_execution_default_engine()
        or DEFAULT_EXECUTION_ENGINE
    )

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

PROVIDER_PROTOCOLS = {
    "anthropic_messages",
    "openai_responses",
    "openai_chat_completions",
}

# Claude Code 内部的四个模型档位。CLI 用 ANTHROPIC_DEFAULT_{档位}_MODEL 解析
# `--model sonnet` 这类档位名，绑定第三方中转后必须把它们映射到真实模型 id。
CLAUDE_MODEL_MAP_ALIASES = ("fable", "haiku", "opus", "sonnet")
CLAUDE_MODEL_MAP_MAX_LEN = 256


def normalize_claude_model_map(raw: Any) -> dict[str, dict[str, str]]:
    """把任意输入规范化为 ``{档位: {"model": 模型 id, "name": 显示名}}``。

    入参可以是 API 传输层的 JSON 字符串，也可以是存储/cc-switch 的 dict。
    显示名为空时补成模型 id —— 「默认同值」这一语义只在存储层固化一次，
    env 生成、UI 回显和导入预填都直接复用规范化结果。
    """
    if raw is None:
        return {}
    if isinstance(raw, str):
        text = raw.strip()
        if not text:
            return {}
        try:
            raw = json.loads(text)
        except ValueError:
            raise ValueError("模型映射格式不正确")
    if isinstance(raw, dict) is False:
        raise ValueError("模型映射格式不正确")
    normalized: dict[str, dict[str, str]] = {}
    for alias, entry in raw.items():
        key = str(alias or "").strip().lower()
        if key not in CLAUDE_MODEL_MAP_ALIASES:
            # 未知档位静默丢弃：CLI 新增档位时旧版本不至于保存失败。
            continue
        if not isinstance(entry, dict):
            raise ValueError("模型映射格式不正确")
        model = str(entry.get("model") or "").strip()
        if not model:
            continue
        name = str(entry.get("name") or "").strip() or model
        for value in (model, name):
            if len(value) > CLAUDE_MODEL_MAP_MAX_LEN:
                raise ValueError("模型映射内容过长")
        normalized[key] = {"model": model, "name": name}
    return normalized


def claude_model_map_env(
    model_map: dict[str, dict[str, str]],
) -> dict[str, str]:
    """把规范化后的映射展开为 Claude Code 识别的环境变量。"""
    env: dict[str, str] = {}
    for alias, entry in model_map.items():
        model = str((entry or {}).get("model") or "").strip()
        if not model:
            continue
        prefix = f"ANTHROPIC_DEFAULT_{alias.upper()}_MODEL"
        env[prefix] = model
        env[f"{prefix}_NAME"] = str(entry.get("name") or "").strip() or model
    return env


def claude_sandbox_env(permission_mode: str | None) -> dict[str, str]:
    """Claude Code 在 root 下用 bypassPermissions 需要显式声明沙盒环境。

    CLI 的 ``isRootOutsideDeliberateSandbox()`` 会把「root + 未声明沙盒」判定为
    危险组合并直接 exit 1（``--dangerously-skip-permissions cannot be used with
    root/sudo privileges``）。容器化部署正是 root + 隔离文件系统，注入
    ``IS_SANDBOX=1`` 后 CLI 认可这是刻意沙盒，bypassPermissions 才能生效。
    """
    if str(permission_mode or "").strip() != "bypassPermissions":
        return {}
    return {"IS_SANDBOX": "1"}


def claude_model_map_json(
    model_map: dict[str, dict[str, str]],
) -> str:
    """序列化为稳定的 JSON 字符串（配置快照按字符串全等比较，键序必须固定）。"""
    if not model_map:
        return ""
    return json.dumps(model_map, sort_keys=True, ensure_ascii=False)


def normalize_claude_custom_settings(raw: Any) -> str:
    """校验引擎自定义配置并返回要存储的 JSON 文本。

    接受 JSON 字符串或 dict；必须是对象，``env``（若有）必须是
    ``{字符串: 字符串}``。空输入返回空串，表示不注入任何自定义配置。

    传入字符串时只做校验、不做格式化：原样保留用户输入的空格与换行，
    避免保存后回显被重排。传入 dict（测试或程序化调用）才序列化。
    """
    if raw is None:
        return ""
    original_text: str | None = None
    if isinstance(raw, str):
        original_text = raw
        text = raw.strip()
        if not text:
            return ""
        try:
            raw = json.loads(text)
        except ValueError:
            raise ValueError("自定义配置必须是合法 JSON")
    if isinstance(raw, dict) is False:
        raise ValueError("自定义配置必须是 JSON 对象")
    env = raw.get("env")
    if env is not None:
        if isinstance(env, dict) is False:
            raise ValueError("env 必须是 JSON 对象")
        for key, value in env.items():
            if not isinstance(key, str) or isinstance(value, (dict, list)):
                raise ValueError("env 的值必须是字符串")
    if original_text is not None:
        return original_text
    return json.dumps(raw, sort_keys=True, ensure_ascii=False)


def claude_custom_settings_json(raw: Any) -> str:
    """读取路径的容错版本：存储值非法时返回空串而不抛错。"""
    try:
        return normalize_claude_custom_settings(raw)
    except ValueError:
        return ""


def claude_custom_settings_payload(raw: Any) -> dict[str, Any]:
    """解析自定义配置为 dict；无配置或存储值非法时返回空 dict。"""
    normalized = claude_custom_settings_json(raw)
    return json.loads(normalized) if normalized else {}


def claude_custom_settings_env(
    raw: Any,
    exclude: set[str] | None = None,
) -> dict[str, str]:
    """提取自定义配置里的 ``env``，值统一转为字符串。

    ``exclude`` 用于保护供应商管理的变量：绑定供应商后 base url 与鉴权
    由供应商决定，自定义 JSON 不得覆盖，也不得重新加回供应商显式清理的键
    （例如 ``ANTHROPIC_AUTH_TOKEN``）。
    """
    env = claude_custom_settings_payload(raw).get("env")
    if not isinstance(env, dict):
        return {}
    blocked = exclude or set()
    return {
        str(key): str(value)
        for key, value in env.items()
        if str(key) not in blocked
    }


def claude_custom_settings_rest(raw: Any) -> dict[str, Any]:
    """自定义配置去掉 ``env`` 后的部分，用于合并进 Claude Code settings。"""
    payload = claude_custom_settings_payload(raw)
    payload.pop("env", None)
    return payload


def normalize_codex_custom_config(raw: Any) -> str:
    """校验 Codex 自定义 config 覆盖并返回要存储的文本。

    Codex 的配置不是 JSON，而是 ``key=value`` 形式（对应 CLI 的 ``-c``）。
    接受多行文本；空行与 ``#`` 注释行忽略。只校验、不格式化，原样保留
    用户输入的空格与换行。
    """
    if raw is None:
        return ""
    text = str(raw)
    if not text.strip():
        return ""
    for index, line in enumerate(text.splitlines(), 1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if "=" not in stripped:
            raise ValueError(f"第 {index} 行不是 key=value 格式")
        key, _value = stripped.split("=", 1)
        if not key.strip():
            raise ValueError(f"第 {index} 行缺少配置键")
    return text


def parse_codex_custom_config(raw: Any) -> list[tuple[str, str]]:
    """把自定义覆盖解析为 ``[(key, value), ...]``；无配置返回空列表。"""
    normalized = normalize_codex_custom_config(raw)
    entries: list[tuple[str, str]] = []
    if not normalized:
        return entries
    for line in normalized.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        key, value = stripped.split("=", 1)
        entries.append((key.strip(), value.strip()))
    return entries


def default_provider_protocol(type_id: str) -> str:
    """Return the backward-compatible protocol for one provider preset."""
    if type_id == "anthropic":
        return "anthropic_messages"
    if type_id == "openai":
        return "openai_responses"
    return "openai_chat_completions"


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

    def _load(self) -> dict:
        with self._lock:
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
        with self._lock:
            CONFIG_DIR.mkdir(parents=True, exist_ok=True)
            temporary = CONFIG_FILE.with_name(
                f".{CONFIG_FILE.name}.{os.getpid()}.{threading.get_ident()}.tmp"
            )
            try:
                temporary.write_text(
                    json.dumps(self._cache, ensure_ascii=False, indent=2)
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
        raw = self.get(f"{engine_id}_engine", {})
        if not isinstance(raw, dict):
            return ""
        for key in (
            "model_reasoning_effort",
            "thinking_effort",
            "reasoning_effort",
        ):
            value = str(raw.get(key) or "").strip()
            if value in CODEX_REASONING_EFFORTS:
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

    def get_pydantic_ai_engine_config(self) -> dict[str, Any]:
        raw = self.get("pydantic_ai_engine", {})
        if not isinstance(raw, dict):
            raw = {}
        sandbox = str(raw.get("sandbox") or "workspace-write")
        if sandbox not in CODEX_SANDBOX_MODES:
            sandbox = "workspace-write"
        return {
            "provider_id": raw.get("provider_id")
            or os.environ.get("PYDANTIC_AI_PROVIDER_ID", ""),
            "model": raw.get("model")
            or self.get_engine_default_model("pydantic_ai")
            or os.environ.get("PYDANTIC_AI_MODEL", ""),
            "fast_model": str(raw.get("fast_model") or "")
            or self.get_coordinator_default_fast_model(),
            "mcp_servers": raw.get("mcp_servers") or [],
            "harness": raw.get("harness") or "auto",
            "sandbox": sandbox,
        }

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
        sandbox = str(sandbox or "").strip() or "workspace-write"
        if sandbox not in CODEX_SANDBOX_MODES:
            sandbox = "workspace-write"
        self.set(
            "pydantic_ai_engine",
            {
                "provider_id": provider_id,
                "model": model,
                "fast_model": str(fast_model or ""),
                "mcp_servers": list(mcp_servers or []),
                "harness": harness,
                "sandbox": sandbox,
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

    # --- Claude Code CLI config ---

    def get_claude_code_config(self) -> dict[str, str]:
        """Claude Code CLI engine section.

        ``model_map`` 与 ``custom_settings`` 都走传输层字符串（引擎配置表单
        的 value 全是字符串），无内容时为空串。
        """
        raw = self.get("claude_code_engine", {})
        if not isinstance(raw, dict):
            raw = {}
        return {
            "model_map": claude_model_map_json(
                normalize_claude_model_map(raw.get("model_map"))
            ),
            "custom_settings": claude_custom_settings_json(
                raw.get("custom_settings")
            ),
        }

    def set_claude_code_model_map(self, model_map: Any) -> None:
        self.set_claude_code_config(model_map=model_map)

    def set_claude_code_config(
        self,
        model_map: Any = None,
        custom_settings: Any = None,
    ) -> None:
        raw = self.get("claude_code_engine", {})
        raw = dict(raw) if isinstance(raw, dict) else {}
        if model_map is not None:
            normalized = normalize_claude_model_map(model_map)
            if normalized:
                raw["model_map"] = normalized
            else:
                raw.pop("model_map", None)
        if custom_settings is not None:
            normalized_settings = normalize_claude_custom_settings(custom_settings)
            if normalized_settings:
                raw["custom_settings"] = normalized_settings
            else:
                raw.pop("custom_settings", None)
        self.set("claude_code_engine", raw)

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
            "model_map": claude_model_map_json(
                normalize_claude_model_map(raw.get("model_map"))
            ),
            "custom_settings": claude_custom_settings_json(
                raw.get("custom_settings")
            ),
        }

    def set_claude_agent_sdk_config(
        self,
        max_turns: str = "",
        permission_mode: str | None = None,
        fallback_model: str = "",
        model_map: str | dict[str, Any] | None = None,
        custom_settings: str | dict[str, Any] | None = None,
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
        if model_map is not None:
            # None = 保持原值（部分调用方只改轮数/备用模型）；"" = 显式清空。
            normalized_map = normalize_claude_model_map(model_map)
            if normalized_map:
                raw["model_map"] = normalized_map
            else:
                raw.pop("model_map", None)
        if custom_settings is not None:
            normalized_settings = normalize_claude_custom_settings(custom_settings)
            if normalized_settings:
                raw["custom_settings"] = normalized_settings
            else:
                raw.pop("custom_settings", None)
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
            "custom_config": normalize_codex_custom_config(
                raw.get("custom_config")
            ),
        }

    def set_codex_config(
        self,
        sandbox_mode: str = "",
        model_reasoning_effort: str = "",
        approval_policy: str = "",
        custom_config: str = "",
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
        custom = normalize_codex_custom_config(custom_config)
        self.set("codex_engine", {
            "sandbox_mode": sandbox_mode,
            "model_reasoning_effort": effort,
            "approval_policy": policy,
            "custom_config": custom,
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
            "custom_config": normalize_codex_custom_config(
                raw.get("custom_config")
            ),
        }

    def set_codex_sdk_config(
        self,
        model_reasoning_effort: str = "",
        approval_mode: str = "",
        sandbox: str = "",
        custom_config: str = "",
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
        custom = normalize_codex_custom_config(custom_config)
        self.set("codex_sdk_engine", {
            "model_reasoning_effort": effort,
            "approval_mode": mode,
            "sandbox": sandbox,
            "custom_config": custom,
        })


    # --- Providers (global LLM API suppliers) ---

    def get_providers(self) -> list[dict[str, Any]]:
        raw = self.get("providers", [])
        if not isinstance(raw, list):
            return []
        providers: list[dict[str, Any]] = []
        changed = False
        for item in raw:
            if not isinstance(item, dict):
                continue
            normalized = dict(item)
            protocol = str(normalized.get("protocol") or "").strip()
            if protocol not in PROVIDER_PROTOCOLS:
                normalized["protocol"] = default_provider_protocol(
                    str(normalized.get("type") or "custom")
                )
                changed = True
            providers.append(normalized)
        if changed:
            self._load()["providers"] = providers
            self._save()
        return providers

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
        providers = self.get_providers()
        remaining = [item for item in providers if item.get("id") != provider_id]
        if len(remaining) == len(providers):
            return False
        self.set("providers", remaining)
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
