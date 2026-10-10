"""Reuse platform shares with workspace identity and bounded project scope."""
from gateway.contracts import GatewayCall
from gateway.models import PlatformProject, PlatformShare
from gateway.services.remote_access_api import _remote_identity
from gateway.services.errors import GatewayError
from gateway.services import platform_shares

async def _authorize(call: GatewayCall, project_id: str, *, mutation: bool = False):
    user, device_id, auth_session, _ = await _remote_identity(call)
    if mutation:
        expected = f"{call.target.scheme}://{call.target.netloc}"
        if (call.proofs.get('origin') != expected
                or call.proofs.get('x-workstep-share-intent') != 'manage'):
            raise GatewayError('forbidden', 'Same-origin share management required')
    async with call.database.session() as session:
        project = await session.get(PlatformProject, project_id)
        if (project is None or project.device_id != device_id
                or (auth_session.project_id and project.id != auth_session.project_id)):
            raise GatewayError('forbidden', 'Project access denied')
    return user

async def create(call: GatewayCall, body: platform_shares.CreateShareInput):
    user = await _authorize(call, body.project_id, mutation=True)
    return await platform_shares.create_platform_share(call, body, _actor=user)

async def listing(call: GatewayCall, project_id: str, task_id: str):
    user = await _authorize(call, project_id)
    return await platform_shares.list_own_platform_shares(call, project_id, task_id, _actor=user)

async def revoke(call: GatewayCall, share_id: str):
    async with call.database.session() as session:
        share = await session.get(PlatformShare, share_id)
        if share is None:
            raise GatewayError('not_found', 'Share unavailable')
        project_id = share.project_id
    user = await _authorize(call, project_id, mutation=True)
    return await platform_shares.revoke_platform_share(call, share_id, _actor=user)
