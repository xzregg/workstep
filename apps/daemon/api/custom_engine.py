"""Host-scoped custom-engine operations, shared by CLI and settings."""
import asyncio
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

from api.project_scope import require_catalog_project
from services.custom_engines import custom_engine_manager as manager


def authorize():
    from api.engine import _require_managed_engine_permission
    try:
        require_catalog_project("")
        _require_managed_engine_permission()
    except PermissionError as exc:
        raise HTTPException(403, str(exc)) from exc


router = APIRouter(prefix="/custom", dependencies=[Depends(authorize)])


class PackageRequest(BaseModel):
    path: str = Field(min_length=1, max_length=4096)


class OperationRequest(PackageRequest):
    action: str = Field(pattern="^(install|validate)$")


class RegisterRequest(PackageRequest):
    replace: bool = False


class ConfigureRequest(PackageRequest):
    values: dict = Field(default_factory=dict)
    clear: dict[str, bool] = Field(default_factory=dict)
    confirmed: dict[str, bool] = Field(default_factory=dict)
    provider_id: str | None = None
    model: str | None = None


class EngineRequest(BaseModel):
    engine_id: str = Field(pattern="^[a-z][a-z0-9_]{0,63}$")


class DisabledRequest(EngineRequest):
    disabled: bool = True


class ExportRequest(EngineRequest):
    output: str = Field(min_length=1, max_length=4096)


async def invoke(awaitable):
    try:
        return await awaitable
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(400, str(exc)) from exc
    except TimeoutError as exc:
        raise HTTPException(504, "自定义引擎检查超时") from exc
    except RuntimeError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/inspect")
async def inspect_package(request: PackageRequest):
    return await invoke(manager.inspect(request.path))


@router.post("/configure")
async def configure_package(request: ConfigureRequest):
    return await invoke(manager.configure(request.path, request.values, request.clear, request.confirmed,
                                          request.provider_id, request.model))


@router.post("/operations", status_code=202)
async def start_operation(request: OperationRequest):
    return await invoke(manager.start_operation(request.action, request.path))


@router.get("/operations/{operation_id}")
async def get_operation(operation_id: str):
    return await invoke(manager.get_operation(operation_id))


@router.post("/operations/{operation_id}/stop")
async def stop_operation(operation_id: str):
    return await invoke(manager.cancel_operation(operation_id))


@router.post("/register")
async def register_package(request: RegisterRequest):
    return await invoke(manager.register(request.path, replace=request.replace))


@router.post("/disable")
async def disable_engine(request: DisabledRequest):
    return await invoke(manager.disable(request.engine_id, request.disabled))


@router.post("/rollback")
async def rollback_engine(request: EngineRequest):
    return await invoke(manager.rollback(request.engine_id))


@router.get("/{engine_id}/export")
async def export_engine(engine_id: str):
    import re
    if not re.fullmatch(r"[a-z][a-z0-9_]{0,63}", engine_id):
        raise HTTPException(400, "引擎 ID 无效")
    data = await invoke(manager.export(engine_id))
    return Response(data, media_type="application/zip", headers={
        "Content-Disposition": f'attachment; filename="{engine_id}.zip"',
        "Cache-Control": "no-store",
    })


@router.post("/export")
async def export_to_path(request: ExportRequest):
    file = Path(request.output).expanduser()
    if not file.is_absolute() or file.suffix.lower() != ".zip":
        raise HTTPException(400, "导出路径必须是绝对路径的 ZIP 文件")
    data = await invoke(manager.export(request.engine_id))
    await asyncio.to_thread(file.write_bytes, data)
    return {"ok": True, "path": str(file), "bytes": len(data)}


@router.post("/onboarding")
async def onboarding():
    from services.custom_engine_onboarding import create_onboarding
    return await invoke(create_onboarding())
