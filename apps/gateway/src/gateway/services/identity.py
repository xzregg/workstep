"""Gateway-local accounts and browser sessions."""

import asyncio
import hashlib
import hmac
import json
import secrets
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from argon2 import PasswordHasher
from argon2.exceptions import VerificationError
from gateway.services.identity_errors import IdentityError
from sqlalchemy import select, update, func
from sqlalchemy.exc import IntegrityError

from gateway.database import GatewayDatabase
from gateway.models import AdminAssignment, AuditEvent, AuthSession, DirectoryDepartment, DirectoryMembership, DirectoryPerson, IdentitySource, PlatformSetting, User

SESSION_SECONDS = 24 * 60 * 60
COOKIE_NAME = "workstep_gateway_session"
_password_hasher = PasswordHasher()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _as_utc(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def csrf_token(token: str) -> str:
    return hmac.new(token.encode(), b"workstep-gateway-csrf-v1", hashlib.sha256).hexdigest()


def public_user(user: User) -> dict[str, str | bool]:
    return {"id": user.id, "username": user.username, "display_name": user.display_name,
            "status": user.status, "must_change_password": bool(user.must_change_password)}


class IdentityService:
    def __init__(self, database: GatewayDatabase):
        self.database = database

    async def initialized(self) -> bool:
        async with self.database.session() as session:
            return await session.get(PlatformSetting, "platform_initialized") is not None

    @staticmethod
    async def _hash_password(password: str) -> str:
        return await asyncio.to_thread(_password_hasher.hash, password)

    @staticmethod
    async def _verify_password(stored_hash: str, password: str) -> bool:
        try:
            return await asyncio.to_thread(_password_hasher.verify, stored_hash, password)
        except VerificationError:
            return False

    @staticmethod
    def _create_session(user_id: str) -> tuple[AuthSession, str]:
        token = secrets.token_urlsafe(32)
        return AuthSession(
            id=str(uuid4()), user_id=user_id, token_hash=_digest(token),
            expires_at=_now() + timedelta(seconds=SESSION_SECONDS),
        ), token

    async def setup(self, username: str, display_name: str, password: str,
                    recovery_username: str, recovery_password: str,
                    registration_mode: str) -> tuple[User, str]:
        async with self.database.session() as session:
            if await session.get(PlatformSetting, "platform_initialized"):
                raise IdentityError("conflict", "Platform already initialized")
            if await session.scalar(select(func.count(User.id))):
                raise IdentityError("conflict", "Platform already contains users")
        primary_hash = await self._hash_password(password)
        recovery_hash = await self._hash_password(recovery_password)
        primary = User(
            id=str(uuid4()), username=username, display_name=display_name,
            password_hash=primary_hash, password_changed_at=_now(),
            status="active", registration_source="local",
        )
        recovery = User(
            id=str(uuid4()), username=recovery_username, display_name="Recovery Administrator",
            password_hash=recovery_hash, password_changed_at=_now(),
            status="active", registration_source="local", is_recovery=1,
        )
        auth_session, token = self._create_session(primary.id)
        try:
            async with self.database.session() as session:
                async with session.begin():
                    session.add(PlatformSetting(key="platform_initialized", value_json="true"))
                    session.add(PlatformSetting(key="registration_mode", value_json=f'"{registration_mode}"'))
                    session.add_all([primary, recovery])
                    session.add_all([
                        AdminAssignment(id=str(uuid4()), user_id=primary.id, role="super_admin"),
                        AdminAssignment(id=str(uuid4()), user_id=recovery.id, role="super_admin"),
                    ])
                    session.add(auth_session)
                    session.add(AuditEvent(
                        id=str(uuid4()), user_id=primary.id, action="admin.recovery_created",
                        result="success", metadata_json=None,
                    ))
        except IntegrityError as exc:
            raise IdentityError("conflict", "Platform already initialized") from exc
        return primary, token

    async def registration_mode(self) -> str:
        async with self.database.session() as session:
            setting = await session.get(PlatformSetting, "registration_mode")
            if setting is None:
                raise IdentityError("unavailable", "Platform not initialized")
            return setting.value_json.strip('"')

    async def set_registration_mode(self, mode: str, actor_id: str) -> None:
        async with self.database.session() as session:
            async with session.begin():
                setting = await session.get(PlatformSetting, "registration_mode")
                if setting is None:
                    raise IdentityError("unavailable", "Platform not initialized")
                setting.value_json = f'"{mode}"'
                setting.updated_by_user_id = actor_id
                session.add(AuditEvent(
                    id=str(uuid4()), user_id=actor_id, action="admin.registration_policy_changed",
                    result="success", metadata_json=None,
                ))

    async def register(self, username: str, display_name: str, password: str) -> tuple[User, str | None]:
        initialized = await self.initialized()
        if initialized:
            from gateway.services.login_policy import password_login_enabled
            async with self.database.session() as session:
                if not await password_login_enabled(session):
                    raise IdentityError('forbidden', 'Password registration disabled')
        mode = await self.registration_mode() if initialized else "open"
        if mode == "closed":
            raise IdentityError("forbidden", "Registration is closed")
        password_hash = await self._hash_password(password)
        user = User(
            id=str(uuid4()), username=username, display_name=display_name,
            password_hash=password_hash, password_changed_at=_now(),
            status="active" if mode == "open" else "pending", registration_source="local",
        )
        token = None
        try:
            async with self.database.session() as session:
                async with session.begin():
                    # A unique bootstrap row serializes first registration on
                    # SQLite and PostgreSQL. The role and account commit together.
                    if not initialized:
                        from sqlalchemy.dialects.sqlite import insert as sqlite_insert
                        from sqlalchemy.dialects.postgresql import insert as postgres_insert
                        insert = sqlite_insert if session.bind.dialect.name == "sqlite" else postgres_insert
                        first = await session.scalar(insert(PlatformSetting).values(
                            key="platform_initialized", value_json="true",
                        ).on_conflict_do_nothing(index_elements=["key"]).returning(PlatformSetting.key))
                        if first:
                            if await session.scalar(select(func.count(User.id))):
                                raise IdentityError("conflict", "Platform already contains users")
                            session.add(user)
                            await session.flush()
                            session.add(PlatformSetting(key="registration_mode", value_json='"open"'))
                            session.add(AdminAssignment(id=str(uuid4()), user_id=user.id, role="super_admin"))
                            session.add(AuditEvent(id=str(uuid4()), user_id=user.id,
                                action="platform.first_registration", result="success"))
                            await session.flush()
                    # Hashing runs outside the transaction. Acquire the policy
                    # row's write lock and read its current value atomically so
                    # closing registration cannot race an account commit.
                    current_mode = await session.scalar(update(PlatformSetting).where(
                        PlatformSetting.key == "registration_mode",
                    ).values(value_json=PlatformSetting.value_json).returning(
                        PlatformSetting.value_json,
                    ))
                    if current_mode is None:
                        raise IdentityError("unavailable", "Platform not initialized")
                    from gateway.services.login_policy import password_login_enabled
                    if not await password_login_enabled(session):
                        raise IdentityError('forbidden', 'Password registration disabled')
                    mode = current_mode.strip('"')
                    if mode == "closed":
                        raise IdentityError("forbidden", "Registration is closed")
                    user.status = "active" if mode == "open" else "pending"
                    session.add(user)
                    if mode == "open":
                        auth_session, token = self._create_session(user.id)
                        session.add(auth_session)
        except IntegrityError as exc:
            raise IdentityError("conflict", "Username unavailable") from exc
        return user, token

    async def login(self, username: str, password: str) -> tuple[User, str]:
        from gateway.services.login_policy import password_login_enabled
        async with self.database.session() as session:
            if not await password_login_enabled(session):
                raise IdentityError('forbidden', 'Password sign-in disabled')
            user = await session.scalar(select(User).where(User.username == username))
        if user is None or not user.password_hash or not await self._verify_password(user.password_hash, password):
            raise IdentityError("unauthenticated", "Invalid username or password")
        if user.status == "pending":
            raise IdentityError("forbidden", "Account awaiting approval")
        if user.status != "active":
            raise IdentityError("forbidden", "Account disabled")
        auth_session, token = self._create_session(user.id)
        async with self.database.session() as session:
            async with session.begin():
                await session.execute(update(PlatformSetting).where(
                    PlatformSetting.key == 'platform_initialized').values(value_json='true'))
                if not await password_login_enabled(session):
                    raise IdentityError('forbidden', 'Password sign-in disabled')
                session.add(auth_session)
                fresh_user = await session.get(User, user.id)
                fresh_user.last_login_at = _now()
                if _password_hasher.check_needs_rehash(user.password_hash):
                    fresh_user.password_hash = await self._hash_password(password)
                if fresh_user.is_recovery:
                    session.add(AuditEvent(
                        id=str(uuid4()), user_id=fresh_user.id, action="auth.recovery_login",
                        result="success", metadata_json=None,
                    ))
        return user, token

    async def session_user(self, token: str | None, *, allow_device_session: bool = False) -> tuple[User, AuthSession]:
        if not token:
            raise IdentityError("unauthenticated", "Authentication required")
        async with self.database.session() as session:
            auth_session = await session.scalar(select(AuthSession).where(AuthSession.token_hash == _digest(token)))
            if (auth_session is None or auth_session.revoked_at
                    or _as_utc(auth_session.expires_at) <= _now()
                    or (auth_session.device_id and not allow_device_session)):
                raise IdentityError("unauthenticated", "Session expired")
            user = await session.get(User, auth_session.user_id)
            if user is None or user.status != "active":
                raise IdentityError("unauthenticated", "Account unavailable")
            return user, auth_session

    async def logout(self, token: str) -> None:
        async with self.database.session() as session:
            async with session.begin():
                auth_session = await session.scalar(select(AuthSession).where(AuthSession.token_hash == _digest(token)))
                if auth_session is not None:
                    auth_session.revoked_at = _now()

    async def change_password(self, user: User, auth_session: AuthSession,
                              current_password: str, new_password: str) -> None:
        if not user.password_hash or not await self._verify_password(user.password_hash, current_password):
            raise IdentityError("forbidden", "Current password is incorrect")
        new_hash = await self._hash_password(new_password)
        async with self.database.session() as session:
            async with session.begin():
                fresh = await session.get(User, user.id)
                if fresh.password_hash != user.password_hash:
                    raise IdentityError("conflict", "Password changed; retry")
                fresh.password_hash = new_hash
                fresh.password_changed_at = _now()
                fresh.must_change_password = 0
                await session.execute(
                    update(AuthSession).where(
                        AuthSession.user_id == user.id,
                        AuthSession.id != auth_session.id,
                        AuthSession.revoked_at.is_(None),
                    ).values(revoked_at=_now())
                )

    async def require_super_admin(self, user_id: str) -> None:
        async with self.database.session() as session:
            assignment = await session.scalar(select(AdminAssignment.id).where(
                AdminAssignment.user_id == user_id,
                AdminAssignment.role == "super_admin",
                AdminAssignment.revoked_at.is_(None),
            ))
            if assignment is None:
                raise IdentityError("forbidden", "Administrator access required")

    async def require_skill_admin(self, user_id: str) -> None:
        async with self.database.session() as session:
            assignment = await session.scalar(select(AdminAssignment.id).where(
                AdminAssignment.user_id == user_id,
                AdminAssignment.role.in_(("super_admin", "skill_admin")),
                AdminAssignment.scope_type == "platform",
                AdminAssignment.revoked_at.is_(None),
            ))
            if assignment is None:
                raise IdentityError("forbidden", "Skill administrator access required")

    async def step_up(self, user: User, auth_session: AuthSession, password: str) -> None:
        if not user.password_hash or not await self._verify_password(user.password_hash, password):
            raise IdentityError("forbidden", "Password is incorrect")
        async with self.database.session() as session:
            async with session.begin():
                current = await session.get(AuthSession, auth_session.id)
                if current is None or current.revoked_at or _as_utc(current.expires_at) <= _now():
                    raise IdentityError("unauthenticated", "Session expired")
                current.step_up_expires_at = _now() + timedelta(minutes=5)

    async def require_step_up(self, auth_session: AuthSession) -> None:
        async with self.database.session() as session:
            current = await session.get(AuthSession, auth_session.id)
            if current is None or current.step_up_expires_at is None or _as_utc(current.step_up_expires_at) <= _now():
                raise IdentityError("forbidden", "Recent password confirmation required")

    async def is_super_admin(self, user_id: str) -> bool:
        async with self.database.session() as session:
            assignment = await session.scalar(select(AdminAssignment.id).where(
                AdminAssignment.user_id == user_id,
                AdminAssignment.role == "super_admin",
                AdminAssignment.revoked_at.is_(None),
            ))
            return assignment is not None

    async def require_user_manager(self, actor_id: str, target_user_id: str | None = None,
                                   platform_only: bool = False) -> None:
        async with self.database.session() as session:
            manageable = await self.manageable_user_ids(session, actor_id)
            if manageable is None:
                return
            if not platform_only and target_user_id in manageable:
                return
        raise IdentityError("forbidden", "Administrator scope does not cover this user")

    async def manageable_user_ids(self, session, actor_id: str, *,
                                  roles=("super_admin", "identity_admin", "org_admin", "department_admin")) -> set[str] | None:
        """None means platform-wide; a set means department-scoped users."""
        allowed_departments = await self.manageable_department_ids(session, actor_id, roles=roles)
        if allowed_departments is None:
            return None
        if not allowed_departments:
            return set()
        return set((await session.scalars(select(DirectoryPerson.user_id).join(
            DirectoryMembership, DirectoryMembership.person_id == DirectoryPerson.id,
        ).where(DirectoryPerson.active == 1,
                DirectoryMembership.department_id.in_(allowed_departments)))).all())

    async def manageable_department_ids(self, session, actor_id: str, *,
                                        roles=("super_admin", "identity_admin", "org_admin", "department_admin")) -> set[str] | None:
        """None means platform-wide; a set contains readable department IDs."""
        assignments = (await session.scalars(select(AdminAssignment).where(
            AdminAssignment.user_id == actor_id,
            AdminAssignment.revoked_at.is_(None),
            AdminAssignment.role.in_(roles),
        ))).all()
        if any(assignment.role == "super_admin" or (
            assignment.role in ("identity_admin", "org_admin", "audit_admin") and assignment.scope_type == "platform"
        ) for assignment in assignments):
            return None
        scoped = [assignment for assignment in assignments
                  if assignment.role in ("identity_admin", "department_admin", "audit_admin") and assignment.scope_type == "department"]
        organizations = {assignment.scope_id for assignment in assignments
                         if assignment.role in ("org_admin", "audit_admin") and assignment.scope_type == "organization"}
        if not scoped and not organizations:
            raise IdentityError("forbidden", "User management denied")
        departments = (await session.scalars(select(DirectoryDepartment).where(
            DirectoryDepartment.active == 1,
        ))).all()
        by_id = {department.id: department for department in departments}
        children: dict[tuple[str, str], list[DirectoryDepartment]] = {}
        for department in departments:
            if department.parent_external_id:
                children.setdefault((department.source_id, department.parent_external_id), []).append(department)
        allowed_departments: set[str] = {department.id for department in departments
                                         if department.source_id in organizations}
        for assignment in scoped:
            root = by_id.get(assignment.scope_id)
            if root is None:
                continue
            pending = [root]
            visited: set[str] = set()
            while pending:
                current = pending.pop()
                if current.id in visited:
                    continue
                visited.add(current.id)
                allowed_departments.add(current.id)
                if assignment.include_subdepartments:
                    pending.extend(children.get((current.source_id, current.external_id), []))
        if not allowed_departments:
            return set()
        return allowed_departments

    async def grant_role(self, actor_id: str, user_id: str, role: str,
                         scope_type: str, scope_id: str | None,
                         include_subdepartments: bool = True) -> AdminAssignment:
        async with self.database.session() as session:
            async with session.begin():
                user = await session.get(User, user_id)
                if user is None:
                    raise IdentityError("not_found", "User not found")
                if scope_type == "department":
                    if not scope_id or await session.get(DirectoryDepartment, scope_id) is None:
                        raise IdentityError("invalid", "Department scope not found")
                elif scope_type == "organization":
                    if not scope_id or await session.get(IdentitySource, scope_id) is None:
                        raise IdentityError("invalid", "Organization scope not found")
                elif scope_type == "device_group":
                    from gateway.models import DeviceGroup
                    if not scope_id or await session.get(DeviceGroup, scope_id) is None:
                        raise IdentityError("invalid", "Device group scope not found")
                elif scope_id is not None:
                    raise IdentityError("invalid", "Platform scope cannot have an ID")
                existing = await session.scalar(select(AdminAssignment).where(
                    AdminAssignment.user_id == user_id,
                    AdminAssignment.role == role,
                    AdminAssignment.scope_type == scope_type,
                    AdminAssignment.scope_id == scope_id if scope_id else AdminAssignment.scope_id.is_(None),
                    AdminAssignment.revoked_at.is_(None),
                ))
                scoped_children = int(
                    scope_type == "department" and include_subdepartments
                )
                metadata = json.dumps({
                    "user_id": user_id,
                    "role": role,
                    "scope_type": scope_type,
                    "scope_id": scope_id or "",
                }, sort_keys=True)
                if existing:
                    if existing.include_subdepartments != scoped_children:
                        existing.include_subdepartments = scoped_children
                        session.add(AuditEvent(
                            id=str(uuid4()), user_id=actor_id,
                            action="admin.role.update", result="success",
                            metadata_json=metadata,
                        ))
                    return existing
                assignment = AdminAssignment(
                    id=str(uuid4()), user_id=user_id, role=role,
                    scope_type=scope_type, scope_id=scope_id,
                    include_subdepartments=scoped_children,
                    granted_by_user_id=actor_id,
                )
                session.add(assignment)
                session.add(AuditEvent(
                    id=str(uuid4()), user_id=actor_id,
                    action="admin.role.grant", result="success",
                    metadata_json=metadata,
                ))
                return assignment

    async def revoke_role(self, actor_id: str, assignment_id: str) -> None:
        async with self.database.session() as session:
            async with session.begin():
                # Serialize the final-admin check across concurrent revocations.
                await session.execute(update(PlatformSetting).where(
                    PlatformSetting.key == "platform_initialized",
                ).values(value_json="true"))
                assignment = await session.get(AdminAssignment, assignment_id)
                if assignment is None or assignment.revoked_at is not None:
                    raise IdentityError("not_found", "Administrator assignment not found")
                user = await session.get(User, assignment.user_id)
                if assignment.role == "super_admin":
                    active_local = await session.scalar(select(func.count()).select_from(AdminAssignment).join(User).where(
                        AdminAssignment.role == "super_admin",
                        AdminAssignment.revoked_at.is_(None),
                        User.status == "active",
                        User.registration_source == "local",
                    ))
                    if user and user.status == "active" and user.registration_source == "local" and active_local <= 1:
                        raise IdentityError("conflict", "Cannot revoke last local super administrator")
                    if user and user.is_recovery:
                        raise IdentityError("forbidden", "Recovery administrator is protected")
                assignment.revoked_at = _now()
                session.add(AuditEvent(
                    id=str(uuid4()), user_id=actor_id,
                    action="admin.role.revoke", result="success",
                    metadata_json=json.dumps({"user_id": assignment.user_id, "role": assignment.role,
                                              "scope_type": assignment.scope_type,
                                              "scope_id": assignment.scope_id or ""}, sort_keys=True),
                ))

    async def reset_password(self, user_id: str, new_password: str) -> None:
        password_hash = await self._hash_password(new_password)
        async with self.database.session() as session:
            async with session.begin():
                user = await session.get(User, user_id)
                if user is None:
                    raise IdentityError("not_found", "User not found")
                user.password_hash = password_hash
                user.password_changed_at = _now()
                user.must_change_password = 1
                await session.execute(update(AuthSession).where(
                    AuthSession.user_id == user_id,
                    AuthSession.revoked_at.is_(None),
                ).values(revoked_at=_now()))

    async def admin_create_user(self, username: str, display_name: str, password: str,
                                status: str, created_by: str) -> User:
        password_hash = await self._hash_password(password)
        user = User(
            id=str(uuid4()), username=username, display_name=display_name,
            password_hash=password_hash, password_changed_at=_now(),
            status=status, registration_source="admin_created", created_by_user_id=created_by,
            must_change_password=1,
        )
        try:
            async with self.database.session() as session:
                async with session.begin():
                    session.add(user)
        except IntegrityError as exc:
            raise IdentityError("conflict", "Username unavailable") from exc
        return user

    async def approve_user(self, user_id: str) -> None:
        async with self.database.session() as session:
            async with session.begin():
                user = await session.get(User, user_id)
                if user is None:
                    raise IdentityError("not_found", "User not found")
                if user.status in ["disabled", "deleted"]:
                    raise IdentityError("conflict", "Unavailable account cannot be approved")
                user.status = "active"

    async def disable_user(self, user_id: str) -> None:
        async with self.database.session() as session:
            async with session.begin():
                # Acquire a write lock before counting active super admins on
                # SQLite; PostgreSQL locks the same sentinel row.
                await session.execute(update(PlatformSetting).where(
                    PlatformSetting.key == "platform_initialized",
                ).values(value_json="true"))
                user = await session.get(User, user_id)
                if user is None:
                    raise IdentityError("not_found", "User not found")
                if user.status == "disabled":
                    return
                if user.status == "deleted":
                    raise IdentityError("conflict", "Restore deleted users first")
                assignment = await session.scalar(select(AdminAssignment.id).where(
                    AdminAssignment.user_id == user_id,
                    AdminAssignment.role == "super_admin",
                    AdminAssignment.revoked_at.is_(None),
                ))
                if assignment is not None:
                    count = await session.scalar(select(func.count()).select_from(AdminAssignment).join(User).where(
                        AdminAssignment.role == "super_admin",
                        AdminAssignment.revoked_at.is_(None),
                        User.status == "active",
                    ))
                    if count <= 1:
                        raise IdentityError("conflict", "Cannot disable last super administrator")
                if user.is_recovery:
                    raise IdentityError("forbidden", "Recovery administrator is protected")
                user.status = "disabled"
                await session.execute(update(AuthSession).where(
                    AuthSession.user_id == user_id,
                    AuthSession.revoked_at.is_(None),
                ).values(revoked_at=_now()))
