"""Engine registry — maps backend names to engine classes."""

from engines.base import BaseLLMEngine
from engines.claude_code import ClaudeCodeEngine

# Registry: backend name → engine class
ENGINE_REGISTRY: dict[str, type[BaseLLMEngine]] = {
    "claude": ClaudeCodeEngine,
    # P2+: codex, hermes, qoder_acp, etc.
}


def get_available_engines() -> list[dict]:
    """Return list of registered engines with install status."""
    result = []
    for name, cls in ENGINE_REGISTRY.items():
        instance = cls() if _safe_instantiate(cls) else None
        result.append({
            "id": name,
            "installed": cls.is_installed(),
            "version": cls.get_version(),
            "supports_resume": instance.supports_resume if instance else False,
        })
    return result


def _safe_instantiate(cls: type[BaseLLMEngine]) -> bool:
    """Check if engine can be instantiated without args."""
    try:
        cls()
        return True
    except Exception:
        return False


def create_engine(backend: str) -> BaseLLMEngine | None:
    """Create an engine instance by backend name."""
    cls = ENGINE_REGISTRY.get(backend)
    if not cls:
        return None
    return cls()
