from gateway.api.adapters import invoke
from gateway.services.device_commands import create_device_operation as _handle_create_device_operation, list_device_operations as _handle_list_device_operations, get_device_operation as _handle_get_device_operation, retry_failed_device_operation as _handle_retry_failed_device_operation


from fastapi import APIRouter, Query, Request


from gateway.services.device_commands import BatchInput

router = APIRouter(prefix="/api/admin/device-operations")


@router.post("")
async def create_device_operation(request: Request, body: BatchInput):
    return await invoke(_handle_create_device_operation, request=request, body=body)


@router.get("")
async def list_device_operations(request: Request,
                                 limit: int = Query(default=50, ge=1, le=100),
                                 offset: int = Query(default=0, ge=0)):
    return await invoke(_handle_list_device_operations, request=request, limit=limit, offset=offset)


@router.get("/{batch_id}")
async def get_device_operation(request: Request, batch_id: str):
    return await invoke(_handle_get_device_operation, request=request, batch_id=batch_id)


@router.post("/{batch_id}/retry-failed")
async def retry_failed_device_operation(request: Request, batch_id: str):
    return await invoke(_handle_retry_failed_device_operation, request=request, batch_id=batch_id)
