"""Engine registry — maps backend names to engine classes."""

import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict

from engines.base import BaseLLMEngine
from engines.acp_base import AcpEngineBase
from engines.claude_code import ClaudeCodeEngine
from engines.codex import CodexEngine
from engines.hermes import HermesEngine
from engines.qoder_sdk import QoderSDKEngine
from engines.openclaw import OpenClawEngine
from engines.api import APIEngine
from engines.pydantic_ai import PydanticAIEngine
from engines.claude_agent_sdk import ClaudeAgentSDKEngine
from engines.codex_sdk import CodexSDKEngine
from services.config import config_store

# All engine classes indexed by full key
_ALL_ENGINES: dict[str, type[BaseLLMEngine]] = {
    # Direct CLI modes
    "claude": ClaudeCodeEngine,
    "codex": CodexEngine,
    "hermes": HermesEngine,
    "qoder_sdk": QoderSDKEngine,
    "openclaw": OpenClawEngine,
    # API modes
    "api": APIEngine,
    "pydantic_ai": PydanticAIEngine,
    # SDK modes
    "claude_agent_sdk": ClaudeAgentSDKEngine,
    "codex_sdk": CodexSDKEngine,
}

# Backend → preferred engine key
_BACKEND_PREFERENCE: dict[str, list[str]] = {
    "claude": ["claude"],
    "codex": ["codex"],
    "hermes": ["hermes"],
    "qoder_sdk": ["qoder_sdk"],
    "openclaw": ["openclaw"],
    "api": ["api"],
    "pydantic_ai": ["pydantic_ai"],
    "claude_agent_sdk": ["claude_agent_sdk"],
    "codex_sdk": ["codex_sdk"],
}

_PATH_TARGETS: dict[str, str] = {
    "claude": "claude",
    "codex": "codex",
    "hermes": "hermes",
    "qoder_sdk": "qoder_sdk",
    "openclaw": "openclaw",
    "claude_agent_sdk": "claude_agent_sdk",
    "codex_sdk": "codex_sdk",
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


def refresh_registry(*, invalidate_scan: bool = True):
    """Re-scan available engines and rebuild the registry.

    ``invalidate_scan=False`` rebuilds the engine registry without dropping
    the cached engine list (used by read-only lookups such as model lists).
    """
    ENGINE_REGISTRY.clear()
    _apply_binary_overrides()
    _resolve_registry()
    if invalidate_scan:
        _invalidated_scan_generation()


_VERSION_CACHE: dict[str, tuple[float, str | None]] = {}
_VERSION_TTL = 300.0

_SCAN_CACHE: list[dict] | None = None
_SCAN_GENERATION = 0


def _engine_version(cls: type[BaseLLMEngine]) -> str | None:
    """Version probe with a short TTL so repeated scans skip subprocesses.

    Version checks for CLI engines run ``binary --version``, which is slow;
    a 300s cache keeps the engine list fast without permanently staling.
    """
    key = cls.__name__
    now = time.monotonic()
    cached = _VERSION_CACHE.get(key)
    if cached is not None and now - cached[0] < _VERSION_TTL:
        return cached[1]
    try:
        version = cls.get_version()
    except Exception:
        version = None
    _VERSION_CACHE[key] = (now, version)
    return version


def _invalidated_scan_generation() -> int:
    """Bump the scan cache generation (called by refresh_registry)."""
    global _SCAN_GENERATION, _SCAN_CACHE
    _SCAN_GENERATION += 1
    _SCAN_CACHE = None
    return _SCAN_GENERATION


def get_available_engines() -> list[dict]:
    """Return all backends with their resolved engine info.

    The result is cached in memory; only ``refresh_registry()`` (manual
    re-scan, binary path / config changes) invalidates it. Version probes
    that launch subprocesses run concurrently on the first scan.
    """
    global _SCAN_CACHE
    if _SCAN_CACHE is not None:
        return list(_SCAN_CACHE)

    backends = list(_BACKEND_PREFERENCE.items())
    resolved_map: dict[str, type[BaseLLMEngine] | None] = {}
    targets: dict[str, type[BaseLLMEngine] | None] = {}
    for backend, candidates in backends:
        resolved = None
        for key in candidates:
            cls = _ALL_ENGINES.get(key)
            if cls and cls.is_installed():
                resolved = cls
                break
        resolved_map[backend] = resolved
        target_key = _PATH_TARGETS.get(backend)
        targets[backend] = _ALL_ENGINES.get(target_key) if target_key else None

    # Run subprocess-based version probes in parallel; cached results skip
    # the subprocess entirely.
    versions: dict[str, str | None] = {}
    version_backends = [
        backend for backend, cls in resolved_map.items() if cls is not None
    ]
    if version_backends:
        with ThreadPoolExecutor(max_workers=min(8, len(version_backends))) as pool:
            future_map = {
                pool.submit(_engine_version, resolved_map[backend]): backend
                for backend in version_backends
            }
            for future in as_completed(future_map):
                versions[future_map[future]] = future.result()

    result: list[dict] = []
    for backend, _candidates in backends:
        resolved = resolved_map[backend]
        target = targets[backend]
        configured_path = config_store.get_engine_binary_path(backend)
        if resolved:
            instance = resolved()
            if issubclass(resolved, AcpEngineBase):
                mode = "acp"
            elif backend == "api":
                mode = "api"
            elif backend == "pydantic_ai":
                mode = "agent"
            elif backend in {"claude_agent_sdk", "codex_sdk", "qoder_sdk"}:
                mode = "sdk"
            else:
                mode = "cli"
            result.append({
                "id": backend,
                "installed": True,
                "configured": instance.is_configured(),
                "verified": config_store.is_engine_verified(backend),
                "built_in": backend == "pydantic_ai",
                "version": versions.get(backend),
                "mode": mode,
                "config": _engine_config_payload(resolved),
                "supports_resume": instance.supports_resume,
                "supports_coordinator": instance.capabilities.supports_coordinator,
                "supports_tool_disable": instance.capabilities.supports_tool_disable,
                "supports_native_schema": instance.capabilities.supports_native_schema,
                "supports_live_stage_message": instance.capabilities.supports_live_stage_message,
                "supports_sessions": instance.capabilities.supports_sessions,
                "supports_tool_approval": instance.capabilities.supports_tool_approval,
                "binary_path": (
                    resolved.resolve_binary()
                    if backend not in {"api", "pydantic_ai"}
                    else None
                ),
                "configured_path": configured_path or None,
            })
        else:
            result.append({
                "id": backend,
                "installed": False,
                "configured": False,
                "verified": False,
                "built_in": backend == "pydantic_ai",
                "version": None,
                "mode": None,
                "config": _engine_config_payload(target) if target else None,
                "supports_resume": False,
                "supports_coordinator": False,
                "supports_tool_disable": False,
                "supports_native_schema": False,
                "supports_live_stage_message": False,
                "supports_sessions": False,
                "supports_tool_approval": False,
                "binary_path": target.resolve_binary() if target else None,
                "configured_path": configured_path or None,
            })
    _SCAN_CACHE = result
    return list(result)


def _engine_config_payload(cls: type[BaseLLMEngine]) -> dict | None:
    """Embed the engine's config schema and masked values into the engine list.

    Lets the settings page render every engine's config form from the single
    ``/api/engine/list`` response instead of fetching one config per engine.
    """
    schema = cls.config_schema()
    if not schema:
        return None
    instance = cls()
    return {
        "fields": [asdict(field) for field in schema],
        "values": instance.get_config_values(),
        "secrets": instance.get_config_secrets(),
    }

def create_engine(backend: str) -> BaseLLMEngine | None:
    """Create an engine instance by backend name."""
    cls = ENGINE_REGISTRY.get(backend)
    if not cls:
        return None
    return cls()


def list_all_engines() -> dict[str, type[BaseLLMEngine]]:
    """Return all engine classes (including uninstalled ones)."""
    return dict(_ALL_ENGINES)
