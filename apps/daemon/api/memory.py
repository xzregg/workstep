"""Capability-scoped memory endpoints shared by all engine tool transports."""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from services import memory_query

router = APIRouter(prefix='/api/memory', tags=['memory'])


def projects():
    from services.project import project_manager
    return project_manager


class SearchRequest(BaseModel):
    memory_token: str = Field(min_length=1, max_length=200, repr=False)
    query: str = Field(default='', max_length=1000)
    cursor: int = Field(default=0, ge=0)
    snapshot: str = Field(default='', max_length=100)
    limit: int = Field(default=20, ge=1, le=100)
    since: str | None = None
    before: str | None = None
    period: str = ''
    timezone_name: str = 'Asia/Shanghai'
    include_knowledge: bool = True


class ExpandedSearchRequest(SearchRequest):
    person: str = Field(default='', max_length=120)
    event: str = Field(default='', max_length=120)
    object: str = Field(default='', max_length=120)
    place: str = Field(default='', max_length=120)
    time: str = Field(default='', max_length=120)
    relation: str = Field(default='', max_length=120)
    include_sources: bool = False
    source_chars: int = Field(default=2400, ge=1, le=6000)


class ReadRequest(BaseModel):
    memory_token: str = Field(min_length=1, max_length=200, repr=False)
    memory_id: str
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=2400, ge=1, le=6000)
    events: bool = False


class PendingRequest(BaseModel):
    memory_token: str = Field(min_length=1, max_length=200, repr=False)


async def invoke(operation, request):
    try:
        return await operation(projects(), **request.model_dump())
    except PermissionError as exc:
        raise HTTPException(403, str(exc)) from exc
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post('/search')
async def search(request: ExpandedSearchRequest):
    return await invoke(memory_query.search, request)


@router.post('/history')
async def history(request: SearchRequest):
    return await invoke(memory_query.history, request)


@router.post('/read')
async def read(request: ReadRequest):
    return await invoke(memory_query.read, request)


@router.post('/pending')
async def pending(request: PendingRequest):
    return await invoke(memory_query.pending, request)
