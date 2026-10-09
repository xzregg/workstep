"""HTTP adapter for owner invitations and administrator controls."""
from typing import Literal
from fastapi import APIRouter, Path, Request
from gateway.api.adapters import invoke
from gateway.services import project_invitations as service
from gateway.services.project_invitations import InvitationInput, InvitationPolicyInput

router = APIRouter(prefix='/api')
TOKEN = Path(min_length=43, max_length=43, pattern=r'^[A-Za-z0-9_-]+$')


@router.get('/project-invitations/projects')
async def projects(request: Request):
    return await invoke(service.list_invitable_projects, request=request)


@router.post('/projects/{project_id}/invitations', status_code=201)
async def create(request: Request, project_id: str, body: InvitationInput):
    return await invoke(service.create_invitation, request=request, project_id=project_id, body=body)


@router.get('/projects/{project_id}/invitations')
async def owner_list(request: Request, project_id: str):
    return await invoke(service.list_invitations, request=request, project_id=project_id)


@router.post('/projects/{project_id}/invitations/{invitation_id}/revoke')
async def owner_revoke(request: Request, project_id: str, invitation_id: str):
    return await invoke(service.change_invitation, request=request, project_id=project_id,
                        invitation_id=invitation_id, action='revoke')


@router.get('/project-invitations/{token}')
async def preview(request: Request, token: str = TOKEN):
    return await invoke(service.preview_invitation, request=request, token=token)


@router.post('/project-invitations/{token}/accept')
async def accept(request: Request, token: str = TOKEN):
    return await invoke(service.accept_invitation, request=request, token=token)


@router.get('/admin/projects/{project_id}/invitations')
async def admin_list(request: Request, project_id: str):
    return await invoke(service.list_invitations, request=request, project_id=project_id, admin=True)


@router.post('/admin/projects/{project_id}/invitations/{invitation_id}/{action}')
async def admin_change(request: Request, project_id: str, invitation_id: str,
                        action: Literal['pause', 'resume', 'revoke']):
    return await invoke(service.change_invitation, request=request, project_id=project_id,
                        invitation_id=invitation_id, action=action, admin=True)


@router.put('/admin/projects/{project_id}/invitation-policy')
async def admin_policy(request: Request, project_id: str, body: InvitationPolicyInput):
    return await invoke(service.set_invitation_policy, request=request, project_id=project_id, body=body)
