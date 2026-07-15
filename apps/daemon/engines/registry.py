"""Engine registry — maps backend names to engine classes.

Supports dual mode: ACP (preferred) and direct CLI (fallback).
"""

from engines.base import BaseLLMEngine
from engines.claude_code import ClaudeCodeEngine
from engines.codex import CodexEngine
from engines.hermes import HermesEngine
from engines.claude_code_acp import ClaudeCodeAcpEngine
from engines.codex_acp import CodexAcpEngine
from engines.qoder_acp import QoderAcpEngine

# All engine classes indexed by full key
_ALL_ENGINES: dict[str, type[BaseLLMEngine]] = {
    # Direct CLI modes
    "claude": ClaudeCodeEngine,
    "codex": CodexEngine,
    "hermes": HermesEngine,
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
}

# Public registry: backend name → resolved engine class
ENGINE_REGISTRY: dict[str, type[BaseLLMEngine]] = {}


def _resolve_registry():
    """Build the public registry by picking the best available engine per backend."""
    for backend, candidates in _BACKEND_PREFERENCE.items():
        for key in candidates:
            cls = _ALL_ENGINES.get(key)
            if cls and cls.is_installed():
                ENGINE_REGISTRY[backend] = cls
                break


# Resolve on import
_resolve_registry()


def refresh_registry():
    """Re-scan available engines and rebuild the registry."""
    ENGINE_REGISTRY.clear()
    _resolve_registry()


def get_available_engines() -> list[dict]:
    """Return all backends with their resolved engine info."""
    result = []
    for backend, candidates in _BACKEND_PREFERENCE.items():
        resolved = ENGINE_REGISTRY.get(backend)
        if resolved:
            instance = resolved()
            result.append({
                "id": backend,
                "installed": True,
                "version": resolved.get_version(),
                "mode": "acp" if resolved.__name__.endswith("Acp") or "Acp" in resolved.__name__ else "cli",
                "supports_resume": instance.supports_resume,
            })
        else:
            result.append({
                "id": backend,
                "installed": False,
                "version": None,
                "mode": None,
                "supports_resume": False,
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
