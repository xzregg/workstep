"""Share management bound to the authenticated device control account."""
from datetime import datetime
import json
from sqlalchemy import select
from pydantic import ValidationError
from gateway.models import PlatformProject, PlatformShare, User, Device
from gateway.services.errors import GatewayError
from gateway.services import platform_shares


async def manage(call, device_id: str, user_id: str, message: dict) -> dict:
    project_id = message.get('host_project_id')
    action = message.get('action')
    payload = message.get('payload')
    if (message.get('version') != 1 or not isinstance(project_id,str) or not 1 <= len(project_id) <= 128
            or action not in ('list','create','revoke') or not isinstance(payload,dict)):
        raise GatewayError('invalid','无效的分享请求。')
    async with call.database.session() as session:
        user = await session.get(User,user_id)
        device = await session.get(Device,device_id)
        project = await session.scalar(select(PlatformProject).where(
            PlatformProject.device_id == device_id,PlatformProject.host_project_id == project_id))
        if user is None or user.status != 'active' or device is None or device.status != 'active':
            raise GatewayError('forbidden','网关账号或设备已不可用。')
        if project is None or project.status != 'active' or project.access_mode != 'remote_published':
            raise GatewayError('not_found','请先在项目设置中发布项目到网关，再分享任务。')
        if action == 'revoke':
            share_id = payload.get('share_id')
            if not isinstance(share_id,str) or not 1 <= len(share_id) <= 128:
                raise GatewayError('invalid','分享 ID 无效。')
            share = await session.get(PlatformShare,share_id)
            if share is None or share.project_id != project.id or share.device_id != device_id:
                raise GatewayError('forbidden','分享不属于当前项目。')
    if action == 'create':
        try:
            body = platform_shares.CreateShareInput.model_validate({**payload,'project_id':project.id})
        except ValidationError as exc:
            raise GatewayError('invalid','分享配置无效，请检查密码、模式及过期时间。') from exc
        result = await platform_shares.create_platform_share(call,body,_actor=user)
    elif action == 'list':
        task_id = payload.get('task_id')
        if not isinstance(task_id,str) or not 1 <= len(task_id) <= 128:
            raise GatewayError('invalid','任务 ID 无效。')
        result = await platform_shares.list_own_platform_shares(call,project.id,task_id,_actor=user)
    else:
        await platform_shares.revoke_platform_share(call,payload['share_id'],_actor=user)
        result = {'ok':True}
    return json.loads(json.dumps(result,default=lambda value: value.isoformat() if isinstance(value,datetime) else str(value)))
