"""Owner and client APIs for WorkStep remote projects."""

from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from services.config import config_store
from services.remote_project import RemoteAccessService, RemoteProjectRegistry

router = APIRouter(prefix="/api/remote-project")

remote_access_service = RemoteAccessService(config_store)
remote_project_registry = RemoteProjectRegistry(config_store)
client_manager = None


def _observe_runtime_port(request: Request) -> None:
    server = request.scope.get("server")
    if isinstance(server, (tuple, list)) and len(server) > 1:
        try:
            remote_access_service.set_runtime_port(int(server[1]))
        except (TypeError, ValueError):
            pass


class RemoteAccessSettingsRequest(BaseModel):
    enabled: bool = False
    internal_base_url: str = Field(default="", max_length=500)
    external_base_url: str = Field(default="", max_length=500)


class CreateShareRequest(BaseModel):
    project_id: str
    access: Literal["internal", "external"]
    access_expires_at: int | None = None


class AddRemoteProjectRequest(BaseModel):
    share_string: str = Field(min_length=1, max_length=10000)


class RevokeDeviceRequest(BaseModel):
    project_id: str
    device_id: str


class UpdateDeviceAccessRequest(BaseModel):
    project_id: str
    device_id: str
    expires_at: int | None = None


@router.get("/settings")
async def get_remote_access_settings(request: Request):
    _observe_runtime_port(request)
    return remote_access_service.settings()


@router.put("/settings")
async def update_remote_access_settings(req: RemoteAccessSettingsRequest, request: Request):
    _observe_runtime_port(request)
    try:
        return remote_access_service.update_settings(
            enabled=req.enabled,
            internal_base_url=req.internal_base_url,
            external_base_url=req.external_base_url,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/share")
async def create_remote_project_share(req: CreateShareRequest, request: Request):
    from main import project_manager

    _observe_runtime_port(request)
    project = project_manager.get_project_by_id(req.project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    try:
        return remote_access_service.create_share(
            project_id=project.id,
            project_name=project.name,
            access=req.access,
            access_expires_at=req.access_expires_at,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/add")
async def add_remote_project(req: AddRemoteProjectRequest):
    if client_manager is None:
        raise HTTPException(status_code=503, detail="Remote project client is unavailable")
    if not config_store.get_user_name():
        raise HTTPException(status_code=400, detail="请先在系统设置中填写使用者名称")
    try:
        return await client_manager.add_share(req.share_string)
    except (ValueError, PermissionError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"连接远程项目失败：{exc}") from exc


@router.delete("/{project_id}")
async def remove_remote_project(project_id: str):
    if client_manager is None:
        removed = remote_project_registry.remove(project_id)
    else:
        removed = await client_manager.remove(project_id)
    if not removed:
        raise HTTPException(status_code=404, detail="Remote project not found")
    return {"deleted": True}


@router.get("/devices/list")
async def list_remote_devices(project_id: str | None = Query(None)):
    devices = remote_access_service.list_devices(project_id)
    return {
        "devices": devices,
        "connected_count": sum(item["connected"] for item in devices),
    }


@router.post("/devices/revoke")
async def revoke_remote_device(req: RevokeDeviceRequest):
    if not remote_access_service.revoke_device(req.project_id, req.device_id):
        raise HTTPException(status_code=404, detail="Remote device not found")
    await remote_access_service.disconnect_device(
        req.project_id,
        req.device_id,
        reason="revoked",
    )
    return {"revoked": True}


@router.patch("/devices/access")
async def update_remote_device_access(req: UpdateDeviceAccessRequest):
    try:
        device = remote_access_service.update_device_expiry(
            req.project_id,
            req.device_id,
            req.expires_at,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if device is None:
        raise HTTPException(status_code=404, detail="Active remote device not found")
    await remote_access_service.disconnect_device(
        req.project_id,
        req.device_id,
        reason="access_changed",
    )
    refreshed = next(
        (
            item
            for item in remote_access_service.list_devices(req.project_id)
            if item["device_id"] == req.device_id and item["status"] != "revoked"
        ),
        device,
    )
    return {"device": refreshed}
