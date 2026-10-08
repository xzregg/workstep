"""Persist the administrator's canonical Gateway address."""
import json
from uuid import uuid4
from pydantic import BaseModel, field_validator
from workstep_gateway_protocol.origin import validate_gateway_origin
from gateway.contracts import GatewayCall
from gateway.models import AuditEvent, PlatformSetting


class PlatformAddressInput(BaseModel):
    public_origin: str

    @field_validator('public_origin')
    @classmethod
    def canonical_origin(cls, value: str) -> str:
        return validate_gateway_origin(value.strip().removesuffix('/'))


async def restore_platform_address(database, settings):
    async with database.session() as session:
        row = await session.get(PlatformSetting, 'public_origin')
        if row:
            settings.public_origin = PlatformAddressInput(public_origin=json.loads(row.value_json)).public_origin


async def set_platform_address(call: GatewayCall, body: PlatformAddressInput):
    from gateway.services.identity_api import _super_admin_request
    from gateway.services.identity import COOKIE_NAME
    identity, actor = await _super_admin_request(call)
    _, auth = await identity.session_user(call.tokens.get(COOKIE_NAME))
    await identity.require_step_up(auth)
    async with call.database.session() as session:
        async with session.begin():
            row = await session.get(PlatformSetting, 'public_origin')
            if row:
                row.value_json = json.dumps(body.public_origin)
                row.updated_by_user_id = actor.id
            else:
                session.add(PlatformSetting(key='public_origin', value_json=json.dumps(body.public_origin), updated_by_user_id=actor.id))
            session.add(AuditEvent(id=str(uuid4()), user_id=actor.id, action='admin.platform_address_changed', result='success', metadata_json=json.dumps({'public_origin': body.public_origin})))
    call.settings.public_origin = body.public_origin
    return {'public_origin': body.public_origin}
