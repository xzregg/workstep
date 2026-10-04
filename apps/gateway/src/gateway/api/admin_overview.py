from gateway.api.adapters import invoke
from gateway.services.admin_overview import admin_overview as _handle_admin_overview
from fastapi import APIRouter, Request


router = APIRouter(prefix="/api/admin")


@router.get("/overview")
async def admin_overview(request: Request):
    return await invoke(_handle_admin_overview, request=request)
