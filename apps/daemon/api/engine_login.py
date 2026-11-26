"""Host-only interactive engine login endpoints."""
import asyncio

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from api.project_scope import require_catalog_project
from engines.core.registry import create_engine
from services.engine_login import login_manager

router = APIRouter()


class LoginSessionRequest(BaseModel):
    id: str = Field(min_length=1, max_length=100)


class LoginCodeRequest(LoginSessionRequest):
    code: str = Field(min_length=1, max_length=8192)


def response(state):
    return JSONResponse(state, headers={'Cache-Control': 'no-store'})


@router.get('/{engine_id}/login')
async def login_status(engine_id: str):
    require_catalog_project('')
    return response(login_manager.status(engine_id))


@router.post('/{engine_id}/login')
async def start_login(engine_id: str):
    require_catalog_project('')
    engine = await asyncio.to_thread(create_engine, engine_id)
    if engine is None:
        raise HTTPException(404, 'Engine is not installed')
    if not engine.SUPPORTS_LOGIN:
        raise HTTPException(400, 'This engine does not support interactive login')
    try:
        return response(await login_manager.start(engine_id, engine))
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.post('/{engine_id}/login/code')
async def submit_login_code(engine_id: str, request: LoginCodeRequest):
    require_catalog_project('')
    try:
        return response(await login_manager.submit(engine_id, request.id, request.code))
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.post('/{engine_id}/login/cancel')
async def cancel_login(engine_id: str, request: LoginSessionRequest):
    require_catalog_project('')
    try:
        return response(await login_manager.cancel(engine_id, request.id))
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
