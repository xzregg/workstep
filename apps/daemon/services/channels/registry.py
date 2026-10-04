"""Discover concrete adapters by their CHANNEL_ID, like the engine registry."""
from functools import lru_cache
import importlib
import inspect
import pkgutil

from services.channels.base import ChannelAdapter


@lru_cache(maxsize=1)
def discover_channels() -> dict[str, type[ChannelAdapter]]:
    import services.channels as package
    channels = {}
    for entry in pkgutil.iter_modules(package.__path__):
        module = importlib.import_module(f'{package.__name__}.{entry.name}')
        for _, adapter in inspect.getmembers(module, inspect.isclass):
            if adapter.__module__ != module.__name__ or not issubclass(adapter, ChannelAdapter) or inspect.isabstract(adapter):
                continue
            if not adapter.CHANNEL_ID:
                continue
            if adapter.CHANNEL_ID in channels:
                raise ValueError(f'重复渠道标识：{adapter.CHANNEL_ID}')
            channels[adapter.CHANNEL_ID] = adapter
    return channels
