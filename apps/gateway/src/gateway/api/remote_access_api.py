from gateway.api.adapters import invoke
from gateway.services.remote_access_api import redeem_device_ticket as _handle_redeem_device_ticket, remote_session as _handle_remote_session, remote_project_grants as _handle_remote_project_grants, proxy_remote_websocket as _handle_proxy_remote_websocket


from gateway.services.remote_access_api import remote_devices as _handle_remote_devices, remote_device_access as _handle_remote_device_access

from fastapi import APIRouter, Request, WebSocket


router = APIRouter(prefix="/api/remote")


websocket_router = APIRouter()


@router.post("/redeem")
async def redeem_device_ticket(request: Request):
    return await invoke(_handle_redeem_device_ticket, request=request)


@router.get("/session")
async def remote_session(request: Request):
    return await invoke(_handle_remote_session, request=request)


@router.get("/project-grants")
async def remote_project_grants(request: Request):
    return await invoke(_handle_remote_project_grants, request=request)


@websocket_router.websocket("/ws/workspace/{workspace_device_id}")
async def workspace_websocket(ws: WebSocket, workspace_device_id: str):
    return await invoke(_handle_proxy_remote_websocket, ws=ws, path="ws")


@websocket_router.websocket("/{path:path}")
async def proxy_remote_websocket(ws: WebSocket, path: str):
    return await invoke(_handle_proxy_remote_websocket, ws=ws, path=path)


@router.get('/devices')
async def remote_devices(request: Request):
    return await invoke(_handle_remote_devices, request=request)


@router.get('/devices/{device_id}/access')
async def remote_device_access(request: Request, device_id: str):
    return await invoke(_handle_remote_device_access, request=request, device_id=device_id)
