"""Browser-facing Gateway account entry points."""

import hmac
import re
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import func, or_, select

from .identity import COOKIE_NAME, SESSION_SECONDS, IdentityService, csrf_token, public_user
from .models import User

router = APIRouter(prefix="/api")
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
    role: Literal["identity_admin", "skill_admin", "audit_admin", "super_admin"]
    scope_type: Literal["platform", "department"] = "platform"
    scope_id: str | None = None
    include_subdepartments: bool = True

    @model_validator(mode="after")
    def valid_scope(self):
        if self.role in ("super_admin", "skill_admin") and self.scope_type != "platform":
            raise ValueError("This administrator role requires platform scope")
        return self


class RegistrationPolicyInput(BaseModel):
    mode: Literal["open", "open_with_approval", "closed"]


def _identity(request: Request) -> IdentityService:
    return IdentityService(request.app.state.database)


async def _limit_public_action(request: Request, action: str) -> None:
    ip = request.client.host if request.client else "unknown"
    await request.app.state.identity_rate_limiter.check(action, ip)


def _set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        COOKIE_NAME, token, max_age=SESSION_SECONDS,
        secure=True, httponly=True, samesite="lax", path="/",
    )


def _check_csrf(request: Request, token: str) -> None:
    provided = request.headers.get("X-CSRF-Token", "")
    if not hmac.compare_digest(provided, csrf_token(token)):
        raise HTTPException(status_code=403, detail="CSRF token required")


@router.post("/platform/setup", status_code=201)
async def setup(request: Request, response: Response, body: SetupInput):
    user, token = await _identity(request).setup(
        body.username, body.display_name, body.password,
        body.recovery_username, body.recovery_password, body.registration_mode,
    )
    _set_session_cookie(response, token)
    return {"user": public_user(user), "csrf_token": csrf_token(token)}


@router.get("/platform/status")
async def platform_status(request: Request):
    return {"initialized": await _identity(request).initialized()}


@router.post("/auth/register")
async def register(request: Request, response: Response, body: AccountInput):
    await _limit_public_action(request, "register")
    user, token = await _identity(request).register(body.username, body.display_name, body.password)
    response.status_code = 201 if token else 202
    if token:
        _set_session_cookie(response, token)
        return {"user": public_user(user), "csrf_token": csrf_token(token)}
    return {"user": public_user(user)}


@router.get("/auth/registration-policy")
async def registration_policy(request: Request):
    return {"mode": await _identity(request).registration_mode()}


@router.post("/auth/login")
async def login(request: Request, response: Response, body: LoginInput):
    await _limit_public_action(request, "login")
    user, token = await _identity(request).login(body.username, body.password)
    _set_session_cookie(response, token)
    return {"user": public_user(user), "csrf_token": csrf_token(token)}


@router.get("/auth/session")
async def session(request: Request):
    token = request.cookies.get(COOKIE_NAME)
    user, _ = await _identity(request).session_user(token)
    return {"user": public_user(user), "csrf_token": csrf_token(token)}


@router.post("/auth/logout", status_code=204)
async def logout(request: Request, response: Response):
    token = request.cookies.get(COOKIE_NAME)
    await _identity(request).session_user(token)
    _check_csrf(request, token)
    await _identity(request).logout(token)
    response.delete_cookie(COOKIE_NAME, path="/", secure=True, httponly=True, samesite="lax")


@router.post("/auth/password", status_code=204)
async def change_password(request: Request, body: ChangePasswordInput):
    token = request.cookies.get(COOKIE_NAME)
    identity = _identity(request)
    user, auth_session = await identity.session_user(token)
    _check_csrf(request, token)
    await identity.change_password(user, auth_session, body.current_password, body.new_password)


@router.post("/auth/step-up")
async def step_up(request: Request, body: StepUpInput):
    token = request.cookies.get(COOKIE_NAME)
    identity = _identity(request)
    user, auth_session = await identity.session_user(token)
    _check_csrf(request, token)
    await identity.step_up(user, auth_session, body.password)
    return {"expires_in_seconds": 300}


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


@router.post("/admin/users", status_code=201)
async def admin_create_user(request: Request, body: AdminCreateInput):
    identity, actor = await _user_manager_request(request, platform_only=True)
    user = await identity.admin_create_user(
        body.username, body.display_name, body.password, body.status, actor.id,
    )
    return public_user(user)


@router.get("/admin/users")
async def admin_list_users(request: Request, q: str = Query("", max_length=128),
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


@router.post("/admin/users/{user_id}/approve", status_code=204)
async def admin_approve_user(request: Request, user_id: str):
    identity, _ = await _user_manager_request(request, user_id)
    await identity.approve_user(user_id)


@router.post("/admin/users/{user_id}/disable", status_code=204)
async def admin_disable_user(request: Request, user_id: str):
    identity, actor = await _user_manager_request(request, user_id)
    if await identity.is_super_admin(user_id):
        await identity.require_super_admin(actor.id)
        _, auth_session = await identity.session_user(request.cookies.get(COOKIE_NAME))
        await identity.require_step_up(auth_session)
    await identity.disable_user(user_id)


@router.post("/admin/users/{user_id}/roles", status_code=201)
async def admin_grant_role(request: Request, user_id: str, body: GrantRoleInput):
    identity, actor = await _super_admin_request(request)
    _, auth_session = await identity.session_user(request.cookies.get(COOKIE_NAME))
    await identity.require_step_up(auth_session)
    assignment = await identity.grant_role(
        actor.id, user_id, body.role, body.scope_type, body.scope_id,
        body.include_subdepartments,
    )
    return {"id": assignment.id, "user_id": assignment.user_id, "role": assignment.role,
            "scope_type": assignment.scope_type, "scope_id": assignment.scope_id,
            "include_subdepartments": bool(assignment.include_subdepartments)}


@router.put("/admin/registration-policy")
async def admin_set_registration_policy(request: Request, body: RegistrationPolicyInput):
    identity, actor = await _super_admin_request(request)
    _, auth_session = await identity.session_user(request.cookies.get(COOKIE_NAME))
    await identity.require_step_up(auth_session)
    await identity.set_registration_mode(body.mode, actor.id)
    return {"mode": body.mode}


@router.post("/admin/users/{user_id}/reset-password", status_code=204)
async def admin_reset_password(request: Request, user_id: str, body: ResetPasswordInput):
    identity, _ = await _super_admin_request(request)
    _, auth_session = await identity.session_user(request.cookies.get(COOKIE_NAME))
    await identity.require_step_up(auth_session)
    await identity.reset_password(user_id, body.new_password)
