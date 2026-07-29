"""Engine registry — maps backend names to engine classes.

Supports dual mode: ACP (preferred) and direct CLI (fallback).
"""

from engines.base import BaseLLMEngine
from engines.acp_base import AcpEngineBase
from engines.claude_code import ClaudeCodeEngine
from engines.codex import CodexEngine
from engines.hermes import HermesEngine
from engines.claude_code_acp import ClaudeCodeAcpEngine
from engines.codex_acp import CodexAcpEngine
from engines.qoder_acp import QoderAcpEngine
from engines.qcode import QCodeEngine
from engines.openclaw import OpenClawEngine
from engines.api import APIEngine
from services.config import config_store

# All engine classes indexed by full key
_ALL_ENGINES: dict[str, type[BaseLLMEngine]] = {
    # Direct CLI modes
    "claude": ClaudeCodeEngine,
    "codex": CodexEngine,
    "hermes": HermesEngine,
    "qcode": QCodeEngine,
    "openclaw": OpenClawEngine,
    # API modes
    "api": APIEngine,
    # ACP modes
    "claude_acp": ClaudeCodeAcpEngine,
    "codex_acp": CodexAcpEngine,
    "qoder_acp": QoderAcpEngine,
}

# Backend → preferred engine key (ACP first, then CLI)
_BACKEND_PREFERENCE: dict[str, list[str]] = {
    "claude": ["claude_acp", "claude"],
    "codex": ["codex_acp", "codex"],
    "hermes": ["hermes"],
    "qoder": ["qoder_acp"],
    "qcode": ["qcode"],
    "openclaw": ["openclaw"],
    "api": ["api"],
}

_PATH_TARGETS: dict[str, str] = {
    "claude": "claude",
    "codex": "codex",
    "hermes": "hermes",
    "qoder": "qoder_acp",
    "qcode": "qcode",
    "openclaw": "openclaw",
}

# Public registry: backend name → resolved engine class
ENGINE_REGISTRY: dict[str, type[BaseLLMEngine]] = {}


def _apply_binary_overrides():
    for backend, engine_key in _PATH_TARGETS.items():
        _ALL_ENGINES[engine_key].set_binary_override(
            config_store.get_engine_binary_path(backend) or None
        )


def _resolve_registry():
    """Build the public registry by picking the best available engine per backend."""
    for backend, candidates in _BACKEND_PREFERENCE.items():
        for key in candidates:
            cls = _ALL_ENGINES.get(key)
            if cls and cls.is_installed():
                ENGINE_REGISTRY[backend] = cls
                break


# Resolve on import
_apply_binary_overrides()
_resolve_registry()


def refresh_registry():
    """Re-scan available engines and rebuild the registry."""
    ENGINE_REGISTRY.clear()
    _apply_binary_overrides()
    _resolve_registry()


def get_available_engines() -> list[dict]:
    """Return all backends with their resolved engine info."""
    result = []
    for backend, candidates in _BACKEND_PREFERENCE.items():
        resolved = ENGINE_REGISTRY.get(backend)
        target_key = _PATH_TARGETS.get(backend)
        target = _ALL_ENGINES.get(target_key) if target_key else None
        configured_path = config_store.get_engine_binary_path(backend)
        if resolved:
            instance = resolved()
            if issubclass(resolved, AcpEngineBase):
                mode = "acp"
            elif backend == "api":
                mode = "api"
            else:
                mode = "cli"
            result.append({
                "id": backend,
                "installed": True,
                "version": resolved.get_version(),
                "mode": mode,
                "supports_resume": instance.supports_resume,
                "binary_path": (
                    resolved.resolve_binary() if backend != "api" else None
                ),
                "configured_path": configured_path or None,
            })
        else:
            result.append({
                "id": backend,
                "installed": False,
                "version": None,
                "mode": None,
                "supports_resume": False,
                "binary_path": target.resolve_binary() if target else None,
                "configured_path": configured_path or None,
            })
    return result


def create_engine(backend: str) -> BaseLLMEngine | None:
    """Create an engine instance by backend name."""
    cls = ENGINE_REGISTRY.get(backend)
    if not cls:
        return None
    return cls()


def list_all_engines() -> dict[str, type[BaseLLMEngine]]:
    """Return all engine classes (including uninstalled ones)."""
    return dict(_ALL_ENGINES)
