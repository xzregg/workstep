"""Public company subtitle configured by a verified platform administrator."""
import json
from uuid import uuid4

from pydantic import BaseModel, Field, field_validator

from gateway.contracts import GatewayCall
from gateway.models import AuditEvent, PlatformSetting


class CompanyDisplayNameInput(BaseModel):
    company_display_name: str = Field(max_length=100)

    @field_validator('company_display_name')
    @classmethod
    def normalize_name(cls, value: str) -> str:
        if any(ord(char) < 32 or ord(char) == 127 or char in '\u2028\u2029' for char in value):
            raise ValueError('Company display name must be a single line')
        return value.strip()


async def company_display_name(session) -> str:
    row = await session.get(PlatformSetting, 'company_display_name')
    return json.loads(row.value_json) if row else ''


async def set_company_display_name(call: GatewayCall, body: CompanyDisplayNameInput):
    from gateway.services.identity_api import _super_admin_request
    from gateway.services.identity import COOKIE_NAME
    identity, actor = await _super_admin_request(call)
    _, auth = await identity.session_user(call.tokens.get(COOKIE_NAME))
    await identity.require_step_up(auth)
    async with call.database.session() as session:
        async with session.begin():
            row = await session.get(PlatformSetting, 'company_display_name')
            if row:
                row.value_json = json.dumps(body.company_display_name)
                row.updated_by_user_id = actor.id
            else:
                session.add(PlatformSetting(key='company_display_name', value_json=json.dumps(body.company_display_name), updated_by_user_id=actor.id))
            session.add(AuditEvent(id=str(uuid4()), user_id=actor.id, action='admin.company_display_name_changed', result='success', metadata_json=json.dumps(body.model_dump())))
    return body.model_dump()
