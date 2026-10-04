"""Persist failure audit receipts outside the HTTP adapter."""
import json
from uuid import uuid4
from gateway.models import AuditEvent

async def record_request_failure(database, actor, method, route, status):
    event_id = str(uuid4())
    async with database.session() as session:
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
                metadata_json=json.dumps({'method': method, 'route': route[:256], 'status': status})))
