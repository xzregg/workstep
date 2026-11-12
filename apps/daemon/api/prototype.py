"""Project-authorized prototype editor API. All filesystem work runs off-loop."""
import asyncio

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field
from api.fs_paths import _project, _resolve_project_file
from services.remote_access import get_current_actor, require_user_actor
from services.prototype_workspace import PrototypeWorkspace
from services.prototype_source import SourceConflict

router = APIRouter(prefix='/api/prototype')


class OpenRequest(BaseModel):
    project_id: str
    path: str
    root: str | None = None


class EditRequest(BaseModel):
    path: str
    node_id: str
    operation: str
    values: dict = Field(default_factory=dict)
    version: str


class ChatRequest(BaseModel):
    path: str
    content: str = Field(min_length=1, max_length=100000)
    selection: dict | None = None
    engine: str | None = None
    model: str | None = None
    provider_id: str | None = None
    thinking_effort: str | None = None


def authorize(project_id):
    require_user_actor()
    actor = get_current_actor()
    if actor and actor.project_id is not None and (actor.project_id != project_id or actor.access_level != 'edit'):
        raise HTTPException(403, '原型编辑需要项目编辑权限')


def workspace(project_id, workspace_id):
    project = _project(project_id)
    return PrototypeWorkspace(project.path, project.workstep_dir, workspace_id)


async def io(operation, *args):
    try:
        return await asyncio.to_thread(operation, *args)
    except SourceConflict as exc:
        raise HTTPException(409, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(404, '原型文件或工作区不存在') from exc


@router.post('/open')
async def open_editor(req: OpenRequest):
    authorize(req.project_id)
    def operation():
        project = _project(req.project_id)
        entry = _resolve_project_file(req.path, req.project_id)
        root = _resolve_project_file(req.root, req.project_id) if req.root else None
        work = PrototypeWorkspace.open(project.path, project.workstep_dir, entry, root)
        return {**work.state(), 'path': entry.relative_to(work.original()).as_posix()}
    return await io(operation)


@router.get('/{workspace_id}')
async def state(workspace_id: str, project_id: str):
    authorize(project_id)
    return await io(lambda: workspace(project_id, workspace_id).state())


@router.get('/{workspace_id}/document')
async def document(workspace_id: str, project_id: str, path: str, editing: bool = True):
    authorize(project_id)
    def operation():
        from services.html_preview import issue_ticket
        work = workspace(project_id, workspace_id)
        source = work.document(path)
        grant = issue_ticket(work.directory / 'workspace' / path, project_id,
                             editor=editing, root=work.directory / 'workspace', boundary=work.original())
        return {'version': source.version, 'nodes': {key: {name: value for name, value in source.context(key).items() if name != 'source'} for key in source.nodes}, 'html_preview': grant}
    return await io(operation)


@router.post('/{workspace_id}/edit')
async def edit(workspace_id: str, project_id: str, req: EditRequest):
    authorize(project_id)
    return await io(lambda: workspace(project_id, workspace_id).edit(req.path, req.node_id, req.operation, req.values, req.version))


@router.post('/{workspace_id}/action/{action}')
async def action(workspace_id: str, action: str, project_id: str):
    authorize(project_id)
    if action not in {'undo', 'discard', 'publish', 'clean_history'}:
        raise HTTPException(404)
    from main import prototype_module
    if prototype_module and any(s.project_id == project_id and s.extra.get('workspace_id') == workspace_id and s.lock.locked()
                                for s in prototype_module._sessions.values()):
        raise HTTPException(409, '请先停止当前修改')
    return await io(lambda: getattr(workspace(project_id, workspace_id), action)())


@router.get('/{workspace_id}/history')
async def history(workspace_id: str, project_id: str, path: str):
    authorize(project_id)
    from main import prototype_module, project_manager
    if prototype_module is None:
        raise HTTPException(503, '原型助手未初始化')
    doc = await io(lambda: workspace(project_id, workspace_id).load()['documents'].get(path))
    if not doc:
        raise HTTPException(404, '原型文档不存在')
    def operation(_project):
        loaded = prototype_module.history(project_id, doc) or {'messages': []}
        return {**loaded, 'session_id': f'prototype:{project_id}:{doc}'}
    return await project_manager.run_db(project_id, operation)


@router.post('/{workspace_id}/chat')
async def chat(workspace_id: str, project_id: str, req: ChatRequest,
               idempotency_key: str = Header(..., alias='Idempotency-Key')):
    authorize(project_id)
    from main import prototype_module, project_manager
    if prototype_module is None:
        raise HTTPException(503, '原型助手未初始化')
    def check():
        work = workspace(project_id, workspace_id)
        if work.load()['status'] != 'idle':
            raise SourceConflict('请先处理工作副本中的未完成修改')
        work.document(req.path)
    await io(check)
    accepted = await project_manager.run_db(project_id, lambda _project: prototype_module.submit(
        project_id, workspace_id, req.path, req.content, idempotency_key, selection=req.selection,
        engine=req.engine, model=req.model, provider_id=req.provider_id, thinking_effort=req.thinking_effort))
    prototype_module.start_queued_turn(accepted.turn_id)
    return accepted.to_dict()


@router.post('/{workspace_id}/stop')
async def stop(workspace_id: str, project_id: str, path: str):
    authorize(project_id)
    from main import prototype_module
    if prototype_module is None:
        raise HTTPException(503, '原型助手未初始化')
    doc = await io(lambda: workspace(project_id, workspace_id).load()['documents'].get(path))
    if not doc:
        raise HTTPException(404, '原型文档不存在')
    return {'stopped': await prototype_module.stop_current(f'prototype:{project_id}:{doc}')}


@router.get('/{workspace_id}/diff')
async def diff(workspace_id: str, project_id: str, revision: str = 'pending'):
    authorize(project_id)
    return await io(lambda: workspace(project_id, workspace_id).diff(revision))
