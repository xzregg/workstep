"""Exact callback allowlist and request-bound, single-use website login codes."""
import json
import re
import secrets
from datetime import timedelta
from urllib.parse import parse_qsl, urlencode, urlsplit
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import delete, update

from gateway.contracts import GatewayCall, JsonValue
from gateway.models import AuditEvent, PlatformSetting, ThirdPartyAuthCode, User
from gateway.services.errors import GatewayError
from gateway.services.identity import COOKIE_NAME, IdentityService, _digest, _now
from gateway.services.identity_api import _check_csrf, _super_admin_read, _super_admin_request

SETTING_KEY = 'third_party_auth_callback_urls'
NO_STORE = {'Cache-Control': 'no-store', 'Pragma': 'no-cache', 'Referrer-Policy': 'no-referrer'}


def validate_callback(value: str) -> str:
    # Keep the original string: registration and authorization must match exactly.
    if not value or len(value) > 2048 or not re.fullmatch(r'[\x21-\x7e]+', value) or '\\' in value:
        raise ValueError('Invalid callback URL')
    try:
        parsed = urlsplit(value)
        port = parsed.port
        if (parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username is not None
                or parsed.password is not None or '#' in value or '*' in parsed.netloc
                or '%' in parsed.netloc or port == 0
                or not re.fullmatch(r'[A-Za-z0-9.\-:\[\]]+(?::[0-9]+)?', parsed.netloc)
                or any(key.lower() in ('code', 'state', 'request_id') for key, _ in parse_qsl(parsed.query))
                or re.search(r'%(?:0[0-9a-f]|1[0-9a-f]|7f)', value, re.I)):
            raise ValueError('Invalid callback URL')
    except ValueError as exc:
        raise ValueError('Invalid callback URL') from exc
    return value


class CallbackSettingsInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    callback_urls: list[str] = Field(max_length=100)

    @field_validator('callback_urls')
    @classmethod
    def valid_urls(cls, values):
        return list(dict.fromkeys(validate_callback(value) for value in values))


class AuthorizeInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    callback: str = Field(min_length=1, max_length=2048)
    state: str = Field(min_length=1, max_length=256, pattern=r'^[A-Za-z0-9._~-]+$')
    request_id: str = Field(min_length=32, max_length=128, pattern=r'^[A-Za-z0-9_-]+$')

    @field_validator('callback')
    @classmethod
    def valid_url(cls, value):
        return validate_callback(value)


class ExchangeInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    code: str = Field(min_length=1, max_length=128, pattern=r'^[A-Za-z0-9_-]+$')
    request_id: str = Field(min_length=32, max_length=128, pattern=r'^[A-Za-z0-9_-]+$')


async def callback_urls(session) -> list[str]:
    row = await session.get(PlatformSetting, SETTING_KEY)
    return json.loads(row.value_json) if row else []


async def get_settings(call: GatewayCall):
    await _super_admin_read(call)
    async with call.database.session() as session:
        return {'callback_urls': await callback_urls(session)}


async def set_settings(call: GatewayCall, body: CallbackSettingsInput):
    identity, actor = await _super_admin_request(call)
    _, auth = await identity.session_user(call.tokens.get(COOKIE_NAME))
    await identity.require_step_up(auth)
    async with call.database.session() as session:
        async with session.begin():
            # Serialize configuration writes using the same initialized row as other policies.
            await session.execute(update(PlatformSetting).where(PlatformSetting.key == 'platform_initialized').values(value_json='true'))
            row = await session.get(PlatformSetting, SETTING_KEY)
            if row is None:
                session.add(PlatformSetting(key=SETTING_KEY, value_json=json.dumps(body.callback_urls), updated_by_user_id=actor.id))
            else:
                row.value_json = json.dumps(body.callback_urls)
                row.updated_by_user_id = actor.id
            # Removed destinations invalidate outstanding codes even if added again later.
            await session.execute(delete(ThirdPartyAuthCode).where(ThirdPartyAuthCode.callback.not_in(body.callback_urls)))
            session.add(AuditEvent(id=str(uuid4()), user_id=actor.id, action='admin.third_party_auth_changed',
                                   result='success', metadata_json=json.dumps({'callback_urls': body.callback_urls})))
    return {'callback_urls': body.callback_urls}


async def validate_authorization(call: GatewayCall, body: AuthorizeInput):
    async with call.database.session() as session:
        if body.callback not in await callback_urls(session):
            raise GatewayError('forbidden', '回调地址未获授权，请联系网关管理员。')
    return JsonValue({'valid': True}, headers=NO_STORE)


async def authorize(call: GatewayCall, body: AuthorizeInput):
    user, _ = await IdentityService(call.database).session_user(call.tokens.get(COOKIE_NAME))
    _check_csrf(call, call.tokens.get(COOKIE_NAME))
    await call.identity_rate_limiter.check('third_party_authorize', user.id)
    code = secrets.token_urlsafe(32)
    async with call.database.session() as session:
        async with session.begin():
            # Lock the policy before checking it, also serializing with allowlist deletion.
            await session.execute(update(PlatformSetting).where(PlatformSetting.key == 'platform_initialized').values(value_json='true'))
            if body.callback not in await callback_urls(session):
                raise GatewayError('forbidden', '回调地址未获授权，请联系网关管理员。')
            current = await session.get(User, user.id)
            if current is None or current.status != 'active':
                raise GatewayError('forbidden', '账号不可用。')
            await session.execute(delete(ThirdPartyAuthCode).where(ThirdPartyAuthCode.expires_at <= _now()))
            session.add(ThirdPartyAuthCode(code_hash=_digest(code), request_id_hash=_digest(body.request_id),
                user_id=user.id, callback=body.callback, expires_at=_now() + timedelta(minutes=2)))
    separator = '&' if '?' in body.callback else '?'
    return JsonValue({'callback_url': body.callback + separator + urlencode({'code':code, 'state':body.state})}, headers=NO_STORE)


async def exchange(call: GatewayCall, body: ExchangeInput):
    await call.identity_rate_limiter.check('third_party_exchange', call.peer.host if call.peer else 'unknown')
    async with call.database.session() as session:
        async with session.begin():
            claimed = (await session.execute(update(ThirdPartyAuthCode).where(
                ThirdPartyAuthCode.code_hash == _digest(body.code),
                ThirdPartyAuthCode.request_id_hash == _digest(body.request_id),
                ThirdPartyAuthCode.used_at.is_(None), ThirdPartyAuthCode.expires_at > _now(),
            ).values(used_at=_now()).returning(ThirdPartyAuthCode.user_id, ThirdPartyAuthCode.callback))).first()
            if claimed is None:
                raise GatewayError('bad_input', '授权码无效、已使用或已过期，请重新登录。')
            user = await session.get(User, claimed.user_id)
            if user is None or user.status != 'active' or claimed.callback not in await callback_urls(session):
                raise GatewayError('forbidden', '账号或回调授权已不可用。')
            session.add(AuditEvent(id=str(uuid4()), user_id=user.id, action='auth.third_party_exchanged', result='success'))
            result = {'id':user.id, 'username':user.username, 'display_name':user.display_name}
    return JsonValue({'user':result}, headers=NO_STORE)
