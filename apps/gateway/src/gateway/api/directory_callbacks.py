from gateway.services.directory_callbacks import verify_wecom_callback as _handle_verify_wecom_callback, receive_directory_callback as _handle_receive_directory_callback





from fastapi import APIRouter, Request






router = APIRouter(prefix="/api/auth/external")


@router.get("/{source_id}/events")
async def verify_wecom_callback(request: Request, source_id: str):
    return await _handle_verify_wecom_callback(request=request, source_id=source_id)


@router.post("/{source_id}/events")
async def receive_directory_callback(request: Request, source_id: str):
    return await _handle_receive_directory_callback(request=request, source_id=source_id)
