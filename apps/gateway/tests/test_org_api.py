import sqlite3

from fastapi.testclient import TestClient

from gateway.app import create_app
from gateway.config import GatewaySettings


def _setup(client):
    return client.post('/api/platform/setup', json={
        'username': 'owner', 'display_name': 'Owner', 'password': 'OwnerPassphrase-2026!',
        'recovery_username': 'recovery', 'recovery_password': 'RecoveryPassphrase-2026!',
        'registration_mode': 'closed',
    }).json()['csrf_token']


def _directory(client, csrf):
    source = client.post('/api/admin/identity-sources', headers={'X-CSRF-Token': csrf}, json={
        'provider': 'wecom', 'tenant_id': 'tenant-a', 'client_id': 'app',
        'agent_id': '10001', 'secret_env': 'WORKSTEP_TEST_WECOM_SECRET',
    }).json()['id']
    result = client.post(f'/api/admin/identity-sources/{source}/sync', headers={'X-CSRF-Token': csrf}, json={
        'departments': [
            {'external_id': 'root', 'display_name': 'Root'},
            {'external_id': 'child', 'display_name': 'Child', 'parent_external_id': 'root'},
            {'external_id': 'other', 'display_name': 'Other'},
        ],
        'people': [
            {'subject': 'person-a', 'display_name': 'Person A', 'department_ids': ['root']},
            {'subject': 'person-b', 'display_name': 'Person B', 'department_ids': ['child']},
            {'subject': 'person-c', 'display_name': 'Person C', 'department_ids': ['other']},
        ],
    })
    assert result.status_code == 200, result.text
    return source


def test_super_admin_lists_sources_departments_and_direct_members_with_pagination(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url='https://gateway.test') as client:
        csrf = _setup(client)
        source = _directory(client, csrf)
        sources = client.get('/api/admin/identity-sources')
        assert sources.status_code == 200, sources.text
        assert sources.json()['sources'][0]['id'] == source
        assert 'secret_env' not in sources.json()['sources'][0]
        listed = client.get(f'/api/admin/org/departments?source_id={source}&sort=display_name&direction=asc&page=1&page_size=2')
        assert listed.status_code == 200, listed.text
        assert listed.json()['total'] == 3
        assert [row['display_name'] for row in listed.json()['departments']] == ['Child', 'Other']
        child = listed.json()['departments'][0]
        assert child['direct_members'] == 1
        assert child['provider'] == 'wecom'
        assert child['parent_external_id'] == 'root'
        roots = client.get(f'/api/admin/org/departments?source_id={source}&roots_only=true&page_size=1').json()
        assert roots['total'] == 2
        assert roots['departments'][0]['external_id'] == 'other'
        assert roots['departments'][0]['child_count'] == 0
        root_page = client.get(f'/api/admin/org/departments?source_id={source}&roots_only=true&page=2&page_size=1').json()
        assert root_page['departments'][0]['external_id'] == 'root'
        root_id = root_page['departments'][0]['id']
        assert root_page['departments'][0]['child_count'] == 1
        children = client.get(f'/api/admin/org/departments?parent_id={root_id}').json()
        assert [row['external_id'] for row in children['departments']] == ['child']
        members = client.get(f"/api/admin/org/departments/{child['id']}/members?page=1&page_size=1")
        assert members.status_code == 200, members.text
        assert members.json()['total'] == 1
        assert members.json()['members'][0]['display_name'] == 'Person B'
        assert client.get('/api/admin/org/departments?page_size=101').status_code == 422
        assert client.post(f'/api/admin/identity-sources/{source}/sync', headers={'X-CSRF-Token': csrf}, json={
            'departments': [{'external_id': 'root', 'display_name': 'Root'}],
            'people': [],
        }).status_code == 200
        deleted = client.get('/api/admin/org/departments?status=deleted').json()
        assert {row['display_name'] for row in deleted['departments']} == {'Child', 'Other'}
        assert all(row['active'] is False for row in deleted['departments'])
        client.cookies.clear()
        assert client.get('/api/admin/org/departments').status_code == 401


def test_department_admin_cannot_read_outside_scope_or_deleted_directory_rows(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url='https://gateway.test') as client:
        csrf = _setup(client)
        alice = client.post('/api/admin/users', headers={'X-CSRF-Token': csrf}, json={
            'username': 'alice', 'display_name': 'Alice', 'password': 'AlicePassphrase-2026!',
        }).json()
        source = _directory(client, csrf)
        with sqlite3.connect(tmp_path / 'workstep_platform.db') as connection:
            root = connection.execute("SELECT id FROM directory_departments WHERE external_id='root'").fetchone()[0]
            child = connection.execute("SELECT id FROM directory_departments WHERE external_id='child'").fetchone()[0]
            other = connection.execute("SELECT id FROM directory_departments WHERE external_id='other'").fetchone()[0]
        assert client.post('/api/auth/step-up', headers={'X-CSRF-Token': csrf},
                           json={'password': 'OwnerPassphrase-2026!'}).status_code == 200
        assert client.post(f"/api/admin/users/{alice['id']}/roles", headers={'X-CSRF-Token': csrf}, json={
            'role': 'identity_admin', 'scope_type': 'department', 'scope_id': root,
            'include_subdepartments': False,
        }).status_code == 201
        client.cookies.clear()
        csrf = client.post('/api/auth/login', json={
            'username': 'alice', 'password': 'AlicePassphrase-2026!',
        }).json()['csrf_token']
        assert client.post('/api/auth/password', headers={'X-CSRF-Token': csrf}, json={
            'current_password': 'AlicePassphrase-2026!', 'new_password': 'AliceNewPassphrase-2026!',
        }).status_code == 204
        listed = client.get(f'/api/admin/org/departments?source_id={source}')
        assert listed.status_code == 200, listed.text
        assert [row['id'] for row in listed.json()['departments']] == [root]
        scoped_roots = client.get('/api/admin/org/departments?roots_only=true').json()
        assert [row['id'] for row in scoped_roots['departments']] == [root]
        assert scoped_roots['departments'][0]['child_count'] == 0
        assert client.get(f'/api/admin/org/departments?parent_id={child}').status_code == 403
        assert client.get(f'/api/admin/org/departments/{child}/members').status_code == 403
        assert client.get(f'/api/admin/org/departments/{other}/members').status_code == 403
        assert client.get('/api/admin/identity-sources').status_code == 403
