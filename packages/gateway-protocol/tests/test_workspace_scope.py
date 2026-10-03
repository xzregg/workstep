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
