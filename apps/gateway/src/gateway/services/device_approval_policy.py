"""Administrator-controlled approval for newly registered devices."""
import json
from typing import Literal
from uuid import uuid4
from pydantic import BaseModel
from gateway.models import PlatformSetting, AuditEvent
from gateway.services.identity_api import _super_admin_request
from gateway.services.identity import COOKIE_NAME

class DeviceApprovalPolicyInput(BaseModel):
    mode: Literal['manual', 'automatic']

async def device_approval_mode(session):
    row = await session.get(PlatformSetting, 'device_approval_mode')
    return 'automatic' if row and row.value_json == '"automatic"' else 'manual'

async def set_device_approval_policy(call, body):
    identity, actor = await _super_admin_request(call)
    _, auth = await identity.session_user(call.tokens.get(COOKIE_NAME))
    await identity.require_step_up(auth)
    async with call.database.session() as session:
        async with session.begin():
            row = await session.get(PlatformSetting, 'device_approval_mode')
            if row: row.value_json = json.dumps(body.mode); row.updated_by_user_id = actor.id
            else: session.add(PlatformSetting(key='device_approval_mode', value_json=json.dumps(body.mode), updated_by_user_id=actor.id))
            session.add(AuditEvent(id=str(uuid4()), user_id=actor.id, action='admin.device_approval_policy_changed', result='success', metadata_json=json.dumps({'mode': body.mode})))
    return {'mode': body.mode}
