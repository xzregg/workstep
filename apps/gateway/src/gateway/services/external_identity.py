"""Gateway-owned external identity mapping and directory projection."""
from gateway.services.errors import GatewayError

import hashlib
import json
import secrets
from dataclasses import dataclass
from datetime import timedelta
from uuid import uuid4


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


async def _disable_directory_access(session, user_ids):
    from gateway.models import AuthSession
    if not user_ids: return
    await session.execute(update(User).where(User.id.in_(user_ids), User.registration_source == 'directory_sync', User.status == 'active').values(status='disabled'))
    await session.execute(update(AuthSession).where(AuthSession.user_id.in_(user_ids), AuthSession.revoked_at.is_(None)).values(revoked_at=_now()))


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
            raise GatewayError('conflict', 'Identity source already exists') from exc
        return source

    async def source(self, source_id: str, purpose: str | None = None) -> IdentitySource:
        async with self.database.session() as session:
            source = await session.get(IdentitySource, source_id)
            if source is None:
                raise GatewayError('not_found', 'Identity source not found')
            if not source.enabled:
                raise GatewayError('forbidden', 'Identity source disabled')
        if purpose:
            from gateway.services.organization_settings import source_options
            options = await source_options(self.database, source_id)
            if not options.get(purpose + '_enabled', True):
                raise GatewayError('forbidden', 'Identity source option disabled')
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
                raise GatewayError('bad_input', 'Scan session expired')
            if attempt.binding_session_id and attempt.binding_session_id != browser_session_id:
                raise GatewayError('unauthenticated', 'Original browser session required')
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
                    raise GatewayError('conflict', 'Scan callback already used')
        try:
            profile = await connector.exchange_code(source, code, nonce)
        except Exception as exc:
            raise GatewayError('upstream_failed', 'Identity provider unavailable') from exc
        if profile.tenant_id != source.tenant_id or not profile.subject or len(profile.subject) > 256:
            raise GatewayError('forbidden', 'Identity outside configured tenant')
        try:
            async with self.database.session() as session:
                async with session.begin():
                    identity = await session.scalar(select(ExternalIdentity).where(
                        ExternalIdentity.source_id == source_id,
                        ExternalIdentity.subject == profile.subject,
                    ))
                    directory_person = await session.scalar(select(DirectoryPerson).where(DirectoryPerson.source_id == source_id, DirectoryPerson.subject == profile.subject))
                    if directory_person is not None and not directory_person.active:
                        raise GatewayError('forbidden', 'Enterprise identity disabled')
                    if binding_user_id:
                        if identity and identity.user_id != binding_user_id:
                            raise GatewayError('conflict', 'External identity already bound')
                        user = await session.get(User, binding_user_id)
                        if user is None or user.status != "active":
                            raise GatewayError('forbidden', 'Binding account unavailable')
                    elif identity:
                        user = await session.get(User, identity.user_id)
                        if user is None or user.status not in ["active", "pending"]:
                            raise GatewayError('forbidden', 'Account unavailable')
                        directory_person = await session.scalar(select(DirectoryPerson).where(
                            DirectoryPerson.source_id == source_id,
                            DirectoryPerson.subject == profile.subject,
                        ))
                        if directory_person is not None and not directory_person.active:
                            raise GatewayError('forbidden', 'Directory member inactive')
                    else:
                        mode = await session.get(PlatformSetting, "registration_mode")
                        if mode is None or mode.value_json == '"closed"':
                            raise GatewayError('forbidden', 'External identity not provisioned')
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
                        auth_session.authentication_method = "scan"
                        session.add(auth_session)
                    await session.flush()
                    return user, token, return_to
        except IntegrityError as exc:
            raise GatewayError('conflict', 'External identity already linked') from exc

    async def full_sync(self, source_id: str, departments: list[dict], people: list[dict],
                        cursor: str | None = None, *, selected_department_ids: list[str] | None = None, additions_only: bool = False, snapshot_complete: bool = True, dry_run: bool = False) -> dict:
        await self.source(source_id, purpose="sync")
        if cursor is not None and (not isinstance(cursor, str) or len(cursor) > 256):
            raise GatewayError('invalid', 'Invalid directory cursor')
        department_ids = [item["external_id"] for item in departments]
        scope = set(selected_department_ids) if selected_department_ids is not None else None
        if scope is not None and (not scope or (not set(department_ids) <= scope or (not snapshot_complete and set(department_ids) != scope))):
            raise GatewayError('invalid', 'Selected snapshot must include exactly the selected departments')
        subjects = [item["subject"] for item in people]
        if len(set(department_ids)) != len(department_ids) or len(set(subjects)) != len(subjects):
            raise GatewayError('invalid', 'Duplicate directory identifier')
        if any(department not in department_ids for person in people for department in person["department_ids"]):
            raise GatewayError('invalid', 'Unknown department in directory snapshot')
        result = {'departments': len(departments), 'people': len(people)}
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
                skipped_users = skipped_groups = 0
                if additions_only:
                    from gateway.models import UserGroup
                    deleted_groups = set((await session.scalars(select(UserGroup.external_department_id).where(
                        UserGroup.status == 'deleted', UserGroup.external_department_id.in_([d.id for d in existing_departments.values()])
                    ))).all())
                    purged_groups = set((await session.scalars(select(PlatformSetting.key).where(PlatformSetting.key.like('directory-group-purged:%')))).all())
                    deleted_groups.update(d.id for d in existing_departments.values() if 'directory-group-purged:' + d.id in purged_groups)
                    skipped_groups = sum(existing_departments[item['external_id']].id in deleted_groups
                                         for item in departments if item['external_id'] in existing_departments)
                    existing_users = {u.id: u for u in (await session.scalars(select(User).where(
                        User.id.in_([i.user_id for i in identities.values()])
                    ))).all()}
                    skipped_users = sum(identities[item['subject']].user_id in existing_users and
                        existing_users[identities[item['subject']].user_id].status == 'deleted'
                        for item in people if item['subject'] in identities)
                    purged = set((await session.scalars(select(PlatformSetting.key).where(PlatformSetting.key.like('directory-purged:%')))).all())
                    skipped_users += sum('directory-purged:' + _external_username(source_id, item['subject']) in purged for item in people)
                    people = [item for item in people if 'directory-purged:' + _external_username(source_id, item['subject']) not in purged and item['subject'] not in existing_people and item['subject'] not in identities]
                    new_department_ids = {item['external_id'] for item in departments if item['external_id'] not in existing_departments}
                    result.update(people_added=len(people), departments_added=len(new_department_ids),
                                  people_deleted_skipped=skipped_users, departments_deleted_skipped=skipped_groups)
                if not additions_only:
                    from gateway.models import UserGroup
                    deleted_groups = set((await session.scalars(select(UserGroup.external_department_id).where(UserGroup.status == 'deleted'))).all())
                    purged = set((await session.scalars(select(PlatformSetting.key).where(PlatformSetting.key.like('directory-purged:%')))).all())
                    users = {u.id: u for u in (await session.scalars(select(User).where(User.id.in_([i.user_id for i in identities.values()])))).all()}
                    purged_groups = set((await session.scalars(select(PlatformSetting.key).where(PlatformSetting.key.like('directory-group-purged:%')))).all())
                    deleted_groups.update(d.id for d in existing_departments.values() if 'directory-group-purged:' + d.id in purged_groups)
                    skipped_groups = sum(existing_departments[d['external_id']].id in deleted_groups for d in departments if d['external_id'] in existing_departments)
                    skipped = {p['subject'] for p in people if 'directory-purged:' + _external_username(source_id, p['subject']) in purged or (p['subject'] in identities and identities[p['subject']].user_id in users and users[identities[p['subject']].user_id].status == 'deleted')}
                    skipped_users = len(skipped)
                    people = [p for p in people if p['subject'] not in skipped]
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
                changes.update(people_unverified=0, people_restoration_pending=0,
                               people_deleted_skipped=skipped_users, departments_deleted_skipped=skipped_groups)
                details = []
                incoming_departments = {item["external_id"] for item in departments}
                incoming_people = {item["subject"] for item in people}
                old_department_active = {external_id: bool(row.active)
                                         for external_id, row in existing_departments.items()}
                old_person_active = {subject: bool(row.active)
                                     for subject, row in existing_people.items()}
                affected_people = {subject for subject, row in existing_people.items()
                                   if scope is None or old_memberships.get(row.id, set()) & scope}
                changes["departments_deleted"] = sum(
                    snapshot_complete and active and external_id not in incoming_departments and (scope is None or external_id in scope)
                    for external_id, active in old_department_active.items()
                )
                changes["people_departed"] = sum(
                    snapshot_complete and active and subject not in incoming_people and subject in affected_people and (additions_only or subject not in skipped)
                    and (scope is None or not old_memberships.get(existing_people[subject].id, set()) - scope)
                    for subject, active in old_person_active.items()
                )
                for row in existing_departments.values():
                    if snapshot_complete and row.active and row.external_id not in incoming_departments and (scope is None or row.external_id in scope):
                        details.append({'kind': 'department_deleted', 'name': row.display_name})
                    if not additions_only and snapshot_complete and (scope is None or row.external_id in scope): row.active = 0
                for row in existing_people.values():
                    if not additions_only and snapshot_complete and row.subject not in skipped and row.subject in affected_people and (scope is None or not old_memberships.get(row.id, set()) - scope): row.active = 0
                for subject in affected_people - incoming_people:
                    row = existing_people[subject]
                    if old_person_active[subject] and (additions_only or subject not in skipped):
                        kind = 'departed' if not row.active else 'unverified'
                        changes['people_unverified'] += kind == 'unverified'
                        details.append({'kind': kind, 'subject': subject, 'name': row.display_name})
                if scope is not None and not additions_only:
                    await session.execute(DirectoryMembership.__table__.delete().where(
                        DirectoryMembership.department_id.in_([row.id for row in existing_departments.values() if row.external_id in scope]),
                        True if snapshot_complete else DirectoryMembership.person_id.in_([row.id for row in existing_people.values() if row.subject in incoming_people]),
                    ))
                for item in departments:
                    row = existing_departments.get(item["external_id"])
                    if additions_only and row is not None: continue
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
                    if row.display_name != item['display_name'] or row.parent_external_id != item.get('parent_external_id'):
                        details.append({'kind': 'department_changed', 'name': item['display_name'], 'before': {'name': row.display_name, 'parent': row.parent_external_id}, 'after': {'name': item['display_name'], 'parent': item.get('parent_external_id')}})
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
                            (old_memberships.get(row.id, set()) if scope is None else old_memberships.get(row.id, set()) & scope) != set(item["department_ids"])
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
                    desired_active = item.get('active', True)
                    if not isinstance(desired_active, bool):
                        raise GatewayError('invalid', 'Invalid directory status')
                    if old_person_active.get(item['subject'], False) and not desired_active:
                        changes['people_departed'] += 1
                    if row.display_name != item['display_name'] or (old_memberships.get(row.id, set()) if scope is None else old_memberships.get(row.id, set()) & scope) != set(item['department_ids']) or old_person_active.get(row.subject, False) != desired_active:
                        details.append({'kind': 'person_changed', 'subject': row.subject, 'name': item['display_name'], 'before': {'name': row.display_name, 'departments': sorted(old_memberships.get(row.id, set())), 'active': old_person_active.get(row.subject, False)}, 'after': {'name': item['display_name'], 'departments': item['department_ids'], 'active': desired_active}})
                    row.display_name = item["display_name"]
                    row.active = int(desired_active)
                    await session.flush()
                    user = await session.get(User, row.user_id)
                    if user and user.status == 'disabled' and row.active:
                        changes['people_restoration_pending'] += 1
                    if user and user.registration_source == "directory_sync":
                        user.display_name = item["display_name"]
                    if scope is None:
                        await session.execute(DirectoryMembership.__table__.delete().where(
                            DirectoryMembership.person_id == row.id,
                        ))
                    for department_id in item["department_ids"]:
                        session.add(DirectoryMembership(
                            id=str(uuid4()), person_id=row.id,
                            department_id=existing_departments[department_id].id,
                        ))
                await session.flush()
                if not additions_only:
                    await _disable_directory_access(session, [row.user_id for subject, row in existing_people.items() if not row.active and (scope is None or subject in affected_people or subject in incoming_people)])
                await reconcile_department_groups(session, source_id=source_id, additions_only=additions_only)
                if additions_only:
                    changes.update(people_departed=0, departments_deleted=0, people_deleted_skipped=skipped_users, departments_deleted_skipped=skipped_groups)
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
                result.update(changes)
                result['details'] = details
                state.changes_json = json.dumps(result, sort_keys=True)
                if scope is not None:
                    from gateway.services.organization_settings import option_key
                    options_row = await session.get(PlatformSetting, option_key(source_id))
                    options = json.loads(options_row.value_json) if options_row else {}
                    options['selected_department_ids'] = selected_department_ids
                    if options_row: options_row.value_json = json.dumps(options)
                    else: session.add(PlatformSetting(key=option_key(source_id), value_json=json.dumps(options)))
                if dry_run:
                    await session.rollback()
                else:
                    from gateway.services.directory_notices import record_notice
                    await record_notice(session, source_id, result=result)
        return result

    async def record_sync_failure(self, source_id: str, code: str) -> None:
        async with self.database.session() as session:
            async with session.begin():
                state = await session.get(DirectorySyncState, source_id)
                if state is None:
                    state = DirectorySyncState(source_id=source_id)
                    session.add(state)
                state.last_attempt_at = _now()
                state.last_error_code = code
                from gateway.services.directory_notices import record_notice
                await record_notice(session, source_id, error=code)

    async def disable_source(self, source_id: str) -> None:
        async with self.database.session() as session:
            async with session.begin():
                source = await session.get(IdentitySource, source_id)
                if source is None:
                    raise GatewayError('not_found', 'Identity source not found')
                source.enabled = 0
                await session.flush()
                from gateway.services.login_policy import ensure_login_method
                await ensure_login_method(session)

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
                            await _disable_directory_access(session, [person.user_id])
                            from gateway.services.directory_notices import record_notice
                            await record_notice(session, source_id, result={'people_departed': 1, 'details': [{'kind': 'departed', 'name': person.display_name}]})
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
                        raise GatewayError('invalid', 'Unknown department')
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
