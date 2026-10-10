"""Authenticated hook configuration and token-authenticated public ingress."""
import asyncio
import hmac
import re
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import Field, field_validator

from schemas.base import BaseSchema
from api.hook_errors import invoke_hook
from services.config import config_store, DEFAULT_EXECUTION_ENGINE
from services.project import project_manager
from services.remote_access import replayed_actor_context, get_current_actor
from services.task_creation import create_project_task
from services.workflow_definition import WorkflowDefinition, WorkflowValidationError
from services.workflow_hooks import WorkflowHookService
from workstep_gateway_protocol.hooks import HOOK_PATH, MAX_HOOK_BODY

MAX_BODY = MAX_HOOK_BODY
router = APIRouter(prefix='/api/workflow', tags=['流程钩子'])
public_router = APIRouter(tags=['流程钩子'])
hook_service = WorkflowHookService(project_manager)


class HookDraft(BaseSchema):
    id: str | None = None
    name: str = Field(min_length=1, max_length=128)
    enabled: bool = True
    step_key: str = Field(default='', max_length=128)
    default_title: str = Field(min_length=1, max_length=500)
    default_creator: str = Field(default='钩子触发', max_length=256)
    execution_mode: Literal['manual', 'immediate'] = 'manual'
    rotate_token: bool = False

    @field_validator('name', 'default_title')
    @classmethod
    def required_text(cls, value):
        if not value.strip():
            raise ValueError('不能为空')
        return value.strip()


class SaveHooks(BaseSchema):
    hooks: list[HookDraft] = Field(max_length=100)


def check_edit(project_id):
    actor = get_current_actor()
    if actor and actor.project_id is not None and (actor.project_id != project_id or actor.access_level != 'edit'):
        raise HTTPException(403, '需要项目编辑权限')


async def configuration(project_id, workflow_id):
    from main import remote_access_service, gateway_client
    def addresses():
        settings = remote_access_service.settings()
        gateway = config_store.get('gateway_platform', {})
        return config_store.get_device_identity()['device_id'], [
            {'kind': kind, 'base_url': base.rstrip('/')}
            for kind, base in (
                ('gateway', gateway.get('url', '')),
                ('internal', settings.get('internal_base_url', '')),
                ('external', settings.get('external_base_url', '')),
            ) if base
        ]
    device_id, bases = await asyncio.to_thread(addresses)
    hooks = await invoke_hook(hook_service.list(project_id, workflow_id))
    workflow = await hook_service.manager.run_db(project_id, lambda p: p.workflow_by_id(workflow_id))
    steps = WorkflowDefinition.load(workflow['steps']).compile().steps
    return {'hooks': hooks, 'device_id': device_id, 'addresses': bases,
            'steps': [{'key': s['key'], 'name': s.get('name') or s['key']} for s in steps],
            'gateway_online': bool(gateway_client.control_client and gateway_client.control_client.online)}


@router.get('/{workflow_id}/hooks')
async def list_hooks(workflow_id: str, project_id: str = Query(...)):
    check_edit(project_id)
    return await configuration(project_id, workflow_id)


@router.put('/{workflow_id}/hooks')
async def save_hooks(workflow_id: str, body: SaveHooks, project_id: str = Query(...)):
    check_edit(project_id)
    ids = [d.id for d in body.hooks if d.id]
    if len(ids) != len(set(ids)):
        raise HTTPException(422, '钩子 ID 重复')
    actor = get_current_actor()
    await invoke_hook(hook_service.save(project_id, workflow_id, body.hooks,
                            actor.actor_id if actor and actor.source == 'managed' else None))
    return await configuration(project_id, workflow_id)


@public_router.post('/api/hook/{device_id}/{hook_id}', status_code=201)
async def trigger_hook(device_id: str, hook_id: str, request: Request):
    from main import task_service, workflow_runtime, gateway_client
    if not HOOK_PATH.fullmatch(request.url.path):
        raise HTTPException(404, '入口不存在')
    identity = await asyncio.to_thread(config_store.get_device_identity)
    if device_id != identity['device_id']:
        raise HTTPException(404, '设备不存在')
    items = list(request.query_params.multi_items())
    if any(k not in {'token', 'step_key', 'title', 'creator'} for k, _ in items) or len({k for k, _ in items}) != len(items):
        raise HTTPException(422, '不支持的参数或重复参数')
    project_id, hook, workflow = await invoke_hook(hook_service.resolve(hook_id))
    token = request.query_params.get('token', '')
    if not token or not hmac.compare_digest(token.encode(), hook['token'].encode()):
        raise HTTPException(401, 'Token 无效')
    if not hook['enabled']:
        raise HTTPException(403, '钩子已停用')
    title = request.query_params.get('title', '').strip() or hook['default_title']
    creator = request.query_params.get('creator', '').strip() or hook['default_creator'].strip() or '钩子触发'
    if len(title) > 500 or len(creator) > 256:
        raise HTTPException(422, '标题或创建者过长')
    step_key = request.query_params.get('step_key', '').strip() or None
    steps = WorkflowDefinition.load(workflow['steps']).compile().steps
    if not steps or (step_key and step_key not in {s['key'] for s in steps}):
        raise HTTPException(422, '流程为空或起始阶段不存在')
    media = request.headers.get('content-type', 'text/plain').split(';')[0].strip().lower()
    if media not in {'application/json', 'text/plain', 'text/markdown'}:
        raise HTTPException(415, '仅支持 JSON 或 UTF-8 文本')
    chunks, size = [], 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > MAX_BODY:
            raise HTTPException(413, '正文超过 1 MiB')
        chunks.append(chunk)
    try:
        content = b''.join(chunks).decode('utf-8')
    except UnicodeDecodeError as exc:
        raise HTTPException(422, '正文必须为 UTF-8') from exc
    if media == 'application/json':
        fence = '`' * max(3, max((len(m[0]) for m in re.finditer(r'`+', content)), default=0) + 1)
        content = f'{fence}json\n{content}\n{fence}'
    if task_service is None:
        raise HTTPException(503, '任务服务尚未就绪')
    fields = {'creator_name': creator, 'creator_device_id': device_id,
              'creator_device_name': identity['device_name']}
    # Hook ownership is authenticated at configuration time. The URL display
    # name can never impersonate a platform principal or grant permissions.
    if gateway_client.managed_config is not None:
        fields['creator_id'] = hook['owner_id']
    try:
        with replayed_actor_context(None):
            result = await create_project_task(
                project_manager=hook_service.manager, task_service=task_service,
                workflow_runtime=workflow_runtime, project_id=project_id,
                title=title, description=content, workflow_id=hook['workflow_id'],
                start_step_key=step_key or steps[0]['key'], execution_mode='manual', source='hook',
                engine=await asyncio.to_thread(config_store.get_execution_default_engine) or DEFAULT_EXECUTION_ENGINE,
                creator_fields=fields,
            )
            run_error = None
            if hook['execution_mode'] == 'immediate':
                try:
                    if workflow_runtime is None:
                        raise RuntimeError('执行服务尚未就绪')
                    await workflow_runtime.start(project_id, result.task['id'], '', source='hook')
                except Exception:
                    run_error = '任务已创建，但自动运行失败，请在任务详情重试'
        return {'task_id': result.task['id'], 'run_error': run_error}
    except PermissionError as exc:
        raise HTTPException(403, str(exc)) from exc
    except (ValueError, WorkflowValidationError) as exc:
        raise HTTPException(422, str(exc)) from exc
