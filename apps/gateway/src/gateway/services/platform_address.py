"""Persist the administrator's canonical Gateway address."""
import json
from uuid import uuid4
from urllib.parse import urlsplit
from pydantic import BaseModel, Field, field_validator
from workstep_gateway_protocol.origin import validate_gateway_origin
from gateway.contracts import GatewayCall
from gateway.models import AuditEvent, PlatformSetting


class PlatformAddressInput(BaseModel):
    public_origin: str
    allowed_origins: list[str] = Field(default_factory=list, max_length=32)

    @field_validator('public_origin')
    @classmethod
    def canonical_origin(cls, value: str) -> str:
        return validate_gateway_origin(value.strip().removesuffix('/'))

    @field_validator('allowed_origins')
    @classmethod
    def valid_allowed_origins(cls, values):
        return list(dict.fromkeys(cls.canonical_origin(value) for value in values))


def request_platform_origin(call: GatewayCall) -> str:
    # Match the actual request host only; never trust arbitrary Origin/Forwarded headers.
    origin = ('https' if call.target.scheme == 'wss' else 'http' if call.target.scheme == 'ws' else call.target.scheme) + '://' + call.target.netloc
    allowed = call.settings.platform_origins
    if origin in allowed:
        return origin
    # Reverse proxies can terminate TLS while retaining the public Host.
    for candidate in allowed:
        if urlsplit(candidate).netloc == call.target.netloc:
            return candidate
    return call.settings.public_origin or origin


async def restore_platform_address(database, settings):
    async with database.session() as session:
        row = await session.get(PlatformSetting, 'public_origin')
        if row:
            settings.public_origin = PlatformAddressInput(public_origin=json.loads(row.value_json)).public_origin
        aliases = await session.get(PlatformSetting, 'allowed_origins')
        if aliases:
            settings.allowed_origins = PlatformAddressInput.valid_allowed_origins(json.loads(aliases.value_json))


async def set_platform_address(call: GatewayCall, body: PlatformAddressInput):
    from gateway.services.identity_api import _super_admin_request
    from gateway.services.identity import COOKIE_NAME
    identity, actor = await _super_admin_request(call)
    _, auth = await identity.session_user(call.tokens.get(COOKIE_NAME))
    await identity.require_step_up(auth)
    async with call.database.session() as session:
        async with session.begin():
            for key, value in body.model_dump().items():
                row = await session.get(PlatformSetting, key)
                if row:
                    row.value_json = json.dumps(value)
                    row.updated_by_user_id = actor.id
                else:
                    session.add(PlatformSetting(key=key, value_json=json.dumps(value), updated_by_user_id=actor.id))
            session.add(AuditEvent(id=str(uuid4()), user_id=actor.id, action='admin.platform_address_changed', result='success', metadata_json=json.dumps(body.model_dump())))
    call.settings.public_origin = body.public_origin
    call.settings.allowed_origins = body.allowed_origins
    return body.model_dump()
