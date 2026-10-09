import pytest
from workstep_gateway_protocol.project_scope import project_http_route_allowed


@pytest.mark.parametrize('path', ['/', '/tasks', '/chat', '/canvas', '/statistics',
                                  '/file-preview', '/favicon.svg', '/assets/app-Ab12.js',
                                  '/assets/styles.css', '/static/favicon.svg'])
def test_project_ticket_can_load_existing_workspace_pages_and_assets(path):
    assert project_http_route_allowed('GET', path, [], 'project-1')


@pytest.mark.parametrize('method,path', [('POST', '/tasks'), ('GET', '/admin'),
    ('GET', '/assets/.env'), ('GET', '/assets/../secret.js'), ('GET', '/landing'),
    ('GET', '/api/project/list'), ('GET', '/api/system/settings')])
def test_workspace_loading_does_not_open_global_or_private_routes(method, path):
    assert not project_http_route_allowed(method, path, [], 'project-1', access_level='edit')


@pytest.mark.parametrize('path', ['/api/engine/list', '/api/engine/execution/config',
    '/api/engine/coordinator/config', '/api/assistant/list', '/api/provider/list',
    '/api/engine/codex/models'])
def test_workspace_catalog_is_project_bound(path):
    allowed = project_http_route_allowed
    assert allowed('GET', path, [('project_id', 'visible')], 'visible')
    assert not allowed('GET', path, [], 'visible')
    assert not allowed('GET', path, [('project_id', 'private')], 'visible')
    assert not allowed('GET', path, [('project_id', 'visible'), ('project_id', 'visible')], 'visible')
    assert not allowed('GET', path, [('project_id', 'visible'), ('refresh', '1')], 'visible')
    assert not allowed('PUT', path, [('project_id', 'visible')], 'visible', access_level='edit')


@pytest.mark.parametrize('level', ['read', 'edit'])
def test_project_session_history_allows_pagination(level):
    allowed = project_http_route_allowed
    query = [('project_id', 'visible'), ('limit', '300'), ('offset', '0')]
    assert allowed('GET', '/api/chat-sessions/session-1', query, 'visible', access_level=level)
    assert allowed('GET', '/api/chat-sessions/session-1', query[:-1] + [('offset', '300')], 'visible', access_level=level)
    assert not allowed('GET', '/api/chat-sessions/session-1', [('project_id', 'private'), *query[1:]], 'visible', access_level=level)
    assert not allowed('GET', '/api/chat-sessions/session-1', [*query, ('project_id', 'visible')], 'visible', access_level=level)
    assert not allowed('GET', '/api/chat-sessions/session-1', [*query, ('offset', '1')], 'visible', access_level=level)
    assert not allowed('GET', '/api/chat-sessions/session-1', [*query, ('unexpected', '1')], 'visible', access_level=level)
    assert not allowed('POST', '/api/chat-sessions/session-1', query, 'visible', access_level=level)


@pytest.mark.parametrize('path', ['/api/task/task-1/history', '/api/project-actions/sessions/session-1'])
def test_project_workspace_history_and_action_catalog_routes(path):
    query = [('project_id', 'visible')]
    if path.endswith('/history'): query += [('limit', '300'), ('offset', '0')]
    assert project_http_route_allowed('GET', path, query, 'visible')
    assert not project_http_route_allowed('GET', path, [('project_id', 'private'), *query[1:]], 'visible')
    assert not project_http_route_allowed('GET', path, [*query, ('unknown', '1')], 'visible')
    assert not project_http_route_allowed('GET', path, [*query, ('project_id', 'visible')], 'visible')


def test_session_action_run_is_edit_only_and_project_bound():
    path = '/api/project-actions/sessions/session-1/run'
    query = [('project_id', 'visible')]
    assert project_http_route_allowed('POST', path, query, 'visible', access_level='edit')
    assert not project_http_route_allowed('POST', path, query, 'visible', access_level='read')
    assert not project_http_route_allowed('POST', path, [('project_id', 'private')], 'visible', access_level='edit')


@pytest.mark.parametrize('method,path,extra', [
 ('GET','/api/skills',[]), ('POST','/api/skills/rescan',[]),
 ('GET','/api/templates/list',[]), ('GET','/api/templates/development',[]),
 ('GET','/api/tasks/task-1/actions',[('step_key','build')]),
 ('POST','/api/tasks/task-1/actions/run',[]), ('GET','/api/action-runs/run-1',[]),
 ('POST','/api/action-runs/run-1/stop',[]),
 ('GET','/api/workflow/generate/history',[('workflow_id','flow-1')]),
 ('POST','/api/workflow/generate/chat',[]),
 ('DELETE','/api/workflow/generate/history',[('workflow_id','flow-1')]),
 ('POST','/api/task-draft/chat',[]), ('POST','/api/task-draft/session-1/stop',[]),
 ('POST','/api/project/save-steps',[('workflow_id','flow-1')]),
 ('GET','/api/schedule/list',[]), ('POST','/api/schedule/create',[]),
 ('GET','/api/schedule/schedule-1/runs',[('limit','100'),('offset','0')]),
 ('GET','/api/pending-message-inserts',[('target_message_id','message-1')]),
 ('POST','/api/pending-message-inserts',[]),
 ('GET','/api/git/projects/visible/repositories',[('refresh','true')]),
 ('GET','/api/git/worktrees/tree-1/status',[]), ('POST','/api/git/worktrees/tree-1/commit',[]),
])
def test_project_workspace_complete_route_contract(method,path,extra):
 q=[('project_id','visible'),*extra]
 assert project_http_route_allowed(method,path,q,'visible',access_level='edit')
 assert not project_http_route_allowed(method,path,[('project_id','private'),*extra],'visible',access_level='edit')
 assert not project_http_route_allowed(method,path,[*q,('unknown','x')],'visible',access_level='edit')
 assert not project_http_route_allowed(method,path,q,'private',access_level='edit')
 if method != 'GET': assert not project_http_route_allowed(method,path,q,'visible',access_level='read')


def test_project_contract_does_not_open_device_settings_or_git_credentials():
 q=[('project_id','visible')]
 for path in ['/api/system/settings','/api/gateway-platform/settings','/api/git/credentials','/api/git/worktrees/tree-1/identity/global']:
  assert not project_http_route_allowed('GET',path,q,'visible',access_level='edit')
  assert not project_http_route_allowed('PUT',path,q,'visible',access_level='edit')
 assert not project_http_route_allowed('GET','/api/git/projects/private/repositories',q,'visible',access_level='edit')
