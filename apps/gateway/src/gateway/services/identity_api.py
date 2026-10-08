from gateway.services.errors import GatewayError
from gateway.contracts import GatewayCall, ReplyEffects, CredentialGrant
import hmac

import re

from typing import Literal


from pydantic import BaseModel, Field, field_validator, model_validator

from sqlalchemy import func, or_, select

from gateway.services.identity_errors import IdentityError
from gateway.services.identity import COOKIE_NAME, SESSION_SECONDS, IdentityService, csrf_token, public_user

from gateway.models import DeviceGroup, AdminAssignment, DirectoryDepartment, IdentitySource, User


"""Browser-facing Gateway account entry points."""


USERNAME = re.compile(r"^[a-z][a-z0-9_-]{2,63}$")


class AccountInput(BaseModel):
    username: str
    display_name: str = Field(min_length=1, max_length=256)
    password: str = Field(min_length=8, max_length=128)

    @field_validator("username")
    @classmethod
    def valid_username(cls, value: str) -> str:
        if not USERNAME.fullmatch(value):
            raise ValueError("Username must be lowercase ASCII without spaces")
        return value

    @field_validator("display_name")
    @classmethod
    def nonblank_name(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Display name is required")
        return value.strip()


class SetupInput(AccountInput):
    recovery_username: str
    recovery_password: str = Field(min_length=8, max_length=128)
    registration_mode: Literal["open", "open_with_approval", "closed"]

    @model_validator(mode="after")
    def distinct_recovery(self):
        if not USERNAME.fullmatch(self.recovery_username) or self.recovery_username == self.username:
            raise ValueError("Recovery username must be distinct and valid")
        if self.recovery_password == self.password:
            raise ValueError("Recovery password must be distinct")
        return self


class LoginInput(BaseModel):
    username: str
    password: str


class ChangePasswordInput(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8, max_length=128)


class StepUpInput(BaseModel):
    password: str


class ResetPasswordInput(BaseModel):
    new_password: str = Field(min_length=8, max_length=128)


class AdminCreateInput(AccountInput):
    status: Literal["active", "pending"] = "active"


class GrantRoleInput(BaseModel):
    role: Literal["identity_admin", "org_admin", "department_admin", "device_admin", "skill_admin", "audit_admin", "super_admin"]
    scope_type: Literal["platform", "organization", "department", "device_group"] = "platform"
    scope_id: str | None = None
    include_subdepartments: bool = True

    @model_validator(mode="after")
    def valid_scope(self):
        if self.role in ("super_admin", "skill_admin") and self.scope_type != "platform":
            raise ValueError("This administrator role requires platform scope")
        allowed = {
            "super_admin": {"platform"}, "skill_admin": {"platform"},
            "identity_admin": {"platform", "department"},
            "org_admin": {"platform", "organization"},
            "department_admin": {"department"},
            "device_admin": {"platform", "device_group"},
            "audit_admin": {"platform", "organization", "department", "device_group"},
        }
        if self.scope_type not in allowed[self.role]:
            raise ValueError("Invalid scope for administrator role")
        if (self.scope_type == "platform") != (self.scope_id is None):
            raise ValueError("Scope ID required only for a scoped assignment")
        return self


class RegistrationPolicyInput(BaseModel):
    mode: Literal["open", "open_with_approval", "closed"]


def _identity(call: GatewayCall) -> IdentityService:
    return IdentityService(call.database)


async def _limit_public_action(call: GatewayCall, action: str) -> None:
    ip = call.peer.host if call.peer else 'unknown'
    await call.identity_rate_limiter.check(action, ip)


def _set_session_cookie(response: ReplyEffects, token: str, call: GatewayCall) -> None:
    response.grants.append(CredentialGrant(COOKIE_NAME, token, lifetime=SESSION_SECONDS))


def _check_csrf(call: GatewayCall, token: str) -> None:
    provided = call.proofs.get('X-CSRF-Token', '')
    if not hmac.compare_digest(provided, csrf_token(token)):
        raise GatewayError('forbidden', 'CSRF token required')


async def _active_admin_roles(call: GatewayCall, user_id: str) -> list[str]:
    async with call.database.session() as database_session:
        roles = (await database_session.scalars(select(AdminAssignment.role).where(
            AdminAssignment.user_id == user_id,
            AdminAssignment.revoked_at.is_(None),
        ))).all()
    return sorted(set(roles))


async def _super_admin_request(call: GatewayCall):
    token = call.tokens.get(COOKIE_NAME)
    identity = _identity(call)
    user, _ = await identity.session_user(token)
    _check_csrf(call, token)
    if user.must_change_password:
        raise GatewayError('forbidden', 'Password change required')
    await identity.require_super_admin(user.id)
    return identity, user


async def _super_admin_read(call: GatewayCall):
    identity = _identity(call)
    user, _ = await identity.session_user(call.tokens.get(COOKIE_NAME))
    if user.must_change_password:
        raise GatewayError('forbidden', 'Password change required')
    await identity.require_super_admin(user.id)
    return identity, user


async def _user_manager_request(call: GatewayCall, target_user_id: str | None = None,
                                platform_only: bool = False):
    token = call.tokens.get(COOKIE_NAME)
    identity = _identity(call)
    user, _ = await identity.session_user(token)
    _check_csrf(call, token)
    if user.must_change_password:
        raise GatewayError('forbidden', 'Password change required')
    await identity.require_user_manager(user.id, target_user_id, platform_only)
    return identity, user


DELEGATED_ROLES = ("identity_admin", "department_admin", "audit_admin")


async def _role_manager(call: GatewayCall, *, mutation=False):
    from .management_scope import organization_manager
    identity = _identity(call)
    actor, auth_session = await identity.session_user(call.tokens.get(COOKIE_NAME))
    if actor.must_change_password:
        raise GatewayError('forbidden', 'Password change required')
    if mutation:
        _check_csrf(call, call.tokens.get(COOKIE_NAME))
        await identity.require_step_up(auth_session)
    try:
        await identity.require_super_admin(actor.id)
        return identity, actor, None, None
    except IdentityError as exc:
        if exc.reason != "forbidden":
            raise
    await organization_manager(call)
    async with call.database.session() as session:
        departments = await identity.manageable_department_ids(session, actor.id, roles=("org_admin",))
        users = await identity.manageable_user_ids(session, actor.id, roles=("org_admin",))
    return identity, actor, departments, users


def _check_delegated_role(body, user_id, departments, users):
    if (body.role not in DELEGATED_ROLES or body.scope_type != "department"
            or (departments is not None and body.scope_id not in departments)
            or (users is not None and user_id not in users)):
        raise GatewayError('forbidden', 'Administrator delegation scope denied')


async def setup(call: GatewayCall, response: ReplyEffects, body: SetupInput):
    user, token = await _identity(call).setup(body.username, body.display_name, body.password, body.recovery_username, body.recovery_password, body.registration_mode)
    _set_session_cookie(response, token, call)
    return {"user": public_user(user), "csrf_token": csrf_token(token)}


async def platform_status(call: GatewayCall):
    return {"initialized": await _identity(call).initialized()}


async def register(call: GatewayCall, response: ReplyEffects, body: AccountInput):
    await _limit_public_action(call, 'register')
    user, token = await _identity(call).register(body.username, body.display_name, body.password)
    response.phase = 'created' if token else 'pending'
    if token:
        _set_session_cookie(response, token, call)
        return {"user": public_user(user), "csrf_token": csrf_token(token)}
    return {"user": public_user(user)}


async def registration_policy(call: GatewayCall):
    from gateway.services.login_policy import password_login_enabled
    async with call.database.session() as session:
        enabled = await password_login_enabled(session)
    return {"mode": await _identity(call).registration_mode() if enabled else 'closed',
            "password_login_enabled": enabled}


async def login(call: GatewayCall, response: ReplyEffects, body: LoginInput):
    await _limit_public_action(call, 'login')
    user, token = await _identity(call).login(body.username, body.password)
    _set_session_cookie(response, token, call)
    return {"user": public_user(user), "csrf_token": csrf_token(token)}


async def session(call: GatewayCall):
    token = call.tokens.get(COOKIE_NAME)
    user, _ = await _identity(call).session_user(token)
    return {"user": public_user(user), "csrf_token": csrf_token(token),
            "admin_roles": await _active_admin_roles(call, user.id)}


async def admin_access(call: GatewayCall):
    user, _ = await _identity(call).session_user(call.tokens.get(COOKIE_NAME))
    return {"roles": await _active_admin_roles(call, user.id),
            "must_change_password": bool(user.must_change_password)}


async def logout(call: GatewayCall, response: ReplyEffects):
    token = call.tokens.get(COOKIE_NAME)
    await _identity(call).session_user(token)
    _check_csrf(call, token)
    await _identity(call).logout(token)
    response.grants.append(CredentialGrant(COOKIE_NAME))


async def change_password(call: GatewayCall, body: ChangePasswordInput):
    token = call.tokens.get(COOKIE_NAME)
    identity = _identity(call)
    user, auth_session = await identity.session_user(token)
    _check_csrf(call, token)
    await identity.change_password(user, auth_session, body.current_password, body.new_password)


async def step_up(call: GatewayCall, body: StepUpInput):
    token = call.tokens.get(COOKIE_NAME)
    identity = _identity(call)
    user, auth_session = await identity.session_user(token)
    _check_csrf(call, token)
    await identity.step_up(user, auth_session, body.password)
    return {"expires_in_seconds": 300}


async def admin_create_user(call: GatewayCall, body: AdminCreateInput):
    identity, actor = await _user_manager_request(call, platform_only=True)
    user = await identity.admin_create_user(
        body.username, body.display_name, body.password, body.status, actor.id,
    )
    return public_user(user)


async def admin_list_users(call: GatewayCall, q: str = '',
                           group_id: str | None = None,
                           status: Literal["active", "pending", "disabled", "deleted"] | None = None,
                           sort: Literal["username", "display_name", "created_at"] = "created_at",
                           direction: Literal["asc", "desc"] = "desc",
                           page: int = 1, page_size: int = 25):
    identity = _identity(call)
    actor, _ = await identity.session_user(call.tokens.get(COOKIE_NAME))
    if actor.must_change_password:
        raise GatewayError('forbidden', 'Password change required')
    async with call.database.session() as session:
        scoped_ids = await identity.manageable_user_ids(session, actor.id)
        conditions = []
        if scoped_ids is not None:
            conditions.append(User.id.in_(scoped_ids))
        if group_id:
            from gateway.models import GroupMembership, UserGroup
            group = await session.get(UserGroup, group_id)
            if group is None or group.status != 'active': raise GatewayError('not_found', 'Group unavailable')
            conditions.append(User.id.in_(select(GroupMembership.user_id).where(GroupMembership.group_id == group_id, GroupMembership.revoked_at.is_(None))))
        if status:
            conditions.append(User.status == status)
        else:
            conditions.append(User.status != 'deleted')
        if q.strip():
            escaped = q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            pattern = f"%{escaped}%"
            conditions.append(or_(User.username.ilike(pattern, escape="\\"),
                                  User.display_name.ilike(pattern, escape="\\")))
        total = await session.scalar(select(func.count()).select_from(User).where(*conditions))
        column = {"username": User.username, "display_name": User.display_name,
                  "created_at": User.created_at}[sort]
        ordered = column.asc() if direction == "asc" else column.desc()
        rows = (await session.scalars(select(User).where(*conditions)
            .order_by(ordered, User.id).offset((page - 1) * page_size).limit(page_size))).all()
        users = [{**public_user(user), "registration_source": user.registration_source,
                  "login_username": user.username if user.password_hash else None,
                  "is_recovery": bool(user.is_recovery),
                  "created_at": user.created_at.isoformat()} for user in rows]
    return {"users": users, "total": total, "page": page, "page_size": page_size}


async def admin_approve_user(call: GatewayCall, user_id: str):
    identity, _ = await _user_manager_request(call, user_id)
    await identity.approve_user(user_id)


async def admin_disable_user(call: GatewayCall, user_id: str):
    identity, actor = await _user_manager_request(call, user_id)
    if await identity.is_super_admin(user_id):
        await identity.require_super_admin(actor.id)
        _, auth_session = await identity.session_user(call.tokens.get(COOKIE_NAME))
        await identity.require_step_up(auth_session)
    await identity.disable_user(user_id)


async def admin_grant_role(call: GatewayCall, user_id: str, body: GrantRoleInput):
    identity, actor, departments, users = await _role_manager(call, mutation=True)
    if 'super_admin' not in await _active_admin_roles(call, actor.id):
        _check_delegated_role(body, user_id, departments, users)
    assignment = await identity.grant_role(
        actor.id, user_id, body.role, body.scope_type, body.scope_id,
        body.include_subdepartments,
    )
    return {"id": assignment.id, "user_id": assignment.user_id, "role": assignment.role,
            "scope_type": assignment.scope_type, "scope_id": assignment.scope_id,
            "include_subdepartments": bool(assignment.include_subdepartments)}


async def admin_list_roles(call: GatewayCall, q: str = '',
                           role: Literal["identity_admin", "org_admin", "department_admin", "device_admin", "skill_admin", "audit_admin", "super_admin"] | None = None,
                           sort: Literal["created_at", "username", "role"] = "created_at",
                           direction: Literal["asc", "desc"] = "desc",
                           page: int = 1, page_size: int = 25):
    identity, actor, departments, users = await _role_manager(call)
    conditions = [AdminAssignment.revoked_at.is_(None)]
    if 'super_admin' not in await _active_admin_roles(call, actor.id):
        conditions.extend([AdminAssignment.role.in_(DELEGATED_ROLES), AdminAssignment.scope_type == "department"])
        if departments is not None:
            conditions.append(AdminAssignment.scope_id.in_(departments))
        if users is not None:
            conditions.append(AdminAssignment.user_id.in_(users))
    if role:
        conditions.append(AdminAssignment.role == role)
    if q.strip():
        escaped = q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        pattern = f"%{escaped}%"
        conditions.append(or_(User.username.ilike(pattern, escape="\\"),
                              User.display_name.ilike(pattern, escape="\\")))
    column = {"created_at": AdminAssignment.created_at, "username": User.username,
              "role": AdminAssignment.role}[sort]
    ordered = column.asc() if direction == "asc" else column.desc()
    async with call.database.session() as session:
        joined = (select(AdminAssignment, User, func.coalesce(DirectoryDepartment.display_name, DeviceGroup.name, IdentitySource.tenant_id))
                  .join(User).outerjoin(DirectoryDepartment,
                                        DirectoryDepartment.id == AdminAssignment.scope_id)
                  .outerjoin(DeviceGroup, DeviceGroup.id == AdminAssignment.scope_id)
                  .outerjoin(IdentitySource, IdentitySource.id == AdminAssignment.scope_id).where(*conditions))
        total = await session.scalar(select(func.count()).select_from(AdminAssignment).join(User).where(*conditions))
        rows = (await session.execute(joined.order_by(ordered, AdminAssignment.id)
            .offset((page - 1) * page_size).limit(page_size))).all()
        roles = [{"id": assignment.id, "user_id": user.id,
                  "username": user.username, "display_name": user.display_name,
                  "user_status": user.status, "registration_source": user.registration_source,
                  "role": assignment.role, "scope_type": assignment.scope_type,
                  "scope_id": assignment.scope_id, "scope_name": scope_name,
                  "include_subdepartments": bool(assignment.include_subdepartments),
                  "granted_by_user_id": assignment.granted_by_user_id,
                  "created_at": assignment.created_at.isoformat()} for assignment, user, scope_name in rows]
    return {"roles": roles, "total": total, "page": page, "page_size": page_size}


async def admin_revoke_role(call: GatewayCall, assignment_id: str):
    identity, actor, departments, users = await _role_manager(call, mutation=True)
    if 'super_admin' not in await _active_admin_roles(call, actor.id):
        async with call.database.session() as session:
            assignment = await session.get(AdminAssignment, assignment_id)
            if not assignment:
                raise GatewayError('not_found', 'Assignment unavailable')
            _check_delegated_role(assignment, assignment.user_id, departments, users)
    await identity.revoke_role(actor.id, assignment_id)


async def admin_list_departments(call: GatewayCall, q: str = '',
                                 sort: Literal["display_name", "external_id"] = "display_name",
                                 direction: Literal["asc", "desc"] = "asc",
                                 page: int = 1, page_size: int = 25):
    await _super_admin_read(call)
    conditions = [DirectoryDepartment.active == 1]
    if q.strip():
        escaped = q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        pattern = f"%{escaped}%"
        conditions.append(or_(DirectoryDepartment.display_name.ilike(pattern, escape="\\"),
                              DirectoryDepartment.external_id.ilike(pattern, escape="\\")))
    column = {"display_name": DirectoryDepartment.display_name,
              "external_id": DirectoryDepartment.external_id}[sort]
    ordered = column.asc() if direction == "asc" else column.desc()
    async with call.database.session() as session:
        total = await session.scalar(select(func.count()).select_from(DirectoryDepartment).where(*conditions))
        rows = (await session.execute(select(DirectoryDepartment, IdentitySource.provider)
            .join(IdentitySource, IdentitySource.id == DirectoryDepartment.source_id)
            .where(*conditions).order_by(ordered, DirectoryDepartment.id)
            .offset((page - 1) * page_size).limit(page_size))).all()
        departments = [{"id": department.id, "display_name": department.display_name,
                        "external_id": department.external_id, "source_id": department.source_id,
                        "provider": provider, "parent_external_id": department.parent_external_id}
                       for department, provider in rows]
    return {"departments": departments, "total": total, "page": page, "page_size": page_size}


async def admin_set_registration_policy(call: GatewayCall, body: RegistrationPolicyInput):
    identity, actor = await _super_admin_request(call)
    _, auth_session = await identity.session_user(call.tokens.get(COOKIE_NAME))
    await identity.require_step_up(auth_session)
    await identity.set_registration_mode(body.mode, actor.id)
    return {"mode": body.mode}


async def admin_platform_settings(call: GatewayCall):
    identity, _ = await _super_admin_read(call)
    settings = call.settings
    from gateway.services.login_policy import password_login_enabled
    async with call.database.session() as session:
        enabled = await password_login_enabled(session)
    return {
        "gateway_id": settings.gateway_id,
        "public_origin": settings.public_origin,
        "registration_mode": await identity.registration_mode(),
        "password_login_enabled": enabled,
        "session_seconds": SESSION_SECONDS,
        "protocol_version": call.protocol_version,
        "data_dir": str(settings.data_dir),
        "database": await call.database.status(),
    }


async def admin_reset_password(call: GatewayCall, user_id: str, body: ResetPasswordInput):
    identity, _ = await _super_admin_request(call)
    _, auth_session = await identity.session_user(call.tokens.get(COOKIE_NAME))
    await identity.require_step_up(auth_session)
    await identity.reset_password(user_id, body.new_password)
