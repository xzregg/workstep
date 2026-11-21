"""Explicitly filtered memory endpoints shared by all engine tool transports."""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, ConfigDict
from services import memory_query

router = APIRouter(prefix='/api/memory', tags=['memory'])


def projects():
    from services.project import project_manager
    return project_manager


class ExecutionRequest(BaseModel):
    project_id: str = ''
    session_id: str = ''
    model_config=ConfigDict(extra="forbid")


class SearchRequest(ExecutionRequest):
    filter_project_id: str = Field(default='',max_length=200)
    filter_session_id: str = Field(default='',max_length=200)
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
    knowledge_only: bool = False
    person: str = Field(default='', max_length=120)
    event: str = Field(default='', max_length=120)
    object: str = Field(default='', max_length=120)
    place: str = Field(default='', max_length=120)
    time: str = Field(default='', max_length=120)
    relation: str = Field(default='', max_length=120)
    include_sources: bool = False
    source_chars: int = Field(default=2400, ge=1, le=6000)


class ReadRequest(ExecutionRequest):
    filter_project_id: str = Field(default='',max_length=200)
    filter_session_id: str = Field(default='',max_length=200)
    memory_id: str
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=2400, ge=1, le=6000)
    events: bool = False


class PendingRequest(ExecutionRequest):
    pass


async def invoke(operation, request):
    try:
        args=request.model_dump()
        project_id=args.pop('project_id');session_id=args.pop('session_id')
        args['context']=memory_query.query_access(projects(),project_id,session_id)
        return await operation(projects(), **args)
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
