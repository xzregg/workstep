"""Decision model resources are host configuration, never project resources."""
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from api.project_scope import require_catalog_project
from services.decision_models import service

ResourceKind = Literal['runtime', 'runtime-gguf', 'model', 'english', 'typed-decisions',
    'kev-0.8b-q8', 'kev-4b-q4', 'kev-9b-q4', 'd1-omni-600m-q8', 'd1-2b-q4', 'd1-3b-q4', 'd1-omni-2b-q8']

router = APIRouter(prefix='/api/decision-models', tags=['decision-models'])


def authorize():
    require_catalog_project('')


class Settings(BaseModel):
    managed_model: str | None = Field(default=None, max_length=64)
    mode: Literal['managed', 'local', 'remote'] = 'managed'
    base_url: str = Field(default='', max_length=2048)
    model: str = Field(default='', max_length=256)
    api_key: str | None = Field(default=None, max_length=4096)
    proxy_enabled: bool | None = None
    access_key: str | None = Field(default=None, max_length=200)


class ModelSource(BaseModel):
    mode: Literal['local', 'remote']
    base_url: str = Field(max_length=2048)
    api_key: str | None = Field(default=None, max_length=4096)


@router.get('/catalog/search')
async def search_catalog(q: str = Query(default='', max_length=100)):
    authorize()
    try:
        return await service.search_catalog(q)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.post('/models')
async def available_models(body: ModelSource):
    authorize()
    try:
        return await service.available_models(body.model_dump())
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.get('')
async def status():
    authorize()
    return await service.snapshot()


@router.put('/settings')
async def configure(body: Settings):
    authorize()
    try:
        return await service.configure(body.model_dump())
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post('/test')
async def test(body: Settings):
    authorize()
    try:
        return await service.test(body.model_dump())
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.post('/resources/{kind}/download')
async def download(kind: ResourceKind):
    authorize()
    try:
        return await service.download(kind)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.post('/resources/{kind}/cancel')
async def cancel(kind: ResourceKind):
    authorize()
    await service.resources.cancel(kind)
    return await service.snapshot()


@router.delete('/resources/{kind}')
async def delete(kind: ResourceKind):
    authorize()
    return await service.delete(kind)


@router.post('/release')
async def release():
    authorize()
    await service.runtime.close()
    return await service.snapshot()
