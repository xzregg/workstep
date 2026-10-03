import hmac

import re

from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request, Response

from pydantic import BaseModel, Field, field_validator, model_validator

from sqlalchemy import func, or_, select

from gateway.services.identity import COOKIE_NAME, SESSION_SECONDS, IdentityService, csrf_token, public_user

from gateway.models import DeviceGroup, AdminAssignment, DirectoryDepartment, IdentitySource, User


"""Browser-facing Gateway account entry points."""


USERNAME = re.compile(r"^[a-z][a-z0-9_-]{2,63}$")


class AccountInput(BaseModel):
    username: str
    display_name: str = Field(min_length=1, max_length=256)
    password: str = Field(min_length=12, max_length=128)

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
    recovery_password: str = Field(min_length=12, max_length=128)
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
    new_password: str = Field(min_length=12, max_length=128)


class StepUpInput(BaseModel):
    password: str


class ResetPasswordInput(BaseModel):
    new_password: str = Field(min_length=12, max_length=128)


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


def _identity(request: Request) -> IdentityService:
    return IdentityService(request.app.state.database)


async def _limit_public_action(request: Request, action: str) -> None:
    ip = request.client.host if request.client else "unknown"
    await request.app.state.identity_rate_limiter.check(action, ip)


def _set_session_cookie(response: Response, token: str, request: Request) -> None:
    response.set_cookie(
        COOKIE_NAME, token, max_age=SESSION_SECONDS,
        secure=request.app.state.settings.cookie_secure, httponly=True, samesite="lax", path="/",
    )


def _check_csrf(request: Request, token: str) -> None:
    provided = request.headers.get("X-CSRF-Token", "")
    if not hmac.compare_digest(provided, csrf_token(token)):
        raise HTTPException(status_code=403, detail="CSRF token required")


async def _active_admin_roles(request: Request, user_id: str) -> list[str]:
    async with request.app.state.database.session() as database_session:
        roles = (await database_session.scalars(select(AdminAssignment.role).where(
            AdminAssignment.user_id == user_id,
            AdminAssignment.revoked_at.is_(None),
        ))).all()
    return sorted(set(roles))


async def _super_admin_request(request: Request):
    token = request.cookies.get(COOKIE_NAME)
    identity = _identity(request)
    user, _ = await identity.session_user(token)
    _check_csrf(request, token)
    if user.must_change_password:
        raise HTTPException(status_code=403, detail="Password change required")
    await identity.require_super_admin(user.id)
    return identity, user


async def _super_admin_read(request: Request):
    identity = _identity(request)
    user, _ = await identity.session_user(request.cookies.get(COOKIE_NAME))
    if user.must_change_password:
        raise HTTPException(status_code=403, detail="Password change required")
    await identity.require_super_admin(user.id)
    return identity, user


async def _user_manager_request(request: Request, target_user_id: str | None = None,
                                platform_only: bool = False):
    token = request.cookies.get(COOKIE_NAME)
    identity = _identity(request)
    user, _ = await identity.session_user(token)
    _check_csrf(request, token)
    if user.must_change_password:
        raise HTTPException(status_code=403, detail="Password change required")
    await identity.require_user_manager(user.id, target_user_id, platform_only)
    return identity, user


DELEGATED_ROLES = ("identity_admin", "department_admin", "audit_admin")


async def _role_manager(request: Request, *, mutation=False):
    from .management_scope import organization_manager
    identity = _identity(request)
    actor, auth_session = await identity.session_user(request.cookies.get(COOKIE_NAME))
    if actor.must_change_password:
        raise HTTPException(status_code=403, detail="Password change required")
    if mutation:
        _check_csrf(request, request.cookies.get(COOKIE_NAME))
        await identity.require_step_up(auth_session)
    try:
        await identity.require_super_admin(actor.id)
        return identity, actor, None, None
    except HTTPException as exc:
        if exc.status_code != 403:
            raise
    await organization_manager(request)
    async with request.app.state.database.session() as session:
        departments = await identity.manageable_department_ids(session, actor.id, roles=("org_admin",))
        users = await identity.manageable_user_ids(session, actor.id, roles=("org_admin",))
    return identity, actor, departments, users


def _check_delegated_role(body, user_id, departments, users):
    if (body.role not in DELEGATED_ROLES or body.scope_type != "department"
            or (departments is not None and body.scope_id not in departments)
            or (users is not None and user_id not in users)):
        raise HTTPException(status_code=403, detail="Administrator delegation scope denied")



async def setup(request: Request, response: Response, body: SetupInput):
    user, token = await _identity(request).setup(
        body.username, body.display_name, body.password,
        body.recovery_username, body.recovery_password, body.registration_mode,
    )
    _set_session_cookie(response, token, request)
    return {"user": public_user(user), "csrf_token": csrf_token(token)}



async def platform_status(request: Request):
    return {"initialized": await _identity(request).initialized()}



async def register(request: Request, response: Response, body: AccountInput):
    await _limit_public_action(request, "register")
    user, token = await _identity(request).register(body.username, body.display_name, body.password)
    response.status_code = 201 if token else 202
    if token:
        _set_session_cookie(response, token, request)
        return {"user": public_user(user), "csrf_token": csrf_token(token)}
    return {"user": public_user(user)}



async def registration_policy(request: Request):
    return {"mode": await _identity(request).registration_mode()}



async def login(request: Request, response: Response, body: LoginInput):
    await _limit_public_action(request, "login")
    user, token = await _identity(request).login(body.username, body.password)
    _set_session_cookie(response, token, request)
    return {"user": public_user(user), "csrf_token": csrf_token(token)}



async def session(request: Request):
    token = request.cookies.get(COOKIE_NAME)
    user, _ = await _identity(request).session_user(token)
    return {"user": public_user(user), "csrf_token": csrf_token(token),
            "admin_roles": await _active_admin_roles(request, user.id)}



async def admin_access(request: Request):
    user, _ = await _identity(request).session_user(request.cookies.get(COOKIE_NAME))
    return {"roles": await _active_admin_roles(request, user.id),
            "must_change_password": bool(user.must_change_password)}



async def logout(request: Request, response: Response):
    token = request.cookies.get(COOKIE_NAME)
    await _identity(request).session_user(token)
    _check_csrf(request, token)
    await _identity(request).logout(token)
    response.delete_cookie(COOKIE_NAME, path="/", secure=request.app.state.settings.cookie_secure, httponly=True, samesite="lax")



async def change_password(request: Request, body: ChangePasswordInput):
    token = request.cookies.get(COOKIE_NAME)
    identity = _identity(request)
    user, auth_session = await identity.session_user(token)
    _check_csrf(request, token)
    await identity.change_password(user, auth_session, body.current_password, body.new_password)



async def step_up(request: Request, body: StepUpInput):
    token = request.cookies.get(COOKIE_NAME)
    identity = _identity(request)
    user, auth_session = await identity.session_user(token)
    _check_csrf(request, token)
    await identity.step_up(user, auth_session, body.password)
    return {"expires_in_seconds": 300}



async def admin_create_user(request: Request, body: AdminCreateInput):
    identity, actor = await _user_manager_request(request, platform_only=True)
    user = await identity.admin_create_user(
        body.username, body.display_name, body.password, body.status, actor.id,
    )
    return public_user(user)



async def admin_list_users(request: Request, q: str = Query("", max_length=128),
                           group_id: str | None = Query(None, max_length=64),
                           status: Literal["active", "pending", "disabled"] | None = None,
                           sort: Literal["username", "display_name", "created_at"] = "created_at",
                           direction: Literal["asc", "desc"] = "desc",
                           page: int = Query(1, ge=1), page_size: int = Query(25, ge=1, le=100)):
    identity = _identity(request)
    actor, _ = await identity.session_user(request.cookies.get(COOKIE_NAME))
    if actor.must_change_password:
        raise HTTPException(status_code=403, detail="Password change required")
    async with request.app.state.database.session() as session:
        scoped_ids = await identity.manageable_user_ids(session, actor.id)
        conditions = []
        if scoped_ids is not None:
            conditions.append(User.id.in_(scoped_ids))
        if group_id:
            from gateway.models import GroupMembership, UserGroup
            group = await session.get(UserGroup, group_id)
            if group is None or group.status != 'active': raise HTTPException(404, 'Group unavailable')
            conditions.append(User.id.in_(select(GroupMembership.user_id).where(GroupMembership.group_id == group_id, GroupMembership.revoked_at.is_(None))))
        if status:
            conditions.append(User.status == status)
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
                  "created_at": user.created_at.isoformat()} for user in rows]
    return {"users": users, "total": total, "page": page, "page_size": page_size}



async def admin_approve_user(request: Request, user_id: str):
    identity, _ = await _user_manager_request(request, user_id)
    await identity.approve_user(user_id)



async def admin_disable_user(request: Request, user_id: str):
    identity, actor = await _user_manager_request(request, user_id)
    if await identity.is_super_admin(user_id):
        await identity.require_super_admin(actor.id)
        _, auth_session = await identity.session_user(request.cookies.get(COOKIE_NAME))
        await identity.require_step_up(auth_session)
    await identity.disable_user(user_id)



async def admin_grant_role(request: Request, user_id: str, body: GrantRoleInput):
    identity, actor, departments, users = await _role_manager(request, mutation=True)
    if "super_admin" not in await _active_admin_roles(request, actor.id):
        _check_delegated_role(body, user_id, departments, users)
    assignment = await identity.grant_role(
        actor.id, user_id, body.role, body.scope_type, body.scope_id,
        body.include_subdepartments,
    )
    return {"id": assignment.id, "user_id": assignment.user_id, "role": assignment.role,
            "scope_type": assignment.scope_type, "scope_id": assignment.scope_id,
            "include_subdepartments": bool(assignment.include_subdepartments)}



async def admin_list_roles(request: Request, q: str = Query("", max_length=128),
                           role: Literal["identity_admin", "org_admin", "department_admin", "device_admin", "skill_admin", "audit_admin", "super_admin"] | None = None,
                           sort: Literal["created_at", "username", "role"] = "created_at",
                           direction: Literal["asc", "desc"] = "desc",
                           page: int = Query(1, ge=1), page_size: int = Query(25, ge=1, le=100)):
    identity, actor, departments, users = await _role_manager(request)
    conditions = [AdminAssignment.revoked_at.is_(None)]
    if "super_admin" not in await _active_admin_roles(request, actor.id):
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
    async with request.app.state.database.session() as session:
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



async def admin_revoke_role(request: Request, assignment_id: str):
    identity, actor, departments, users = await _role_manager(request, mutation=True)
    if "super_admin" not in await _active_admin_roles(request, actor.id):
        async with request.app.state.database.session() as session:
            assignment = await session.get(AdminAssignment, assignment_id)
            if not assignment:
                raise HTTPException(status_code=404, detail="Assignment unavailable")
            _check_delegated_role(assignment, assignment.user_id, departments, users)
    await identity.revoke_role(actor.id, assignment_id)



async def admin_list_departments(request: Request, q: str = Query("", max_length=128),
                                 sort: Literal["display_name", "external_id"] = "display_name",
                                 direction: Literal["asc", "desc"] = "asc",
                                 page: int = Query(1, ge=1), page_size: int = Query(25, ge=1, le=100)):
    await _super_admin_read(request)
    conditions = [DirectoryDepartment.active == 1]
    if q.strip():
        escaped = q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        pattern = f"%{escaped}%"
        conditions.append(or_(DirectoryDepartment.display_name.ilike(pattern, escape="\\"),
                              DirectoryDepartment.external_id.ilike(pattern, escape="\\")))
    column = {"display_name": DirectoryDepartment.display_name,
              "external_id": DirectoryDepartment.external_id}[sort]
    ordered = column.asc() if direction == "asc" else column.desc()
    async with request.app.state.database.session() as session:
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



async def admin_set_registration_policy(request: Request, body: RegistrationPolicyInput):
    identity, actor = await _super_admin_request(request)
    _, auth_session = await identity.session_user(request.cookies.get(COOKIE_NAME))
    await identity.require_step_up(auth_session)
    await identity.set_registration_mode(body.mode, actor.id)
    return {"mode": body.mode}



async def admin_platform_settings(request: Request):
    identity, _ = await _super_admin_read(request)
    settings = request.app.state.settings
    return {
        "gateway_id": settings.gateway_id,
        "public_origin": settings.public_origin,
        "registration_mode": await identity.registration_mode(),
        "session_seconds": SESSION_SECONDS,
        "protocol_version": request.app.state.protocol_version,
        "data_dir": str(settings.data_dir),
        "database": await request.app.state.database.status(),
    }



async def admin_reset_password(request: Request, user_id: str, body: ResetPasswordInput):
    identity, _ = await _super_admin_request(request)
    _, auth_session = await identity.session_user(request.cookies.get(COOKIE_NAME))
    await identity.require_step_up(auth_session)
    await identity.reset_password(user_id, body.new_password)
