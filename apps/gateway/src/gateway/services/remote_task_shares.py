"""Reuse task shares with workspace identity, without requiring publication."""
from pydantic import Field, model_validator
from gateway.contracts import GatewayCall
from gateway.models import PlatformProject, PlatformShare
from gateway.services.remote_access_api import _remote_identity
from gateway.services.errors import GatewayError
from gateway.services import platform_shares
from gateway.services.task_share_projects import resolve_task_share_project

class CreateRemoteShareInput(platform_shares.CreateShareInput):
    project_id: str | None = Field(default=None, pattern=r'^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$')
    host_project_id: str | None = Field(default=None, pattern=r'^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$')

    @model_validator(mode='after')
    def one_project(self):
        if bool(self.project_id) == bool(self.host_project_id):
            raise ValueError('Exactly one task project is required')
        return self

async def _authorize(call: GatewayCall, project_id=None, host_project_id=None, *, mutation=False, create=False):
    user, device_id, auth_session, _ = await _remote_identity(call)
    if bool(project_id) == bool(host_project_id):
        raise GatewayError('invalid', 'Exactly one task project is required')
    if mutation:
        expected = f'{call.target.scheme}://{call.target.netloc}'
        if call.proofs.get('origin') != expected or call.proofs.get('x-workstep-share-intent') != 'manage':
            raise GatewayError('forbidden', 'Same-origin share management required')
    async with call.database.session() as session:
        async with session.begin():
            if project_id:
                project = await session.get(PlatformProject, project_id)
                if project is None:
                    raise GatewayError('forbidden', 'Project access denied')
            else:
                if auth_session.project_id:
                    bound = await session.get(PlatformProject, auth_session.project_id)
                    if bound is None or bound.host_project_id != host_project_id:
                        raise GatewayError('forbidden', 'Project access denied')
                project = await resolve_task_share_project(session, device_id, user.id, host_project_id, create=create)
            if project is not None and (project.device_id != device_id or auth_session.project_id and project.id != auth_session.project_id):
                raise GatewayError('forbidden', 'Project access denied')
    return user, project

async def create(call: GatewayCall, body: CreateRemoteShareInput):
    user, project = await _authorize(call, body.project_id, body.host_project_id, mutation=True, create=True)
    canonical = platform_shares.CreateShareInput.model_validate({**body.model_dump(exclude={'host_project_id'}), 'project_id': project.id})
    return await platform_shares.create_platform_share(call, canonical, _actor=user)

async def listing(call: GatewayCall, project_id: str | None, task_id: str, host_project_id: str | None = None):
    user, project = await _authorize(call, project_id, host_project_id)
    if project is None:
        return {'shares': []}
    return await platform_shares.list_own_platform_shares(call, project.id, task_id, _actor=user)

async def revoke(call: GatewayCall, share_id: str):
    async with call.database.session() as session:
        share = await session.get(PlatformShare, share_id)
        if share is None:
            raise GatewayError('not_found', 'Share unavailable')
        project_id = share.project_id
    user, _ = await _authorize(call, project_id, mutation=True)
    return await platform_shares.revoke_platform_share(call, share_id, _actor=user)
