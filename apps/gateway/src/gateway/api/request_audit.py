"""Failure-only administrative request audit without URL values or bodies."""
import logging
from gateway.services.identity_errors import IdentityError
from gateway.services.identity import COOKIE_NAME, IdentityService
from gateway.services.request_audit import record_request_failure

logger = logging.getLogger(__name__)


async def audit_admin_request(request, call_next):
    if not request.url.path.startswith('/api/admin/'):
        return await call_next(request)
    actor = None
    try:
        actor, _ = await IdentityService(request.app.state.database).session_user(
            request.cookies.get(COOKIE_NAME))
    except IdentityError:
        pass

    async def record(status):
        if status < 400:
            return
        route = getattr(request.scope.get('route'), 'path', None)
        if not route:
            return
        try:
            await record_request_failure(request.app.state.database, actor, request.method, route, status)
        except Exception:
            logger.error('Administrative failure audit unavailable: route=%s status=%s', route, status)
    try:
        response = await call_next(request)
    except Exception:
        await record(500)
        raise
    await record(response.status_code)
    return response
