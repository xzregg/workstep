"""Language catalog reads are project-safe; package management is host-only."""
import asyncio
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field

from api.project_scope import require_catalog_project
from services.languages import language_manager as manager, read_contract, MAX_PACKAGE, checked_id, LanguageConflict

router = APIRouter(prefix="/api/language-packs")


def authorize():
    require_catalog_project("")
    from api.engine import _require_managed_engine_permission
    _require_managed_engine_permission()


def authorize_read(project_id: str = ""):
    require_catalog_project(project_id)


class PackageRequest(BaseModel):
    path: str = Field(min_length=1, max_length=4096)
    replace: bool = False


class ExportRequest(BaseModel):
    pack_id: str
    output: str = Field(min_length=1, max_length=4096)


async def invoke(awaitable):
    try:
        return await awaitable
    except LanguageConflict as exc:
        raise HTTPException(409, str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(404, "语言包或资源不存在") from exc
    except (ValueError, OSError) as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get("", dependencies=[Depends(authorize_read)])
async def list_packs():
    return await invoke(manager.list())


@router.get("/contract", dependencies=[Depends(authorize_read)])
async def contract():
    return await asyncio.to_thread(read_contract)


@router.post("/validate", dependencies=[Depends(authorize)])
async def validate(request: PackageRequest):
    return await invoke(manager.validate(request.path))


@router.post("/register", dependencies=[Depends(authorize)])
async def register(request: PackageRequest):
    return await invoke(manager.register(request.path, replace=request.replace))


@router.post("/import", dependencies=[Depends(authorize)])
async def import_pack(request: Request, replace: bool = False):
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > MAX_PACKAGE: raise HTTPException(413, "语言包过大")
    return await invoke(manager.import_zip(bytes(data), replace=replace))


@router.post("/export", dependencies=[Depends(authorize)])
async def export_to_path(request: ExportRequest):
    target = Path(request.output).expanduser()
    if not target.is_absolute() or target.suffix.lower() != ".zip":
        raise HTTPException(400, "导出路径必须是绝对路径的 ZIP 文件")
    data = await invoke(manager.export(request.pack_id))
    await asyncio.to_thread(target.write_bytes, data)
    return {"ok": True, "path": str(target), "bytes": len(data)}


@router.get("/{pack_id}/export", dependencies=[Depends(authorize)])
async def export(pack_id: str):
    try: checked_id(pack_id)
    except ValueError as exc: raise HTTPException(400, str(exc)) from exc
    return Response(await invoke(manager.export(pack_id)), media_type="application/zip", headers={"Content-Disposition": f'attachment; filename="{pack_id}.zip"'})

@router.get("/{pack_id}", dependencies=[Depends(authorize_read)])
async def get_pack(pack_id: str):
    return await invoke(manager.get(pack_id))

@router.delete("/{pack_id}", dependencies=[Depends(authorize)])
async def delete_pack(pack_id: str):
    return await invoke(manager.delete(pack_id))
