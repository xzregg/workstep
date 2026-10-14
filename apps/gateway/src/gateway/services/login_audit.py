"""Small login snapshots appended to the existing authentication transaction."""
import json
from uuid import uuid4
from gateway.models import AuditEvent


def add_login_audit(session, user, method, *, device=None, source_id=None, binding=False, action=None):
    metadata = {"login_method": method}
    if source_id:
        metadata["source_id"] = source_id
    if device:
        metadata.update(device_name=device.name[:256], device_status=device.status)
    pending = user.status != "active" or device is not None and device.status != "active"
    if pending:
        metadata["reason_code"] = "device_pending" if device else "account_pending"
    session.add(AuditEvent(
        id=str(uuid4()), user_id=user.id, device_id=device.id if device else None,
        actor_username=user.username, actor_name=user.display_name, actor_type="user",
        initiated_by_user_id=user.id, initiated_by_username=user.username,
        action=action or ("auth.identity.bind" if binding else "auth.desktop.login" if device else "auth.login"),
        result="denied" if pending else "success", mode="managed",
        metadata_json=json.dumps(metadata, ensure_ascii=False),
    ))


async def record_login_failure(database, method, reason, *, attempted_username=None, source_id=None):
    """An attempted account name is not proof of the caller's identity."""
    import logging
    metadata = {"login_method": method, "reason_code": reason[:64]}
    if source_id:
        metadata["source_id"] = source_id
    try:
        async with database.session() as session:
            async with session.begin():
                session.add(AuditEvent(
                    id=str(uuid4()), user_id=None, actor_type="anonymous",
                    actor_username=attempted_username[:128] if attempted_username else None,
                    action="auth.login", result="denied" if reason == "forbidden" else "failed",
                    mode="managed", metadata_json=json.dumps(metadata),
                ))
    except Exception:
        logging.getLogger(__name__).error("Login failure audit unavailable: method=%s", method)
