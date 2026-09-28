"""Gateway-owned external identity mapping and directory projection."""

import hashlib
import secrets
from dataclasses import dataclass
from datetime import timedelta
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError

from .database import GatewayDatabase
from .identity import IdentityService, _as_utc, _now
from .group_membership_sync import reconcile_department_groups
from .models import (
    DirectoryDepartment, DirectoryMembership, DirectoryPerson, ExternalIdentity,
    ExternalLoginAttempt, IdentitySource, PlatformSetting, User, DirectoryEventReceipt,
)


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
                            secret_env: str, agent_id: str | None = None) -> IdentitySource:
        source = IdentitySource(
            id=str(uuid4()), provider=provider, tenant_id=tenant_id,
            client_id=client_id, secret_env=secret_env, agent_id=agent_id,
        )
        try:
            async with self.database.session() as session:
                async with session.begin():
                    session.add(source)
        except IntegrityError as exc:
            raise HTTPException(status_code=409, detail="Identity source already exists") from exc
        return source

    async def source(self, source_id: str) -> IdentitySource:
        async with self.database.session() as session:
            source = await session.get(IdentitySource, source_id)
            if source is None:
                raise HTTPException(status_code=404, detail="Identity source not found")
            if not source.enabled:
                raise HTTPException(status_code=403, detail="Identity source disabled")
            return source

    async def enabled_sources(self) -> list[IdentitySource]:
        async with self.database.session() as session:
            return (await session.scalars(select(IdentitySource).where(
                IdentitySource.enabled == 1,
            ).order_by(IdentitySource.provider, IdentitySource.tenant_id))).all()

    async def begin(self, source_id: str, binding_user_id: str | None = None,
                    binding_session_id: str | None = None,
                    return_to: str | None = None) -> tuple[IdentitySource, str, str]:
        source = await self.source(source_id)
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
        source = await self.source(source_id)
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

    async def full_sync(self, source_id: str, departments: list[dict], people: list[dict]) -> dict[str, int]:
        await self.source(source_id)
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
                for row in existing_departments.values():
                    row.active = 0
                for row in existing_people.values():
                    row.active = 0
                for item in departments:
                    row = existing_departments.get(item["external_id"])
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
        return {"departments": len(departments), "people": len(people)}

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
        await self.source(source_id)
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
