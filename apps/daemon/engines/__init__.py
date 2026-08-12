"""LLM engine abstraction layer.

``engines/`` 根目录只放引擎文件：每个引擎一个模块（文件或包），模块内
定义 ``BaseLLMEngine`` 子类并声明 ``ENGINE_ID``，启动时自动注册，
无需改动任何其他代码。
"""

from engines.core import registry
from engines.core.events import InternalEvent
from engines.core.base import BaseLLMEngine, EngineModel, EngineTestResult
from engines.core.acp_base import AcpEngineBase
from engines.core.registry import (
    ENGINE_REGISTRY,
    _ALL_ENGINES,
    create_engine,
    get_available_engines,
    list_all_engines,
    refresh_registry,
)

__all__ = [
    "InternalEvent",
    "BaseLLMEngine",
    "EngineTestResult",
    "EngineModel",
    "AcpEngineBase",
    "ENGINE_REGISTRY",
    "get_available_engines",
    "create_engine",
    "refresh_registry",
    "list_all_engines",
]

# 自动注册的引擎类直接暴露在 engines 命名空间
for _engine_cls in _ALL_ENGINES.values():
    globals()[_engine_cls.__name__] = _engine_cls
    if _engine_cls.__name__ not in __all__:
        __all__.append(_engine_cls.__name__)

del _engine_cls
