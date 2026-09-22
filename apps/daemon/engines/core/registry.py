"""Engine registry — auto-discovers engine modules under ``engines/``.

新增引擎：在 ``engines/`` 下新增一个模块（单文件或包），模块内定义
``BaseLLMEngine`` 子类并声明 ``ENGINE_ID``，即可自动注册，无需改动本文件。
"""

import importlib
import logging
import pkgutil
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict

import engines as _engines_pkg
from engines.core.base import BaseLLMEngine
from engines.core.acp_base import AcpEngineBase
from services.config import config_store

logger = logging.getLogger(__name__)


def _discover_engine_classes() -> dict[str, type[AcpEngineBase]]:
    """扫描 ``engines/`` 一级模块，收集声明了 ``ENGINE_ID`` 的引擎类。"""
    found: dict[str, type[AcpEngineBase]] = {}
    module_names = sorted(
        module.name
        for module in pkgutil.iter_modules(_engines_pkg.__path__)
        if not module.name.startswith("_")
    )
    for name in module_names:
        try:
            module = importlib.import_module(f"engines.{name}")
        except Exception:
            logger.exception("Failed to import engine module engines.%s", name)
            continue
        for obj in vars(module).values():
            if (
                isinstance(obj, type)
                and issubclass(obj, BaseLLMEngine)
                and obj not in (BaseLLMEngine, AcpEngineBase)
                and getattr(obj, "ENGINE_ID", None)
            ):
                found.setdefault(obj.ENGINE_ID, obj)
    return found


# All engine classes indexed by ENGINE_ID (auto-discovered from engines/)
_ALL_ENGINES: dict[str, type[AcpEngineBase]] = _discover_engine_classes()

# 协调 Agent 默认引擎未配置/不可用时，按此优先级回退；新引擎自动追加到末尾。
_COORDINATOR_BASE_ORDER = [
    "claude",
    "codex",
    "hermes",
    "pydantic_ai",
    "claude_agent_sdk",
    "codex_sdk",
    "qoder_sdk",
]
COORDINATOR_FALLBACK_ORDER = _COORDINATOR_BASE_ORDER + [
    engine_id
    for engine_id in _ALL_ENGINES
    if engine_id not in _COORDINATOR_BASE_ORDER
]

# Public registry: backend name → resolved engine class
ENGINE_REGISTRY: dict[str, type[AcpEngineBase]] = {}
_REGISTRY_LOCK = threading.RLock()


def _apply_binary_overrides():
    for engine_id, cls in _ALL_ENGINES.items():
        cls.set_binary_override(
            config_store.get_engine_binary_path(engine_id) or None
        )


def _resolve_registry():
    """Build the public registry from every installed engine."""
    for engine_id, cls in _ALL_ENGINES.items():
        if cls.is_installed():
            ENGINE_REGISTRY[engine_id] = cls


# Resolve on import
_apply_binary_overrides()
_resolve_registry()


def refresh_registry(*, invalidate_scan: bool = True):
    """Re-scan available engines and rebuild the registry.

    ``invalidate_scan=False`` rebuilds the engine registry without dropping
    the cached engine list (used by read-only lookups such as model lists).
    """
    with _REGISTRY_LOCK:
        ENGINE_REGISTRY.clear()
        _apply_binary_overrides()
        _resolve_registry()
        if invalidate_scan:
            _invalidated_scan_generation()


_VERSION_CACHE: dict[str, tuple[float, str | None]] = {}
_VERSION_TTL = 300.0

_SCAN_CACHE: list[dict] | None = None
_SCAN_GENERATION = 0


def _engine_version(cls: type[AcpEngineBase]) -> str | None:
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

    backends = list(_ALL_ENGINES.items())
    resolved_map: dict[str, type[AcpEngineBase] | None] = {}
    targets: dict[str, type[AcpEngineBase] | None] = {}
    for backend, cls in backends:
        resolved = cls if cls.is_installed() else None
        resolved_map[backend] = resolved
        targets[backend] = cls

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
            if issubclass(resolved, AcpEngineBase) and instance._is_acp_native:
                mode = "acp"
            elif backend == "pydantic_ai":
                mode = "agent"
            elif backend in {
                "claude_agent_sdk",
                "codex_sdk",
                "deepseek_harness",
                "qoder_sdk",
            }:
                mode = "sdk"
            else:
                mode = "cli"
            caps = instance.capabilities
            result.append({
                "id": backend,
                "installed": True,
                "configured": instance.is_configured(),
                "verified": config_store.is_engine_verified(backend),
                "built_in": backend == "pydantic_ai",
                "version": versions.get(backend),
                "mode": mode,
                "config": _engine_config_payload(resolved),
                "supports_provider": bool(resolved.supported_provider_protocols()),
                "provider_protocols": sorted(resolved.supported_provider_protocols()),
                "runtime_manageable": resolved.RUNTIME_PACKAGE is not None,
                "installable": resolved.install_command() is not None,
                "install_command": resolved.install_command(),
                "updatable": resolved.update_command() is not None,
                "update_command": resolved.update_command(),
                "requires_third_party_terms_acceptance": resolved.requires_third_party_terms_acceptance(),
                "third_party_terms_url": resolved.third_party_terms_url(),
                "supports_resume": instance.supports_resume,
                "supports_session_fork": instance.supports_session_fork,
                "supports_coordinator": caps.supports_coordinator,
                "supports_tool_disable": caps.supports_tool_disable,
                "supports_native_schema": caps.supports_native_schema,
                "supports_live_step_message": caps.supports_live_step_message,
                "supports_sessions": caps.supports_sessions,
                "supports_tool_approval": caps.supports_tool_approval,
                "supports_workstep_tools": caps.supports_workstep_tools,
                "skill_policy": instance.skill_policy.value,
                "supports_controlled_skills": instance.supports_controlled_skills,
                "binary_path": (
                    resolved.resolve_binary()
                    if backend != "pydantic_ai"
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
                "supports_provider": bool(
                    target and target.supported_provider_protocols()
                ),
                "provider_protocols": (
                    sorted(target.supported_provider_protocols()) if target else []
                ),
                "runtime_manageable": bool(target) and target.RUNTIME_PACKAGE is not None,
                "installable": bool(target) and target.install_command() is not None,
                "install_command": target.install_command() if target else None,
                "updatable": bool(target) and target.update_command() is not None,
                "update_command": target.update_command() if target else None,
                "requires_third_party_terms_acceptance": bool(
                    target and target.requires_third_party_terms_acceptance()
                ),
                "third_party_terms_url": target.third_party_terms_url() if target else None,
                "supports_resume": False,
                "supports_session_fork": False,
                "supports_coordinator": False,
                "supports_tool_disable": False,
                "supports_native_schema": False,
                "supports_live_step_message": False,
                "supports_sessions": False,
                "supports_tool_approval": False,
                "supports_workstep_tools": False,
                "skill_policy": target().skill_policy.value if target else "unsupported",
                "supports_controlled_skills": bool(target and target().supports_controlled_skills),
                "binary_path": target.resolve_binary() if target else None,
                "configured_path": configured_path or None,
            })
    _SCAN_CACHE = result
    return list(result)


def _engine_config_payload(cls: type[AcpEngineBase]) -> dict | None:
    """Embed the engine's config schema and masked values into the engine list.

    Lets the settings page render every engine's config form from the single
    ``/api/engine/list`` response instead of fetching one config per engine.
    """
    schema = cls.full_config_schema()
    if not schema:
        return None
    instance = cls()
    return {
        "fields": [asdict(field) for field in schema],
        "step_fields": [
            asdict(field) for field in cls.full_step_config_schema()
        ],
        "values": instance.get_full_config_values(),
        "secrets": instance.get_config_secrets(),
    }

def create_engine(backend: str) -> AcpEngineBase | None:
    """Create an engine instance by backend name.

    上层只依赖 ``AcpEngineBase``（ACP 协议接口）；自定义函数经基类继承获得。
    """
    with _REGISTRY_LOCK:
        cls = ENGINE_REGISTRY.get(backend)
        if not cls:
            return None
        return cls()


def list_all_engines() -> dict[str, type[AcpEngineBase]]:
    """Return all engine classes (including uninstalled ones)."""
    return dict(_ALL_ENGINES)
