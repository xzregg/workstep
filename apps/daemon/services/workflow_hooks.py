"""Hook persistence; every database unit stays inside the project executor."""
import asyncio
import secrets
from uuid import uuid4

from fastapi import HTTPException

from models.workflow_hook import WorkflowHook
from services.workflow_definition import WorkflowDefinition


def hook_data(row):
    return {key: getattr(row, key) for key in (
        'id', 'workflow_id', 'name', 'token', 'enabled', 'step_key',
        'default_title', 'default_creator', 'execution_mode', 'owner_id')}


class WorkflowHookService:
    def __init__(self, manager):
        self.manager = manager
        self._index = None
        self._project_ids = ()
        self._lock = asyncio.Lock()

    def invalidate(self):
        self._index = None

    def load_hook(self, project, hook_id):
        row = WorkflowHook.get_or_none(WorkflowHook.id == hook_id)
        if row is None:
            raise HTTPException(404, '钩子不存在')
        workflow = project.workflow_by_id(row.workflow_id)
        if workflow is None or workflow.get('deleted'):
            raise HTTPException(404, '流程不存在')
        return hook_data(row), workflow

    async def resolve(self, hook_id):
        async with self._lock:
            projects = [p for p in self.manager.iter_projects() if not getattr(p, 'is_remote', False)]
            project_ids = tuple(p.id for p in projects)
            if self._project_ids != project_ids:
                self.invalidate()
            if self._index is None:
                async def entries(project):
                    return await self.manager.run_db(project.id, lambda _: [r.id for r in WorkflowHook.select(WorkflowHook.id)])
                groups = await asyncio.gather(*(entries(p) for p in projects))
                self._index = {key: p.id for p, ids in zip(projects, groups) for key in ids}
                self._project_ids = project_ids
            project_id = self._index.get(hook_id)
        if not project_id:
            raise HTTPException(404, '钩子不存在')
        hook, workflow = await self.manager.run_db(project_id, lambda p: self.load_hook(p, hook_id))
        return project_id, hook, workflow

    async def list(self, project_id, workflow_id):
        def load(project):
            if project.workflow_by_id(workflow_id) is None:
                raise HTTPException(404, '流程不存在')
            return [hook_data(r) for r in WorkflowHook.select().where(WorkflowHook.workflow_id == workflow_id).order_by(WorkflowHook.sort_order)]
        return await self.manager.run_db(project_id, load)

    async def save(self, project_id, workflow_id, drafts, owner_id):
        def persist(project):
            workflow = project.workflow_by_id(workflow_id)
            if workflow is None or workflow.get('deleted'):
                raise HTTPException(404, '流程不存在')
            steps = WorkflowDefinition.load(workflow['steps']).compile().steps
            keys = {s['key'] for s in steps}
            with project.db.atomic():
                existing = {r.id: r for r in WorkflowHook.select().where(WorkflowHook.workflow_id == workflow_id)}
                saved = []
                for index, draft in enumerate(drafts):
                    if draft.step_key and draft.step_key not in keys:
                        raise HTTPException(422, '起始阶段不存在')
                    row = existing.get(draft.id) if draft.id else None
                    if draft.id and row is None:
                        raise HTTPException(422, '钩子不属于当前流程')
                    row = row or WorkflowHook(id=str(uuid4()), token=secrets.token_urlsafe(32))
                    for key in ('name', 'enabled', 'step_key', 'default_title', 'default_creator', 'execution_mode'):
                        setattr(row, key, getattr(draft, key))
                    row.workflow_id = workflow_id
                    row.owner_id = owner_id
                    row.sort_order = index
                    if draft.rotate_token:
                        row.token = secrets.token_urlsafe(32)
                    row.save(force_insert=row.id not in existing)
                    saved.append(hook_data(row))
                removed = set(existing) - {h['id'] for h in saved}
                if removed:
                    WorkflowHook.delete().where(WorkflowHook.id.in_(removed)).execute()
                return saved
        async with self._lock:
            result = await self.manager.run_db(project_id, persist)
            self.invalidate()
            return result
