"""Task-share project references do not publish or grant access to a project."""
from uuid import uuid4
from sqlalchemy import select
from sqlalchemy.dialects.sqlite import insert
from gateway.models import PlatformProject
from gateway.services.errors import GatewayError

async def resolve_task_share_project(session, device_id, user_id, host_project_id, *, create=False):
    if not isinstance(host_project_id, str) or not 1 <= len(host_project_id) <= 128 or any(char in host_project_id for char in ('/', '\\', ' ')):
        raise GatewayError('invalid', 'Invalid task project')
    query = select(PlatformProject).where(PlatformProject.device_id == device_id, PlatformProject.host_project_id == host_project_id)
    project = await session.scalar(query)
    if project is not None and project.status != 'active':
        raise GatewayError('not_found', 'Task project unavailable')
    if project is not None or not create:
        return project
    from gateway.services.platform_shares import can_create_platform_share
    if not await can_create_platform_share(session, user_id, None, device_id=device_id):
        raise GatewayError('forbidden', 'Share creation unavailable')
    await session.execute(insert(PlatformProject).values(id=str(uuid4()), device_id=device_id,
        host_project_id=host_project_id, name=host_project_id, access_mode='policy_only',
        status='active', created_by_user_id=user_id).on_conflict_do_nothing(index_elements=['device_id', 'host_project_id']))
    return await session.scalar(query)
