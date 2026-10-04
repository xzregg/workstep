"""Device-authenticated project publication without host filesystem paths."""

from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import select, update

from gateway.models import AuditEvent, Device, PlatformProject, ProjectAccessGrant


async def record_project_publication(database, *, device_id: str, user_id: str,
                                     host_project_id: str, name: str,
                                     action: str) -> dict:
    if (action not in ("publish", "unpublish")
            or not isinstance(host_project_id, str)
            or not 1 <= len(host_project_id) <= 128
            or any(char in host_project_id for char in ("/", "\\", " "))
            or not isinstance(name, str) or not 1 <= len(name) <= 256
            or name != name.strip() or any(char in name for char in ("/", "\\"))):
        raise ValueError("Invalid project publication")
    now = datetime.now(timezone.utc)
    async with database.session() as session:
        async with session.begin():
            project = await session.scalar(select(PlatformProject).where(
                PlatformProject.device_id == device_id,
                PlatformProject.host_project_id == host_project_id,
            ))
            if project is None:
                if action == "unpublish":
                    raise ValueError("Project is not registered")
                project = PlatformProject(
                    id=str(uuid4()), device_id=device_id,
                    host_project_id=host_project_id, name=name,
                    access_mode="remote_published", status="active",
                    created_by_user_id=user_id, published_by_user_id=user_id,
                    published_at=now, updated_at=now,
                )
                session.add(project)
            else:
                project.name = name
                project.updated_at = now
                project.access_mode = ("remote_published" if action == "publish"
                                       else "policy_only")
                if action == "publish":
                    project.published_by_user_id = user_id
                    project.published_at = now
                else:
                    await session.execute(update(ProjectAccessGrant).where(
                        ProjectAccessGrant.project_id == project.id,
                        ProjectAccessGrant.revoked_at.is_(None),
                    ).values(revoked_at=now))
            await session.execute(update(Device).where(Device.id == device_id).values(
                policy_revision=Device.policy_revision + 1,
            ))
            session.add(AuditEvent(
                id=str(uuid4()), user_id=user_id, device_id=device_id,
                action=f"project.{action}", result="success",
                metadata_json=f'{{"project_id":"{project.id}"}}',
            ))
    return {"project_id": project.id, "host_project_id": host_project_id,
            "status": "published" if action == "publish" else "unpublished"}
