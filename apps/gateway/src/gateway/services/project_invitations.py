"""Account-bound project invitations; possession alone never opens a device."""
import hashlib
import json
import secrets
from datetime import datetime, timezone
from typing import Literal
from uuid import uuid4

from pydantic import AwareDatetime, BaseModel, field_validator
from sqlalchemy import select, update

from gateway.contracts import GatewayCall
from gateway.models import (AuditEvent, Device, PlatformProject, ProjectAccessGrant,
                            ProjectInvitation, ProjectInvitationAcceptance, User)
from gateway.services.errors import GatewayError
from gateway.services.identity import COOKIE_NAME, IdentityService
from gateway.services.identity_api import _check_csrf
from gateway.services.management_scope import project_manager
from gateway.services.project_access_api import lock_project_access


class InvitationInput(BaseModel):
    access_level: Literal['read', 'edit'] = 'read'
    expires_at: AwareDatetime | None = None

    @field_validator('expires_at')
    @classmethod
    def future_expiry(cls, value):
        if value is not None and value <= datetime.now(timezone.utc):
            raise ValueError('Expiry must be in the future')
        return value


class InvitationPolicyInput(BaseModel):
    enabled: bool


async def _actor(call, *, mutation=False):
    token = call.tokens.get(COOKIE_NAME)
    actor, _ = await IdentityService(call.database).session_user(token)
    if actor.status != 'active':
        raise GatewayError('forbidden', 'Account unavailable')
    if mutation:
        _check_csrf(call, token)
    return actor


def _published(project, device):
    if (project is None or project.status != 'active'
            or project.access_mode != 'remote_published'
            or device is None or device.status != 'active'):
        raise GatewayError('not_found', 'Published project unavailable')


async def _owner(session, project_id, actor_id):
    project = await session.get(PlatformProject, project_id)
    device = await session.get(Device, project.device_id) if project else None
    _published(project, device)
    if device.owner_user_id != actor_id:
        raise GatewayError('forbidden', 'Only the device owner can invite project users')
    return project


def _status(invitation):
    if invitation.status != 'active':
        return invitation.status
    expiry = invitation.expires_at
    if expiry and expiry.replace(tzinfo=timezone.utc) <= datetime.now(timezone.utc):
        return 'expired'
    return 'active'


def _audit(session, actor_id, project, action, **metadata):
    session.add(AuditEvent(id=str(uuid4()), user_id=actor_id, device_id=project.device_id,
                           action=f'project.{action}', result='success',
                           metadata_json=json.dumps({'project_id': project.id, **metadata})))


async def list_invitable_projects(call: GatewayCall):
    actor = await _actor(call)
    async with call.database.session() as session:
        rows = (await session.execute(select(PlatformProject, Device).join(Device).where(
            Device.owner_user_id == actor.id, Device.status == 'active',
            PlatformProject.status == 'active', PlatformProject.access_mode == 'remote_published',
        ).order_by(PlatformProject.name, PlatformProject.id))).all()
        return {'projects': [{'id': p.id, 'name': p.name, 'device_name': d.name,
                              'invitations_enabled': p.invitations_enabled} for p, d in rows]}


async def create_invitation(call: GatewayCall, project_id: str, body: InvitationInput):
    actor = await _actor(call, mutation=True)
    if not call.settings.public_origin:
        raise GatewayError('unavailable', 'Public Gateway origin is not configured')
    token = secrets.token_urlsafe(32)
    async with call.database.session() as session, session.begin():
        await lock_project_access(session, project_id)
        project = await _owner(session, project_id, actor.id)
        if not project.invitations_enabled:
            raise GatewayError('forbidden', 'Project invitations disabled by administrator')
        invitation = ProjectInvitation(id=str(uuid4()), project_id=project_id,
            token_hash=hashlib.sha256(token.encode()).hexdigest(), access_level=body.access_level,
            created_by_user_id=actor.id, expires_at=body.expires_at)
        session.add(invitation)
        _audit(session, actor.id, project, 'invitation_created', invitation_id=invitation.id,
               access_level=body.access_level)
    return {'id': invitation.id, 'url': call.settings.public_origin.rstrip('/') + '/project-invitations/' + token,
            'access_level': body.access_level, 'expires_at': body.expires_at}


async def _target(session, token):
    invitation = await session.scalar(select(ProjectInvitation).where(
        ProjectInvitation.token_hash == hashlib.sha256(token.encode()).hexdigest()))
    if invitation is None:
        raise GatewayError('not_found', 'Project invitation unavailable')
    project = await session.get(PlatformProject, invitation.project_id)
    device = await session.get(Device, project.device_id) if project else None
    _published(project, device)
    if _status(invitation) != 'active':
        raise GatewayError('gone', 'Project invitation expired, paused or revoked')
    if not project.invitations_enabled:
        raise GatewayError('forbidden', 'Project invitations disabled by administrator')
    # Ownership changes invalidate old owner's invitations even before expiry.
    if device.owner_user_id != invitation.created_by_user_id:
        raise GatewayError('gone', 'Project invitation owner changed')
    return invitation, project, device


async def preview_invitation(call: GatewayCall, token: str):
    await _actor(call)
    async with call.database.session() as session:
        invitation, project, device = await _target(session, token)
        creator = await session.get(User, invitation.created_by_user_id)
        return {'project_id': project.id, 'project_name': project.name, 'device_name': device.name,
                'access_level': invitation.access_level, 'expires_at': invitation.expires_at,
                'created_by': creator.display_name if creator else invitation.created_by_user_id}


async def accept_invitation(call: GatewayCall, token: str):
    actor = await _actor(call, mutation=True)
    # Obtain the project ID first, then take a write lock before evaluating any authority.
    async with call.database.session() as lookup:
        project_id = await lookup.scalar(select(ProjectInvitation.project_id).where(
            ProjectInvitation.token_hash == hashlib.sha256(token.encode()).hexdigest()))
    if project_id is None:
        raise GatewayError('not_found', 'Project invitation unavailable')
    async with call.database.session() as session, session.begin():
        await lock_project_access(session, project_id)
        invitation, project, _ = await _target(session, token)
        grant = await session.scalar(select(ProjectAccessGrant).where(
            ProjectAccessGrant.project_id == project.id, ProjectAccessGrant.subject_type == 'user',
            ProjectAccessGrant.subject_id == actor.id))
        if grant and (grant.invitation_blocked or grant.revoked_at is not None):
            raise GatewayError('forbidden', 'Project authorization revoked; administrator approval required')
        if grant is None:
            grant = ProjectAccessGrant(id=str(uuid4()), project_id=project.id, subject_type='user',
                subject_id=actor.id, access_level=invitation.access_level,
                assigned_by_user_id=invitation.created_by_user_id, invitation_id=invitation.id)
            session.add(grant)
        # Existing direct or invited access keeps its assigned permission. An invitation
        # cannot overwrite an administrator's choice or silently broaden an old grant.
        accepted = await session.scalar(select(ProjectInvitationAcceptance).where(
            ProjectInvitationAcceptance.invitation_id == invitation.id,
            ProjectInvitationAcceptance.user_id == actor.id))
        if accepted is None:
            session.add(ProjectInvitationAcceptance(id=str(uuid4()), invitation_id=invitation.id,
                                                     user_id=actor.id))
            _audit(session, actor.id, project, 'invitation_accepted', invitation_id=invitation.id,
                   access_level=grant.access_level)
    return {'project_id': project_id, 'project_name': project.name, 'access_level': grant.access_level}


async def list_invitations(call: GatewayCall, project_id: str, admin: bool = False):
    if admin:
        await project_manager(call, project_id=project_id)
    else:
        actor = await _actor(call)
    async with call.database.session() as session:
        project = await session.get(PlatformProject, project_id) if admin else await _owner(session, project_id, actor.id)
        if project is None:
            raise GatewayError('not_found', 'Project unavailable')
        invitations = (await session.scalars(select(ProjectInvitation).where(
            ProjectInvitation.project_id == project_id).order_by(ProjectInvitation.created_at.desc(),
                                                               ProjectInvitation.id))).all()
        invitation_ids = [row.id for row in invitations]
        acceptances = (await session.scalars(select(ProjectInvitationAcceptance).where(
            ProjectInvitationAcceptance.invitation_id.in_(invitation_ids)))).all() if invitation_ids else []
        user_ids = {a.user_id for a in acceptances} | {i.created_by_user_id for i in invitations}
        users = {u.id: u.display_name for u in (await session.scalars(select(User).where(User.id.in_(user_ids)))).all()} if user_ids else {}
        grants = {g.subject_id: g for g in (await session.scalars(select(ProjectAccessGrant).where(
            ProjectAccessGrant.project_id == project_id, ProjectAccessGrant.subject_type == 'user'))).all()}
        records = []
        for row in invitations:
            members = []
            for accepted in acceptances:
                if accepted.invitation_id != row.id:
                    continue
                grant = grants.get(accepted.user_id)
                members.append({'user_id': accepted.user_id, 'name': users.get(accepted.user_id, accepted.user_id),
                    'accepted_at': accepted.accepted_at, 'access_level': grant.access_level if grant else row.access_level,
                    'status': 'blocked' if grant and grant.invitation_blocked else
                              'revoked' if not grant or grant.revoked_at else 'active'})
            records.append({'id': row.id, 'status': _status(row), 'access_level': row.access_level,
                'created_by': users.get(row.created_by_user_id, row.created_by_user_id),
                'created_at': row.created_at, 'expires_at': row.expires_at, 'members': members})
        return {'invitations_enabled': project.invitations_enabled, 'invitations': records}


async def change_invitation(call: GatewayCall, project_id: str, invitation_id: str,
                            action: Literal['pause', 'resume', 'revoke'], admin: bool = False):
    if admin:
        _, actor, _ = await project_manager(call, project_id=project_id, mutation=True)
    else:
        actor = await _actor(call, mutation=True)
        if action != 'revoke':
            raise GatewayError('forbidden', 'Only administrators can pause or resume invitations')
    async with call.database.session() as session, session.begin():
        await lock_project_access(session, project_id)
        project = await session.get(PlatformProject, project_id) if admin else await _owner(session, project_id, actor.id)
        invitation = await session.get(ProjectInvitation, invitation_id)
        if invitation is None or invitation.project_id != project_id:
            raise GatewayError('not_found', 'Project invitation unavailable')
        if invitation.status == 'revoked' and action != 'revoke':
            raise GatewayError('conflict', 'Revoked invitation cannot be restored')
        invitation.status = {'pause': 'paused', 'resume': 'active', 'revoke': 'revoked'}[action]
        if action == 'revoke':
            await session.execute(update(ProjectAccessGrant).where(
                ProjectAccessGrant.invitation_id == invitation.id,
                ProjectAccessGrant.revoked_at.is_(None)).values(
                    revoked_at=datetime.now(timezone.utc), invitation_blocked=admin))
        _audit(session, actor.id, project, 'invitation_' + action, invitation_id=invitation_id)
    return {'status': invitation.status}


async def set_invitation_policy(call: GatewayCall, project_id: str, body: InvitationPolicyInput):
    _, actor, _ = await project_manager(call, project_id=project_id, mutation=True)
    async with call.database.session() as session, session.begin():
        await lock_project_access(session, project_id)
        project = await session.get(PlatformProject, project_id)
        project.invitations_enabled = body.enabled
        _audit(session, actor.id, project, 'invitation_policy_changed', enabled=body.enabled)
    return {'invitations_enabled': body.enabled}
