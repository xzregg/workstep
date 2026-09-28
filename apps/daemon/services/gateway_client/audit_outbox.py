"""Upload project-local audit rows without blocking the control event loop."""

import json
import uuid

from models import ProjectAuditEvent
from models.base import db_proxy
from models.fields import utc_now


class ProjectAuditOutbox:
    def __init__(self, project_manager):
        self._projects = project_manager

    async def pending(self, *, device_id: str, limit: int = 100) -> dict | None:
        if not isinstance(device_id, str) or not 1 <= len(device_id) <= 64:
            raise ValueError("Invalid audit reporting device")
        if not 1 <= limit <= 100:
            raise ValueError("Invalid audit batch limit")

        def load(_project):
            rows = list(
                ProjectAuditEvent.select()
                .where(ProjectAuditEvent.upload_status == "pending")
                .order_by(ProjectAuditEvent.created_at, ProjectAuditEvent.id)
                .limit(limit)
            )
            return [{
                "audit_event_id": row.id,
                "device_id": device_id,
                "project_id": row.project_id,
                "task_id": row.task_id,
                "action": row.action,
                "result": row.result,
                "mode": row.mode,
                "actor_id": row.actor_id,
                "actor_username": row.actor_username,
                "actor_name": row.actor_name,
                "actor_type": row.actor_type,
                "actor_device_id": row.device_id,
                "actor_device_name": row.device_name,
                "initiated_by_user_id": row.initiated_by_user_id,
                "initiated_by_username": row.initiated_by_username,
                "metadata": json.loads(row.metadata_json),
                "occurred_at": row.created_at.isoformat(),
            } for row in rows]

        for project in sorted(self._projects.iter_projects(), key=lambda item: item.id):
            rows = await self._projects.run_db(project.id, load)
            if not rows:
                continue
            selected = []
            size = 0
            for event in rows:
                payload_size = len(json.dumps(event, ensure_ascii=False).encode())
                if selected and size + payload_size > 256 * 1024:
                    break
                selected.append(event)
                size += payload_size
            return {
                "batch_id": uuid.uuid4().hex,
                "project_id": project.id,
                "events": selected,
            }
        return None

    async def ack(
        self, project_id: str, batch: dict, *,
        accepted: list[str], duplicates: list[str], rejected: list[str],
    ) -> None:
        expected = {event["audit_event_id"] for event in batch["events"]}
        ids = accepted + duplicates + rejected
        if (project_id != batch["project_id"] or len(ids) != len(set(ids))
                or not set(ids).issubset(expected)):
            raise ValueError("Invalid audit acknowledgment IDs")

        def persist(_project):
            with db_proxy.atomic("IMMEDIATE"):
                now = utc_now()
                for event_id in accepted + duplicates:
                    (ProjectAuditEvent.update(
                        upload_status="uploaded", upload_error=None,
                        uploaded_at=now,
                    ).where(
                        (ProjectAuditEvent.id == event_id)
                        & (ProjectAuditEvent.upload_status == "pending")
                    ).execute())
                for event_id in rejected:
                    (ProjectAuditEvent.update(
                        upload_status="rejected", upload_error="gateway_rejected",
                    ).where(
                        (ProjectAuditEvent.id == event_id)
                        & (ProjectAuditEvent.upload_status == "pending")
                    ).execute())

        await self._projects.run_db(project_id, persist)
