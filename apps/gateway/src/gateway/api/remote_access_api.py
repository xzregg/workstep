from gateway.services.remote_access_api import redeem_device_ticket as _handle_redeem_device_ticket, remote_session as _handle_remote_session, remote_project_grants as _handle_remote_project_grants, proxy_remote_websocket as _handle_proxy_remote_websocket





from fastapi import APIRouter, Request, WebSocket













router = APIRouter(prefix="/api/remote")


websocket_router = APIRouter()


@router.post("/redeem")
async def redeem_device_ticket(request: Request):
    return await _handle_redeem_device_ticket(request=request)


@router.get("/session")
async def remote_session(request: Request):
    return await _handle_remote_session(request=request)


@router.get("/project-grants")
async def remote_project_grants(request: Request):
    return await _handle_remote_project_grants(request=request)


@websocket_router.websocket("/{path:path}")
async def proxy_remote_websocket(ws: WebSocket, path: str):
    return await _handle_proxy_remote_websocket(ws=ws, path=path)
