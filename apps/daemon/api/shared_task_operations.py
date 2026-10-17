"""Bind the ordinary task-detail API to an authenticated editable task share.

The allowlist selects existing API routes; it does not duplicate their business
logic. Related message, queue, review and run IDs are checked before dispatch.
"""

import json
import re
from dataclasses import replace
from urllib.parse import parse_qsl, urlencode, urlsplit, unquote

from fastapi import HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import Response
from pydantic import BaseModel, Field


class SharedTaskOperation(BaseModel):
    path: str = Field(min_length=1, max_length=16384)
    method: str = Field(default="GET", pattern=r"^(GET|POST|PATCH|PUT|DELETE)$")
    body: dict | None = None
    idempotency_key: str | None = Field(default=None, max_length=128)


async def dispatch_shared_task_operation(request: Request, project_id: str, task_id: str,
                                         operation: SharedTaskOperation):
    from services.shared_task_scope import validate_operation
    from api.shared_task_scope import run_scope_db
    from services.remote_access import ActorSnapshot, actor_context, get_current_actor

    url = urlsplit(operation.path)
    if url.scheme or url.netloc or url.fragment or '\\' in url.path:
        raise HTTPException(403, "Invalid shared task operation")
    segments = [unquote(segment) for segment in url.path.split('/')]
    if any('/' in segment or '\\' in segment or '%' in segment for segment in segments):
        raise HTTPException(403, 'Invalid shared task operation')
    path = '/'.join(segments)
    if not path.startswith('/') or '//' in path or '..' in path.split('/'):
        raise HTTPException(403, "Invalid shared task operation")
    query = dict(parse_qsl(url.query, keep_blank_values=True))
    public_project_id = query.get('project_id', 'shared')
    body = dict(operation.body or {})
    if len(json.dumps(body).encode()) > 35_000_000:
        raise HTTPException(413, "Operation body too large")
    method = operation.method
    task_path = '/task/' + task_id
    workflow_id = await run_scope_db(
        project_id, lambda project: validate_operation(project, task_id, path, method, query, body)
    )
    allowed = False
    if path in {'/schedule/list', '/schedule/notification-options'} and method == 'GET':
        query['task_id'] = task_id
        if path == '/schedule/list':
            query['target_type'] = 'task'
        allowed = True
    if path in {'/schedule/create', '/schedule/preview'} and method == 'POST':
        allowed = True
    if re.fullmatch(r'/schedule/[A-Za-z0-9_-]+', path) and path not in {
        '/schedule/list', '/schedule/create', '/schedule/preview', '/schedule/notification-options',
    } and method in {'PATCH', 'DELETE'}:
        allowed = True
    if re.fullmatch(r'/schedule/[A-Za-z0-9_-]+/(?:pause|resume|runs/[A-Za-z0-9_-]+/notification/retry)', path) and method == 'POST':
        allowed = True
    if re.fullmatch(r'/schedule/[A-Za-z0-9_-]+/runs', path) and method == 'GET':
        allowed = True
    suffix = path[len(task_path):] if path.startswith(task_path) else None
    if suffix is not None:
        allowed = (
            (not suffix and method in {'GET', 'PATCH'})
            or (suffix in {'/history', '/artifacts', '/reviews', '/execution-report'} and method == 'GET')
            or (suffix == '/coordinator-config' and method in {'GET', 'PATCH'})
            or (suffix == '/scheduled-start' and method == 'PATCH')
            or (suffix in {'/chat', '/coordinator/stop'} and method == 'POST')
            or bool(re.fullmatch(r'/step/[A-Za-z0-9_-]+/(?:message|resume|cancel|restart)', suffix) and method == 'POST')
            or bool(re.fullmatch(r'/step/[A-Za-z0-9_-]+/config', suffix) and method in {'GET', 'PATCH', 'DELETE'})
            or bool(re.fullmatch(r'/messages/[A-Za-z0-9_-]+/(?:retry|set-complete)', suffix) and method == 'POST')
            or bool(re.fullmatch(r'/messages/[A-Za-z0-9_-]+/events', suffix) and method == 'GET')
            or bool(re.fullmatch(r'/actions/[A-Za-z0-9_-]+/(?:confirm|cancel)', suffix) and method == 'POST')
            or bool(re.fullmatch(r'/steps/[A-Za-z0-9_-]+/review/(?:approve|reject|force-approve|terminate|complete-task|set-complete)', suffix) and method == 'POST')
            or (suffix == '/discussion-groups' and method in {'GET', 'POST'})
            or bool(re.fullmatch(r'/discussion-groups/[^/]+/[^/]+', suffix) and method == 'DELETE')
        )
    if path == f'/tasks/{task_id}/actions' and method == 'GET':
        allowed = True
    if path == f'/tasks/{task_id}/actions/run' and method == 'POST':
        allowed = True
    if re.fullmatch(r'/action-runs/[A-Za-z0-9_-]+(?:/stop)?', path):
        allowed = method == ('POST' if path.endswith('/stop') else 'GET')
    if path == '/pending-message-inserts' or re.fullmatch(r'/pending-message-inserts/[A-Za-z0-9_-]+', path):
        allowed = True
    if workflow_id and path == f'/workflow/{workflow_id}' and method == 'GET':
        allowed = True
    if workflow_id and re.fullmatch(rf'/workflow/{re.escape(workflow_id)}/step/[A-Za-z0-9_-]+/prompt', path) and method == 'PATCH':
        allowed = True
    if path in {'/provider/list', '/engine/list'} and method == 'GET':
        allowed = True
    if re.fullmatch(r'/engine/[A-Za-z0-9_-]+/(?:models|inspect)', path) and method == 'GET':
        allowed = True
        query.pop('project_root', None)
        query['refresh'] = 'false'
    if path == '/task/list' and method == 'GET':
        path = task_path
        allowed = True
    if path in {'/task/start', '/task/pause', '/task/stop', '/task/retry'} and method == 'POST':
        body['task_id'] = task_id
        allowed = True
    if path == '/chat-sessions/enhance-prompt' and method == 'POST':
        body['project_id'] = project_id
        allowed = True
    if path == '/intervention/respond' and method == 'POST':
        from services.intervention import intervention_manager
        if not any(item['interaction_id'] == body.get('intervention_id')
                   for item in intervention_manager.list_pending_for_task(task_id)):
            raise HTTPException(404, "Task interaction unavailable")
        allowed = True
    from api.shared_task_resources import prepare_task_resource, project_resource_response
    resource_path = await prepare_task_resource(path, method, query, body, project_id, task_id, workflow_id)
    if resource_path:
        path = resource_path
        allowed = True
    if not allowed:
        raise HTTPException(403, "Operation is outside the shared task")

    query['project_id'] = project_id
    if 'project_id' in body:
        body['project_id'] = project_id
    # Dispatch only a known, already scoped API route, beneath the authenticated
    # share boundary. A caller cannot select an arbitrary app/router or host URL.
    scope = {**request.scope, 'path': '/api' + path, 'raw_path': ('/api' + path).encode(),
             'query_string': urlencode(query).encode(), 'method': method,
             'headers': [(b'content-type', b'application/json')]}
    if operation.idempotency_key:
        scope['headers'].append((b'idempotency-key', operation.idempotency_key.encode()))
    raw_body = json.dumps(body).encode()
    delivered = False
    async def receive():
        nonlocal delivered
        if not delivered:
            delivered = True
            return {'type': 'http.request', 'body': raw_body, 'more_body': False}
        return {'type': 'http.disconnect'}
    response = []
    async def send(event):
        response.append(event)
    current = get_current_actor()
    actor = replace(current, project_id=project_id, access_level='edit') if current else ActorSnapshot(
        actor_id='share-visitor', user_name='Share visitor', device_id='', device_name='',
        source='browser', project_id=project_id, access_level='edit', access_source='task_share',
    )
    with actor_context(actor):
        try:
            await request.app.router(scope, receive, send)
        except RequestValidationError as exc:
            raise HTTPException(422, json.loads(json.dumps(exc.errors(), default=str))) from exc
    start = next(event for event in response if event['type'] == 'http.response.start')
    content = b''.join(event.get('body', b'') for event in response if event['type'] == 'http.response.body')
    if operation.path.split('?')[0] == '/task/list' and start['status'] == 200:
        content = json.dumps({'tasks': [json.loads(content)]}).encode()
    elif start['status'] == 200:
        content = json.dumps(project_resource_response(path, json.loads(content), project_id, public_project_id)).encode()
    return Response(content=content, status_code=start['status'], media_type='application/json')
