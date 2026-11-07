"""Same-device project navigation; every data request still has one signed project."""
import re

from sqlalchemy import select

from gateway.models import PlatformProject
from gateway.services.capabilities import compiled_device_policy
from gateway.services.errors import GatewayError
from gateway.services.platform_shares import can_create_platform_share
from gateway.services.project_access_api import effective_project_access
from gateway.services.project_ui_permissions import effective_ui_permissions


def requested_host_project(call):
    values = [value for key, value in call.query_values.multi_items() if key in ('project_id', 'projectId')]
    summary = re.fullmatch(r'/api/project/([A-Za-z0-9_-]{1,128})/summary', call.target.path)
    if len(values) > 1 or values and not values[0]:
        raise GatewayError('forbidden', 'Ambiguous project scope')
    if summary:
        if values and values[0] != summary[1]:
            raise GatewayError('forbidden', 'Project scope mismatch')
        return summary[1]
    return values[0] if values else None


async def workspace_project_scopes(call, user_id, device_id, entry_project_id, entry_access_level):
    _, broad, _, allowed, denied = await compiled_device_policy(call.database, device_id, user_id)
    result = []
    async with call.database.session() as db:
        projects = (await db.scalars(select(PlatformProject).where(
            PlatformProject.device_id == device_id, PlatformProject.status == 'active',
            PlatformProject.access_mode == 'remote_published',
        ).order_by(PlatformProject.created_at, PlatformProject.id))).all()
        for project in projects:
            level = await effective_project_access(db, user_id, project.id)
            if level is None:
                continue
            if project.id == entry_project_id and entry_access_level == 'read':
                level = 'read'
            task_create = (level == 'edit' and (broad or project.host_project_id in allowed)
                           and project.host_project_id not in denied)
            share_create = await can_create_platform_share(db, user_id, project)
            permissions = await effective_ui_permissions(db, user_id, project.id)
            if not task_create:
                permissions = [key for key in permissions if key not in ('task.create', 'task.copy', 'task.ai_create', 'task.start_on_create')]
            if not share_create:
                permissions = [key for key in permissions if not key.startswith('share.')]
            result.append({'project_id': project.id, 'host_project_id': project.host_project_id,
                           'name': project.name, 'access_level': level, 'task_create': task_create,
                           'share_create': share_create, 'permissions': permissions})
    return result
