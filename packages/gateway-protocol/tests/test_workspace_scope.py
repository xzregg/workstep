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
