"""Static asset compression shared by daemon and Gateway ASGI hosts."""
from workstep_gateway_protocol.static_assets import StaticAssetCompressionMiddleware

__all__ = ['StaticAssetCompressionMiddleware']
