"""Managed Gateway client boundary."""

__all__ = ["GatewayClientService"]


def __getattr__(name: str):
    if name != "GatewayClientService":
        raise AttributeError(name)
    from .service import GatewayClientService
    return GatewayClientService
