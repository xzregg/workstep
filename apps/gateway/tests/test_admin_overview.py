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


def test_super_admin_overview_counts_only_published_projects_and_distinguishes_health(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url='https://gateway.test') as client:
        _setup(client)
        with sqlite3.connect(tmp_path / 'workstep_platform.db') as connection:
            connection.execute("INSERT INTO devices (id, name, public_key, status) VALUES ('pc-1', 'PC', 'key', 'active')")
            connection.execute("""INSERT INTO platform_projects
                (id, device_id, host_project_id, name, access_mode, status)
                VALUES ('project-1', 'pc-1', 'host-1', 'Published', 'remote_published', 'active')""")
            connection.execute("""INSERT INTO platform_projects
                (id, device_id, host_project_id, name, access_mode, status)
                VALUES ('project-2', 'pc-1', 'host-2', 'Private', 'policy_only', 'active')""")
            owner_id = connection.execute("SELECT id FROM users WHERE username='owner'").fetchone()[0]
            connection.execute("""INSERT INTO project_access_grants
                (id, project_id, subject_type, subject_id, access_level)
                VALUES ('grant-1', 'project-1', 'user', ?, 'read')""", (owner_id,))
        result = client.get('/api/admin/overview')
        assert result.status_code == 200, result.text
        data = result.json()
        assert data['users']['total'] == 2
        assert data['users']['pending'] == 0
        assert data['devices']['total'] == 1
        assert data['devices']['online'] == 0
        assert data['devices']['daemon_healthy'] == 0
        assert data['devices']['daemon_unhealthy'] == 0
        assert data['projects']['published'] == 1
        assert data['projects']['shared'] == 1
        assert data['projects']['host_offline'] == 1
        assert data['tasks']['running'] is None


def test_overview_rejects_normal_user_and_limits_identity_admin_metrics(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url='https://gateway.test') as client:
        csrf = _setup(client)
        alice = client.post('/api/admin/users', headers={'X-CSRF-Token': csrf}, json={
            'username': 'alice', 'display_name': 'Alice', 'password': 'AlicePassphrase-2026!',
        }).json()
        client.post('/api/admin/users', headers={'X-CSRF-Token': csrf}, json={
            'username': 'bob', 'display_name': 'Bob', 'password': 'BobPassphrase-2026!',
        })
        assert client.post('/api/auth/step-up', headers={'X-CSRF-Token': csrf},
                           json={'password': 'OwnerPassphrase-2026!'}).status_code == 200
        assert client.post(f"/api/admin/users/{alice['id']}/roles", headers={'X-CSRF-Token': csrf}, json={
            'role': 'identity_admin', 'scope_type': 'platform',
        }).status_code == 201
        client.cookies.clear()
        csrf = client.post('/api/auth/login', json={
            'username': 'alice', 'password': 'AlicePassphrase-2026!',
        }).json()['csrf_token']
        overview = client.get('/api/admin/overview')
        assert overview.status_code == 200
        assert overview.json()['devices'] is None
        assert client.post('/api/auth/password', headers={'X-CSRF-Token': csrf}, json={
            'current_password': 'AlicePassphrase-2026!', 'new_password': 'AliceNewPassphrase-2026!',
        }).status_code == 204
        data = client.get('/api/admin/overview').json()
        assert data['users']['total'] == 4
        assert data['devices'] is None
        assert data['projects'] is None
        client.cookies.clear()
        assert client.post('/api/auth/login', json={
            'username': 'bob', 'password': 'BobPassphrase-2026!',
        }).status_code == 200
        assert client.get('/api/admin/overview').status_code == 403


def test_department_admin_overview_counts_only_members_in_scope(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url='https://gateway.test') as client:
        csrf = _setup(client)
        alice = client.post('/api/admin/users', headers={'X-CSRF-Token': csrf}, json={
            'username': 'alice', 'display_name': 'Alice', 'password': 'AlicePassphrase-2026!',
        }).json()
        source = client.post('/api/admin/identity-sources', headers={'X-CSRF-Token': csrf}, json={
            'provider': 'wecom', 'tenant_id': 'tenant-a', 'client_id': 'app',
            'agent_id': '10001', 'secret_env': 'WORKSTEP_TEST_WECOM_SECRET',
        }).json()['id']
        assert client.post(f'/api/admin/identity-sources/{source}/sync', headers={'X-CSRF-Token': csrf}, json={
            'departments': [{'external_id': 'engineering', 'display_name': 'Engineering'},
                            {'external_id': 'sales', 'display_name': 'Sales'}],
            'people': [{'subject': 'person-a', 'display_name': 'Person A', 'department_ids': ['engineering']},
                       {'subject': 'person-b', 'display_name': 'Person B', 'department_ids': ['sales']}],
        }).status_code == 200
        with sqlite3.connect(tmp_path / 'workstep_platform.db') as connection:
            department_id = connection.execute(
                "SELECT id FROM directory_departments WHERE external_id='engineering'").fetchone()[0]
        assert client.post('/api/auth/step-up', headers={'X-CSRF-Token': csrf},
                           json={'password': 'OwnerPassphrase-2026!'}).status_code == 200
        assert client.post(f"/api/admin/users/{alice['id']}/roles", headers={'X-CSRF-Token': csrf}, json={
            'role': 'identity_admin', 'scope_type': 'department', 'scope_id': department_id,
        }).status_code == 201
        client.cookies.clear()
        csrf = client.post('/api/auth/login', json={
            'username': 'alice', 'password': 'AlicePassphrase-2026!',
        }).json()['csrf_token']
        assert client.post('/api/auth/password', headers={'X-CSRF-Token': csrf}, json={
            'current_password': 'AlicePassphrase-2026!', 'new_password': 'AliceNewPassphrase-2026!',
        }).status_code == 204
        data = client.get('/api/admin/overview').json()
        assert data['users'] == {'total': 1, 'pending': 0}
        assert data['devices'] is None
