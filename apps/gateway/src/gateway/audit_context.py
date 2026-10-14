"""Request-scoped source address for Gateway audit events; no forwarded-header trust."""
from contextvars import ContextVar
from ipaddress import ip_address

request_ip = ContextVar('gateway_audit_request_ip', default=None)

class AuditRequestContextMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            return await self.app(scope, receive, send)
        peer = scope.get('client')
        try:
            address = str(ip_address(peer[0])) if peer else None
        except ValueError:
            address = None
        token = request_ip.set(address)
        try:
            await self.app(scope, receive, send)
        finally:
            request_ip.reset(token)
