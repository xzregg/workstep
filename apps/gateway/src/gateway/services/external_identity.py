"""Gateway-owned external identity mapping and directory projection."""

import hashlib
import json
import secrets
from dataclasses import dataclass
from datetime import timedelta
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError

from gateway.database import GatewayDatabase
from gateway.services.identity import IdentityService, _as_utc, _now
from gateway.services.group_membership_sync import reconcile_department_groups
from gateway.models import DirectoryDepartment, DirectoryMembership, DirectoryPerson, ExternalIdentity, ExternalLoginAttempt, IdentitySource, PlatformSetting, User, DirectoryEventReceipt, DirectorySyncState


@dataclass(frozen=True)
class ExternalProfile:
    tenant_id: str
    subject: str
    display_name: str


def _state_digest(state: str) -> str:
    return hashlib.sha256(state.encode()).hexdigest()


def _external_username(source_id: str, subject: str) -> str:
    digest = hashlib.sha256(f"{source_id}:{subject}".encode()).hexdigest()[:24]
    return f"ext_{digest}"


class ExternalIdentityService:
    def __init__(self, database: GatewayDatabase):
        self.database = database

    async def create_source(self, provider: str, tenant_id: str, client_id: str,
                            secret_env: str, agent_id: str | None = None,
                            callback_token_env: str | None = None,
                            callback_aes_key_env: str | None = None, options: dict | None = None) -> IdentitySource:
        source = IdentitySource(
            id=str(uuid4()), provider=provider, tenant_id=tenant_id,
            client_id=client_id, secret_env=secret_env, agent_id=agent_id,
            callback_token_env=callback_token_env,
            callback_aes_key_env=callback_aes_key_env,
            enabled=(options or {}).get("enabled", True),
        )
        try:
            async with self.database.session() as session:
                async with session.begin():
                    session.add(source)
                    if options is not None:
                        await session.flush()
                        from gateway.services.organization_settings import option_key
                        session.add(PlatformSetting(key=option_key(source.id), value_json=json.dumps(options)))
        except IntegrityError as exc:
            raise HTTPException(status_code=409, detail="Identity source already exists") from exc
        return source

    async def source(self, source_id: str, purpose: str | None = None) -> IdentitySource:
        async with self.database.session() as session:
            source = await session.get(IdentitySource, source_id)
            if source is None:
                raise HTTPException(status_code=404, detail="Identity source not found")
            if not source.enabled:
                raise HTTPException(status_code=403, detail="Identity source disabled")
        if purpose:
            from gateway.services.organization_settings import source_options
            options = await source_options(self.database, source_id)
            if not options.get(purpose + '_enabled', True):
                raise HTTPException(status_code=403, detail='Identity source option disabled')
        return source

    async def enabled_sources(self) -> list[IdentitySource]:
        async with self.database.session() as session:
            return (await session.scalars(select(IdentitySource).where(
                IdentitySource.enabled == 1,
            ).order_by(IdentitySource.provider, IdentitySource.tenant_id))).all()

    async def enqueue_callback(self, source: IdentitySource, payload: bytes) -> bool:
        """Durably record a verified event as a directory reconciliation trigger."""
        event_id = "callback:" + hashlib.sha256(payload).hexdigest()
        try:
            async with self.database.session() as session:
                async with session.begin():
                    session.add(DirectoryEventReceipt(
                        id=str(uuid4()), source_id=source.id, event_id=event_id,
                        status="pending",
                    ))
        except IntegrityError:
            return False
        return True

    async def begin(self, source_id: str, binding_user_id: str | None = None,
                    binding_session_id: str | None = None,
                    return_to: str | None = None) -> tuple[IdentitySource, str, str]:
        source = await self.source(source_id, purpose="login")
        state = secrets.token_urlsafe(32)
        nonce = secrets.token_urlsafe(32)
        async with self.database.session() as session:
            async with session.begin():
                session.add(ExternalLoginAttempt(
                    state_hash=_state_digest(state), source_id=source_id, nonce=nonce,
                    binding_user_id=binding_user_id, binding_session_id=binding_session_id,
                    return_to=return_to,
                    expires_at=_now() + timedelta(minutes=5),
                ))
        return source, state, nonce

    async def failure_return_to(self, source_id: str, state: str) -> str | None:
        """Consume a failed scan and recover only its prevalidated local target."""
        async with self.database.session() as session:
            async with session.begin():
                attempt = await session.get(ExternalLoginAttempt, _state_digest(state))
                if attempt is None or attempt.source_id != source_id:
                    return None
                if attempt.consumed_at is None:
                    attempt.consumed_at = _now()
                return attempt.return_to

    async def complete(self, source_id: str, state: str, code: str, connector,
                       browser_session_id: str | None = None) -> tuple[User, str | None, str | None]:
        source = await self.source(source_id, purpose="login")
        async with self.database.session() as session:
            attempt = await session.get(ExternalLoginAttempt, _state_digest(state))
            if attempt is None or attempt.source_id != source_id or _as_utc(attempt.expires_at) <= _now():
                raise HTTPException(status_code=400, detail="Scan session expired")
            if attempt.binding_session_id and attempt.binding_session_id != browser_session_id:
                raise HTTPException(status_code=401, detail="Original browser session required")
            nonce = attempt.nonce
            binding_user_id = attempt.binding_user_id
            return_to = attempt.return_to
        async with self.database.session() as session:
            async with session.begin():
                result = await session.execute(update(ExternalLoginAttempt).where(
                    ExternalLoginAttempt.state_hash == _state_digest(state),
                    ExternalLoginAttempt.source_id == source_id,
                    ExternalLoginAttempt.consumed_at.is_(None),
                    ExternalLoginAttempt.expires_at > _now(),
                ).values(consumed_at=_now()))
                if result.rowcount != 1:
                    raise HTTPException(status_code=409, detail="Scan callback already used")
        try:
            profile = await connector.exchange_code(source, code, nonce)
        except Exception as exc:
            raise HTTPException(status_code=502, detail="Identity provider unavailable") from exc
        if profile.tenant_id != source.tenant_id or not profile.subject or len(profile.subject) > 256:
            raise HTTPException(status_code=403, detail="Identity outside configured tenant")
        try:
            async with self.database.session() as session:
                async with session.begin():
                    identity = await session.scalar(select(ExternalIdentity).where(
                        ExternalIdentity.source_id == source_id,
                        ExternalIdentity.subject == profile.subject,
                    ))
                    if binding_user_id:
                        if identity and identity.user_id != binding_user_id:
                            raise HTTPException(status_code=409, detail="External identity already bound")
                        user = await session.get(User, binding_user_id)
                        if user is None or user.status != "active":
                            raise HTTPException(status_code=403, detail="Binding account unavailable")
                    elif identity:
                        user = await session.get(User, identity.user_id)
                        if user is None or user.status == "disabled":
                            raise HTTPException(status_code=403, detail="Account unavailable")
                        directory_person = await session.scalar(select(DirectoryPerson).where(
                            DirectoryPerson.source_id == source_id,
                            DirectoryPerson.subject == profile.subject,
                        ))
                        if directory_person is not None and not directory_person.active:
                            raise HTTPException(status_code=403, detail="Directory member inactive")
                    else:
                        mode = await session.get(PlatformSetting, "registration_mode")
                        if mode is None or mode.value_json == '"closed"':
                            raise HTTPException(status_code=403, detail="External identity not provisioned")
                        user = User(
                            id=str(uuid4()), username=_external_username(source_id, profile.subject),
                            display_name=profile.display_name, password_hash=None,
                            status="active" if mode.value_json == '"open"' else "pending",
                            registration_source=source.provider,
                        )
                        session.add(user)
                    if identity is None:
                        identity = ExternalIdentity(
                            id=str(uuid4()), source_id=source_id,
                            subject=profile.subject, user_id=user.id,
                            display_name=profile.display_name,
                        )
                        session.add(identity)
                    else:
                        identity.display_name = profile.display_name
                    identity.last_login_at = _now()
                    token = None
                    if not binding_user_id and user.status == "active":
                        auth_session, token = IdentityService._create_session(user.id)
                        session.add(auth_session)
                    await session.flush()
                    return user, token, return_to
        except IntegrityError as exc:
            raise HTTPException(status_code=409, detail="External identity already linked") from exc

    async def full_sync(self, source_id: str, departments: list[dict], people: list[dict],
                        cursor: str | None = None) -> dict[str, int]:
        await self.source(source_id, purpose="sync")
        if cursor is not None and (not isinstance(cursor, str) or len(cursor) > 256):
            raise HTTPException(status_code=422, detail="Invalid directory cursor")
        department_ids = [item["external_id"] for item in departments]
        subjects = [item["subject"] for item in people]
        if len(set(department_ids)) != len(department_ids) or len(set(subjects)) != len(subjects):
            raise HTTPException(status_code=422, detail="Duplicate directory identifier")
        if any(department not in department_ids for person in people for department in person["department_ids"]):
            raise HTTPException(status_code=422, detail="Unknown department in directory snapshot")
        async with self.database.session() as session:
            async with session.begin():
                existing_departments = {row.external_id: row for row in (await session.scalars(
                    select(DirectoryDepartment).where(DirectoryDepartment.source_id == source_id)
                )).all()}
                existing_people = {row.subject: row for row in (await session.scalars(
                    select(DirectoryPerson).where(DirectoryPerson.source_id == source_id)
                )).all()}
                identities = {row.subject: row for row in (await session.scalars(
                    select(ExternalIdentity).where(ExternalIdentity.source_id == source_id)
                )).all()}
                old_memberships: dict[str, set[str]] = {}
                membership_rows = (await session.execute(select(
                    DirectoryMembership.person_id, DirectoryDepartment.external_id,
                ).join(DirectoryDepartment, DirectoryDepartment.id == DirectoryMembership.department_id)
                    .where(DirectoryDepartment.source_id == source_id))).all()
                for person_id, external_id in membership_rows:
                    old_memberships.setdefault(person_id, set()).add(external_id)
                changes = {key: 0 for key in (
                    "departments_added", "departments_updated", "departments_moved", "departments_deleted",
                    "people_added", "people_updated", "people_transferred", "people_departed",
                )}
                incoming_departments = {item["external_id"] for item in departments}
                incoming_people = {item["subject"] for item in people}
                old_department_active = {external_id: bool(row.active)
                                         for external_id, row in existing_departments.items()}
                old_person_active = {subject: bool(row.active)
                                     for subject, row in existing_people.items()}
                changes["departments_deleted"] = sum(
                    active and external_id not in incoming_departments
                    for external_id, active in old_department_active.items()
                )
                changes["people_departed"] = sum(
                    active and subject not in incoming_people
                    for subject, active in old_person_active.items()
                )
                for row in existing_departments.values():
                    row.active = 0
                for row in existing_people.values():
                    row.active = 0
                for item in departments:
                    row = existing_departments.get(item["external_id"])
                    if row is None or not old_department_active[item["external_id"]]:
                        changes["departments_added"] += 1
                    else:
                        changes["departments_updated"] += row.display_name != item["display_name"]
                        changes["departments_moved"] += row.parent_external_id != item.get("parent_external_id")
                    if row is None:
                        row = DirectoryDepartment(id=str(uuid4()), source_id=source_id,
                                                 external_id=item["external_id"], display_name=item["display_name"])
                        session.add(row)
                        existing_departments[row.external_id] = row
                    row.display_name = item["display_name"]
                    row.parent_external_id = item.get("parent_external_id")
                    row.active = 1
                await session.flush()
                for item in people:
                    row = existing_people.get(item["subject"])
                    if row is None or not old_person_active[item["subject"]]:
                        changes["people_added"] += 1
                    else:
                        changes["people_updated"] += row.display_name != item["display_name"]
                        changes["people_transferred"] += (
                            old_memberships.get(row.id, set()) != set(item["department_ids"])
                        )
                    if row is None:
                        identity = identities.get(item["subject"])
                        if identity:
                            user_id = identity.user_id
                        else:
                            user = User(
                                id=str(uuid4()), username=_external_username(source_id, item["subject"]),
                                display_name=item["display_name"], password_hash=None,
                                status="active", registration_source="directory_sync",
                            )
                            session.add(user)
                            user_id = user.id
                            session.add(ExternalIdentity(
                                id=str(uuid4()), source_id=source_id, subject=item["subject"],
                                user_id=user_id, display_name=item["display_name"],
                            ))
                        row = DirectoryPerson(
                            id=str(uuid4()), source_id=source_id, subject=item["subject"],
                            display_name=item["display_name"], user_id=user_id,
                        )
                        session.add(row)
                        existing_people[row.subject] = row
                    row.display_name = item["display_name"]
                    row.active = 1
                    await session.flush()
                    user = await session.get(User, row.user_id)
                    if user and user.registration_source == "directory_sync":
                        user.display_name = item["display_name"]
                    await session.execute(DirectoryMembership.__table__.delete().where(
                        DirectoryMembership.person_id == row.id,
                    ))
                    for department_id in item["department_ids"]:
                        session.add(DirectoryMembership(
                            id=str(uuid4()), person_id=row.id,
                            department_id=existing_departments[department_id].id,
                        ))
                await session.flush()
                await reconcile_department_groups(session, source_id=source_id)
                state = await session.get(DirectorySyncState, source_id)
                if state is None:
                    state = DirectorySyncState(source_id=source_id)
                    session.add(state)
                now = _now()
                state.last_attempt_at = now
                state.last_success_at = now
                state.last_error_code = None
                if cursor is not None:
                    state.cursor = cursor
                state.changes_json = json.dumps(changes, sort_keys=True)
        return {"departments": len(departments), "people": len(people)}

    async def record_sync_failure(self, source_id: str, code: str) -> None:
        async with self.database.session() as session:
            async with session.begin():
                state = await session.get(DirectorySyncState, source_id)
                if state is None:
                    state = DirectorySyncState(source_id=source_id)
                    session.add(state)
                state.last_attempt_at = _now()
                state.last_error_code = code

    async def disable_source(self, source_id: str) -> None:
        async with self.database.session() as session:
            async with session.begin():
                source = await session.get(IdentitySource, source_id)
                if source is None:
                    raise HTTPException(status_code=404, detail="Identity source not found")
                source.enabled = 0

    async def apply_person_event(self, source_id: str, event_id: str, kind: str,
                                 subject: str, display_name: str | None,
                                 department_ids: list[str]) -> bool:
        await self.source(source_id, purpose="sync")
        try:
            async with self.database.session() as session:
                async with session.begin():
                    session.add(DirectoryEventReceipt(
                        id=str(uuid4()), source_id=source_id, event_id=event_id,
                    ))
                    await session.flush()
                    person = await session.scalar(select(DirectoryPerson).where(
                        DirectoryPerson.source_id == source_id,
                        DirectoryPerson.subject == subject,
                    ))
                    if kind == "person_delete":
                        if person is not None:
                            person.active = 0
                            await session.flush()
                            await reconcile_department_groups(session, source_id=source_id)
                        return True
                    departments = {row.external_id: row for row in (await session.scalars(
                        select(DirectoryDepartment).where(
                            DirectoryDepartment.source_id == source_id,
                            DirectoryDepartment.external_id.in_(department_ids),
                            DirectoryDepartment.active == 1,
                        )
                    )).all()}
                    if len(departments) != len(set(department_ids)):
                        raise HTTPException(status_code=422, detail="Unknown department")
                    if person is None:
                        identity = await session.scalar(select(ExternalIdentity).where(
                            ExternalIdentity.source_id == source_id,
                            ExternalIdentity.subject == subject,
                        ))
                        if identity is None:
                            user = User(
                                id=str(uuid4()), username=_external_username(source_id, subject),
                                display_name=display_name, password_hash=None,
                                status="active", registration_source="directory_sync",
                            )
                            session.add(user)
                            identity = ExternalIdentity(
                                id=str(uuid4()), source_id=source_id, subject=subject,
                                user_id=user.id, display_name=display_name,
                            )
                            session.add(identity)
                        person = DirectoryPerson(
                            id=str(uuid4()), source_id=source_id, subject=subject,
                            display_name=display_name, user_id=identity.user_id,
                        )
                        session.add(person)
                    person.display_name = display_name
                    person.active = 1
                    await session.flush()
                    user = await session.get(User, person.user_id)
                    if user and user.registration_source == "directory_sync":
                        user.display_name = display_name
                    await session.execute(DirectoryMembership.__table__.delete().where(
                        DirectoryMembership.person_id == person.id,
                    ))
                    for department in departments.values():
                        session.add(DirectoryMembership(
                            id=str(uuid4()), person_id=person.id,
                            department_id=department.id,
                        ))
                    await session.flush()
                    await reconcile_department_groups(session, source_id=source_id)
            return True
        except IntegrityError:
            async with self.database.session() as session:
                exists = await session.scalar(select(DirectoryEventReceipt.id).where(
                    DirectoryEventReceipt.source_id == source_id,
                    DirectoryEventReceipt.event_id == event_id,
                ))
                if exists:
                    return False
            raise
