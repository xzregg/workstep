"""Platform password sign-in policy and public enterprise sign-in choices."""
import json
import os
from uuid import uuid4
from pydantic import BaseModel
from sqlalchemy import select, update
from gateway.contracts import GatewayCall
from gateway.models import AuditEvent, IdentitySource, PlatformSetting
from gateway.services.errors import GatewayError


async def password_login_enabled(session):
    row = await session.get(PlatformSetting, 'password_login_enabled')
    return json.loads(row.value_json) if row else True


async def scan_sources(session):
    rows = (await session.execute(select(IdentitySource, PlatformSetting).outerjoin(
        PlatformSetting, PlatformSetting.key == 'identity-options:' + IdentitySource.id
    ).where(IdentitySource.enabled == 1, IdentitySource.provider.in_(['dingtalk', 'wecom']))
        .order_by(IdentitySource.created_at, IdentitySource.id))).all()
    return [(source, json.loads(setting.value_json) if setting else {}) for source, setting in rows
            if not setting or json.loads(setting.value_json).get('login_enabled', True)]


async def ensure_login_method(session):
    if await password_login_enabled(session):
        return
    if not any(options.get('encrypted_secret') or os.environ.get(source.secret_env)
               for source, options in await scan_sources(session)):
        raise GatewayError('conflict', 'Configure at least one enabled enterprise sign-in application')


class LoginPolicyInput(BaseModel):
    password_login_enabled: bool


async def set_login_policy(call: GatewayCall, body: LoginPolicyInput):
    from gateway.services.identity_api import _super_admin_request
    from gateway.services.identity import COOKIE_NAME
    identity, actor = await _super_admin_request(call)
    _, auth = await identity.session_user(call.tokens.get(COOKIE_NAME))
    await identity.require_step_up(auth)
    async with call.database.session() as session:
        async with session.begin():
            await session.execute(update(PlatformSetting).where(
                PlatformSetting.key == 'platform_initialized').values(value_json='true'))
            row = await session.get(PlatformSetting, 'password_login_enabled')
            if row:
                row.value_json = json.dumps(body.password_login_enabled)
                row.updated_by_user_id = actor.id
            else:
                session.add(PlatformSetting(key='password_login_enabled', value_json=json.dumps(body.password_login_enabled), updated_by_user_id=actor.id))
            await session.flush()
            await ensure_login_method(session)
            session.add(AuditEvent(id=str(uuid4()), user_id=actor.id, action='admin.login_policy_changed', result='success',
                metadata_json=json.dumps({'password_login_enabled': body.password_login_enabled})))
    return {'password_login_enabled': body.password_login_enabled}
