from gateway.api.adapters import invoke
from gateway.services.control_connection import data_socket as _handle_data_socket, control_socket as _handle_control_socket


from fastapi import APIRouter, WebSocket


router = APIRouter()


@router.websocket("/api/data/ws")
async def data_socket(ws: WebSocket):
    return await invoke(_handle_data_socket, ws=ws)


@router.websocket("/api/control/ws")
async def control_socket(ws: WebSocket):
    return await invoke(_handle_control_socket, ws=ws)
