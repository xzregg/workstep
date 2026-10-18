"""LLM engine abstraction layer.

``engines/`` 根目录只放引擎文件：每个引擎一个模块（文件或包），模块内
定义 ``AcpEngineBase`` 子类（ACP 协议基类，继承 ``BaseLLMEngine`` 的
自定义函数：安装 / 版本 / 配置）并声明 ``ENGINE_ID``，启动时自动注册，
无需改动任何其他代码。
"""

# Keep package imports side-effect free: configuration modules and provider
# services must be importable before the global config singleton exists.
from importlib import import_module

_EXPORTS = {
    "InternalEvent": "engines.core.events",
    "BaseLLMEngine": "engines.core.base",
    "EngineTestResult": "engines.core.base",
    "EngineModel": "engines.core.base",
    "AcpEngineBase": "engines.core.acp_base",
    "ENGINE_REGISTRY": "engines.core.registry",
    "_ALL_ENGINES": "engines.core.registry",
    "get_available_engines": "engines.core.registry",
    "create_engine": "engines.core.registry",
    "refresh_registry": "engines.core.registry",
    "list_all_engines": "engines.core.registry",
}


def __getattr__(name):
    if name in _EXPORTS:
        return getattr(import_module(_EXPORTS[name]), name)
    if name == "__all__" or name.endswith("Engine") or name.startswith("Custom_"):
        registry = import_module("engines.core.registry")
        classes = {cls.__name__: cls for cls in registry._ALL_ENGINES.values()}
        if name == "__all__":
            return [key for key in _EXPORTS if not key.startswith("_")] + list(classes)
        if name in classes:
            return classes[name]
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
