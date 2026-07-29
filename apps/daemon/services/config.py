"""Global config store — single ~/.workstep/config.json for all settings."""

import json
import logging
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

CONFIG_DIR = Path.home() / ".workstep"
CONFIG_FILE = CONFIG_DIR / "config.json"


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


# Global singleton
config_store = ConfigStore()
