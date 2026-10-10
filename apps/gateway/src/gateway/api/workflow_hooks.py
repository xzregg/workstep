from fastapi import APIRouter, Request
from gateway.api.adapters import invoke
from gateway.services.workflow_hooks import proxy_hook

router = APIRouter()


@router.post('/api/hook/{device_id}/{hook_id}')
async def trigger_hook(request: Request, device_id: str, hook_id: str):
    return await invoke(proxy_hook, request=request, device_id=device_id, hook_id=hook_id)
