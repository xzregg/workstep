"""Failure-only administrative request audit without URL values or bodies."""
import json
import logging
from uuid import uuid4
from fastapi import HTTPException
from .identity import COOKIE_NAME, IdentityService
from .models import AuditEvent

logger = logging.getLogger(__name__)


async def audit_admin_request(request, call_next):
    if not request.url.path.startswith('/api/admin/'):
        return await call_next(request)
    actor = None
    try:
        actor, _ = await IdentityService(request.app.state.database).session_user(
            request.cookies.get(COOKIE_NAME))
    except HTTPException:
        pass

    async def record(status):
        if status < 400:
            return
        route = getattr(request.scope.get('route'), 'path', None)
        if not route:  # Unknown paths contain untrusted caller-controlled values.
            return
        event_id = str(uuid4())
        try:
            async with request.app.state.database.session() as session:
                async with session.begin():
                    session.add(AuditEvent(id=event_id,
                        user_id=actor.id if actor else None,
                        actor_username=actor.username if actor else None,
                        actor_name=actor.display_name if actor else None,
                        actor_type='user' if actor else 'system',
                        initiated_by_user_id=actor.id if actor else None,
                        initiated_by_username=actor.username if actor else None,
                        action='request.failed' if status >= 500 else 'request.denied',
                        result='failed' if status >= 500 else 'denied',
                        metadata_json=json.dumps({'method': request.method, 'route': route[:256], 'status': status})))
        except Exception:
            # Keep the original response; logs provide a receipt if storage fails.
            logger.error('Administrative failure audit unavailable: event=%s route=%s status=%s',
                         event_id, route, status)
    try:
        response = await call_next(request)
    except Exception:
        await record(500)
        raise
    await record(response.status_code)
    return response
