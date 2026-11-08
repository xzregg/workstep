"""Issue and atomically redeem one-use account setup and password reset links."""
from datetime import timedelta
from uuid import uuid4
import json
import secrets
import asyncio

from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError

from gateway.contracts import GatewayCall, ReplyEffects
from gateway.models import AuditEvent, AuthSession, User
from gateway.services.errors import GatewayError
from gateway.services.identity import IdentityService, _as_utc, _digest, _now
from gateway.services.identity_api import AccountInput, _limit_public_action, _set_session_cookie, _user_manager_request
from gateway.services.password_policy import validate_password


class InvitationInput(BaseModel):
    token: str = Field(min_length=32, max_length=128)


class AcceptInvitationInput(InvitationInput):
    username: str
    password: str = Field(min_length=8, max_length=128)

    @field_validator('username')
    @classmethod
    def valid_username(cls, value):
        return AccountInput.valid_username(value)


def eligible():
    return (User.is_recovery == 0, User.status.in_(['active', 'pending']))


def valid_invitation(token):
    return (*eligible(), User.invitation_token_hash == _digest(token),
            User.invitation_expires_at > _now())


def unavailable():
    return GatewayError('gone', '邀请链接已失效，请联系管理员重新获取。')


async def issue_invitation(call: GatewayCall, user_id: str):
    identity, actor = await _user_manager_request(call, user_id)
    if await identity.is_super_admin(user_id):
        await identity.require_super_admin(actor.id)
    async with call.database.session() as session:
        async with session.begin():
            # Lock before reading so simultaneous clicks return the same active link.
            result = await session.execute(update(User).where(User.id == user_id, *eligible()).values(
                invitation_token_hash=User.invitation_token_hash))
            if result.rowcount != 1:
                raise GatewayError('conflict', '停用、删除或受保护的账户不能获取邀请链接。')
            user = await session.get(User, user_id)
            if (user.invitation_token_hash and user.invitation_token_ciphertext
                    and user.invitation_expires_at and _as_utc(user.invitation_expires_at) > _now()):
                token = await asyncio.to_thread(call.gateway_signer.decrypt_provider_secret,
                                                'user-invitation:' + user_id, user.invitation_token_ciphertext)
                expires = _as_utc(user.invitation_expires_at)
            else:
                token = secrets.token_urlsafe(32)
                expires = _now() + timedelta(days=7)
                user.invitation_token_hash = _digest(token)
                user.invitation_expires_at = expires
                user.invitation_token_ciphertext = await asyncio.to_thread(
                    call.gateway_signer.encrypt_provider_secret, 'user-invitation:' + user_id, token)
                session.add(AuditEvent(id=str(uuid4()), user_id=actor.id,
                                       action='admin.user_invitation_issued', result='success',
                                       metadata_json=json.dumps({'target_user_id': user_id})))
    # A relative URL lets the browser use its current origin when no canonical address is configured.
    return {'url': f"{call.settings.public_origin or ''}/auth/invite#{token}", 'expires_at': expires.isoformat()}


async def inspect_invitation(call: GatewayCall, body: InvitationInput):
    await _limit_public_action(call, 'invitation_inspect')
    async with call.database.session() as session:
        user = await session.scalar(select(User).where(*valid_invitation(body.token)))
        if user is None:
            raise unavailable()
        return {'display_name': user.display_name, 'username': user.username if user.password_hash else ''}


async def accept_invitation(call: GatewayCall, response: ReplyEffects, body: AcceptInvitationInput):
    await _limit_public_action(call, 'invitation_accept')
    validate_password(body.username, body.password)
    async with call.database.session() as session:
        target = await session.scalar(select(User).where(*valid_invitation(body.token)))
        if target is None:
            raise unavailable()
        uid, original_hash = target.id, target.password_hash
    password_hash = await IdentityService._hash_password(body.password)
    try:
        async with call.database.session() as session:
            async with session.begin():
                # Conditional write consumes the token and sets credentials in one transaction.
                # A concurrent accept, rotation, disable or password change cannot reuse it.
                result = await session.execute(update(User).where(
                    User.id == uid, User.password_hash == original_hash, *valid_invitation(body.token)).values(
                    username=body.username, password_hash=password_hash, password_changed_at=_now(),
                    invitation_token_hash=None, invitation_expires_at=None,
                    invitation_token_ciphertext=None, must_change_password=0))
                if result.rowcount != 1:
                    raise unavailable()
                await session.execute(update(AuthSession).where(
                    AuthSession.user_id == uid, AuthSession.revoked_at.is_(None),
                ).values(revoked_at=_now()))
                user = await session.get(User, uid)
                session.add(AuditEvent(id=str(uuid4()), user_id=uid,
                                       action='account.invitation_accepted', result='success'))
                from gateway.services.login_policy import password_login_enabled
                token = None
                if user.status == 'active' and await password_login_enabled(session):
                    auth_session, token = IdentityService._create_session(uid)
                    session.add(auth_session)
                    user.last_login_at = _now()
                    from gateway.services.login_audit import add_login_audit
                    add_login_audit(session, user, 'password')
                result = {'status': user.status, 'signed_in': token is not None}
            if token:
                _set_session_cookie(response, token, call)
            return result
    except IntegrityError as exc:
        raise GatewayError('conflict', '登录名已被使用，请换一个。') from exc
