"""Remote failures belong to the trusted ticket project, never query targets."""
import logging
from services.remote_access import ActorSnapshot, actor_context

logger = logging.getLogger(__name__)


async def record_remote_request_failure(actor, status: int, reason_code: str):
    if actor is None or actor.project_id is None or status < 400:
        return
    import main
    from services.project_audit import record_project_audit
    manager = main.project_manager
    if manager.get_project_by_id(actor.project_id) is None:
        return
    snapshot = ActorSnapshot(actor_id=actor.user_id, username=actor.username,
        user_name=actor.display_name or actor.username, device_id=actor.device_id,
        device_name=actor.device_id, source='managed', project_id=actor.project_id,
        access_level=actor.project_access_level)
    try:
        with actor_context(snapshot):
            await manager.run_db(actor.project_id, lambda _project: record_project_audit(
                project_id=actor.project_id, action='request.failed' if status >= 500 else 'request.denied',
                result='failed' if status >= 500 else 'denied', mode='managed',
                metadata={'status': status, 'reason_code': reason_code}))
    except Exception:
        logger.error('Remote request audit unavailable: project=%s status=%s', actor.project_id, status)
