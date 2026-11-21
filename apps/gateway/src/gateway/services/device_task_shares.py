"""Share management bound to the authenticated device control account."""
from datetime import datetime
import json
from sqlalchemy import select
from pydantic import ValidationError
from gateway.models import PlatformProject, PlatformShare, User, Device
from gateway.services.errors import GatewayError
from gateway.services import platform_shares
from gateway.services.task_share_projects import resolve_task_share_project


async def manage(call, device_id: str, user_id: str, message: dict) -> dict:
    project_id = message.get('host_project_id')
    action = message.get('action')
    payload = message.get('payload')
    if (message.get('version') != 1 or not isinstance(project_id,str) or not 1 <= len(project_id) <= 128
            or action not in ('list','create','revoke') or not isinstance(payload,dict)):
        raise GatewayError('invalid','Invalid share request.')
    async with call.database.session() as session:
        user = await session.get(User,user_id)
        device = await session.get(Device,device_id)
        if user is None or user.status != 'active' or device is None or device.status != 'active':
            raise GatewayError('forbidden','Gateway account or device is unavailable.')
        project = await resolve_task_share_project(session, device_id, user_id, project_id, create=action == 'create')
        await session.commit()
        if project is None:
            if action == 'list':
                return {'shares': []}
            raise GatewayError('not_found', 'Task project unavailable')
        if action == 'revoke':
            share_id = payload.get('share_id')
            if not isinstance(share_id,str) or not 1 <= len(share_id) <= 128:
                raise GatewayError('invalid','Invalid share ID.')
            share = await session.get(PlatformShare,share_id)
            if share is None or share.project_id != project.id or share.device_id != device_id:
                raise GatewayError('forbidden','Sharing is not part of the current project.')
    if action == 'create':
        try:
            body = platform_shares.CreateShareInput.model_validate({**payload,'project_id':project.id})
        except ValidationError as exc:
            raise GatewayError('invalid','Invalid sharing configuration. Please check the password, mode, and expiration time.') from exc
        result = await platform_shares.create_platform_share(call,body,_actor=user)
    elif action == 'list':
        task_id = payload.get('task_id')
        if not isinstance(task_id,str) or not 1 <= len(task_id) <= 128:
            raise GatewayError('invalid','Invalid task ID.')
        result = await platform_shares.list_own_platform_shares(call,project.id,task_id,_actor=user)
    else:
        await platform_shares.revoke_platform_share(call,payload['share_id'],_actor=user)
        result = {'ok':True}
    return json.loads(json.dumps(result,default=lambda value: value.isoformat() if isinstance(value,datetime) else str(value)))
