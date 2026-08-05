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

    def set_coordinator_defaults(
        self,
        engine: str,
        model: str = "",
        fast_model: str = "",
    ) -> None:
        self.set("coordinator_default_engine", engine)
        self.set("coordinator_default_model", model)
        self.set("coordinator_default_fast_model", fast_model)

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


# Global singleton
config_store = ConfigStore()
