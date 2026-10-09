from fastapi.testclient import TestClient
from gateway.app import create_app
from gateway.config import GatewaySettings
from gateway.models import Device, AuditEvent
from test_org_api import _setup


def test_device_group_admin_cannot_manage_other_device_or_grant_itself_content_access(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url="https://gateway.test") as client:
        csrf = _setup(client)
        headers = {"X-CSRF-Token": csrf}
        user = client.post('/api/admin/users', headers=headers, json={
            'username': 'operator', 'display_name': 'Operator', 'password': 'OperatorPassphrase-2026!',
        }).json()
        async def seed():
            async with app.state.database.session() as session:
                async with session.begin():
                    for device_id in ('visible', 'private'):
                        session.add(Device(id=device_id, name=device_id, public_key='key', status='active'))
                    await session.flush()
                    for device_id in ('visible', 'private'):
                        session.add(AuditEvent(id='seed-' + device_id, device_id=device_id, action='seed', result='success'))
        client.portal.call(seed)
        client.post('/api/auth/step-up', headers=headers, json={'password': 'OwnerPassphrase-2026!'})
        group = client.post('/api/admin/device-groups', headers=headers, json={'name': 'Test PCs'})
        assert group.status_code == 201, group.text
        group_id = group.json()['id']
        assert client.put(f'/api/admin/device-groups/{group_id}/devices/visible', headers=headers).status_code == 204
        assert client.post(f"/api/admin/users/{user['id']}/roles", headers=headers, json={
            'role': 'device_admin', 'scope_type': 'device_group', 'scope_id': group_id,
        }).status_code == 201
        assert client.post(f"/api/admin/users/{user['id']}/roles", headers=headers, json={
            'role': 'audit_admin', 'scope_type': 'device_group', 'scope_id': group_id,
        }).status_code == 201
        private_batch = client.post('/api/admin/device-operations', headers=headers, json={
            'action': 'refresh', 'engine_id': 'codex', 'device_ids': ['private'], 'max_concurrency': 1,
        }).json()['id']
        client.cookies.clear()
        csrf = client.post('/api/auth/login', json={
            'username': 'operator', 'password': 'OperatorPassphrase-2026!',
        }).json()['csrf_token']
        headers = {'X-CSRF-Token': csrf}
        client.post('/api/auth/password', headers=headers, json={
            'current_password': 'OperatorPassphrase-2026!', 'new_password': 'OperatorNewPassphrase-2026!',
        })
        client.post('/api/auth/step-up', headers=headers, json={'password': 'OperatorNewPassphrase-2026!'})
        listed = client.get('/api/admin/devices')
        assert listed.status_code == 200, listed.text
        assert [row['id'] for row in listed.json()['devices']] == ['visible']
        assert listed.json()['total'] == 1
        assert client.post('/api/admin/device-operations', headers=headers, json={
            'action': 'refresh', 'engine_id': 'codex', 'device_ids': ['visible', 'private'], 'max_concurrency': 1,
        }).status_code == 403
        own_batch = client.post('/api/admin/device-operations', headers=headers, json={
            'action': 'refresh', 'engine_id': 'codex', 'device_ids': ['visible'], 'max_concurrency': 1,
        })
        assert own_batch.status_code == 200, own_batch.text
        operations = client.get('/api/admin/device-operations')
        assert operations.status_code == 200, operations.text
        assert [row['id'] for row in operations.json()['batches']] == [own_batch.json()['id']]
        assert client.get(f'/api/admin/device-operations/{private_batch}').status_code == 403
        assert client.post('/api/admin/devices/private/disable', headers=headers).status_code == 403
        assert client.post('/api/admin/devices/visible/disable', headers=headers).status_code == 204
        assert client.put('/api/admin/devices/private/name', headers=headers, json={'name': 'Hidden PC'}).status_code == 403
        assert client.put('/api/admin/devices/visible/name', headers=headers, json={'name': 'Team PC'}).status_code == 204
        renamed = client.get('/api/admin/devices').json()['devices'][0]
        assert (renamed['id'], renamed['name'], renamed['status']) == ('visible', 'Team PC', 'disabled')
        assert client.delete('/api/admin/devices/private', headers=headers).status_code == 403
        audited = client.get('/api/admin/audit')
        assert audited.status_code == 200, audited.text
        assert 'seed-visible' in audited.text and 'seed-private' not in audited.text
        assert client.get('/api/admin/users').status_code == 403
        assert client.post('/api/admin/device-groups', headers=headers, json={'name': 'Escalation'}).status_code == 403
        assert client.get('/api/devices').json() == {'devices': []}
        assert client.get('/api/devices/visible/access').status_code == 403
        assert client.get('/api/admin/overview').json()['devices']['total'] == 1


def test_department_project_management_requires_device_and_subject_scope(tmp_path):
    import sqlite3
    from test_org_api import _directory
    from gateway.models import PlatformProject
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url='https://gateway.test') as client:
        csrf = _setup(client); headers = {'X-CSRF-Token': csrf}
        _directory(client, csrf)
        operator = client.post('/api/admin/users', headers=headers, json={
            'username': 'operator', 'display_name': 'Operator', 'password': 'OperatorPassphrase-2026!',
        }).json()
        with sqlite3.connect(tmp_path / 'workstep_platform.db') as db:
            departments = dict(db.execute('SELECT external_id,id FROM directory_departments'))
            people = dict(db.execute('SELECT subject,user_id FROM directory_people'))
        async def seed():
            async with app.state.database.session() as session:
                async with session.begin():
                    for key, dept in (('visible', 'child'), ('private', 'other')):
                        session.add(Device(id=key, name=key, public_key='key', status='active', department_id=departments[dept]))
                    await session.flush()
                    for key in ('visible', 'private'):
                        session.add(PlatformProject(id='project-' + key, device_id=key, host_project_id='host-' + key,
                            name=key, status='active', access_mode='remote_published'))
        client.portal.call(seed)
        client.post('/api/auth/step-up', headers=headers, json={'password': 'OwnerPassphrase-2026!'})
        assert client.post(f"/api/admin/users/{operator['id']}/roles", headers=headers, json={
            'role': 'department_admin', 'scope_type': 'department', 'scope_id': departments['root'],
        }).status_code == 201
        assert client.post(f"/api/admin/users/{operator['id']}/roles", headers=headers, json={
            'role': 'identity_admin', 'scope_type': 'platform',
        }).status_code == 201
        provider = client.post('/api/admin/providers', headers=headers, json={
            'name': 'Company API', 'type': 'openai', 'protocols': ['openai_responses'],
            'protocol_base_urls': {'openai_responses': 'https://api.example.test/v1'},
            'api_key': 'never-expose-this-key', 'models': ['model-a'],
        })
        assert provider.status_code == 200, provider.text
        provider_id = provider.json()['id']
        outside = {'subject_type': 'user', 'subject_id': people['person-c']}
        assert client.post(f'/api/admin/providers/{provider_id}/assign', headers=headers, json=outside).status_code == 200
        client.cookies.clear()
        csrf = client.post('/api/auth/login', json={'username': 'operator', 'password': 'OperatorPassphrase-2026!'}).json()['csrf_token']
        headers = {'X-CSRF-Token': csrf}
        client.post('/api/auth/password', headers=headers, json={'current_password': 'OperatorPassphrase-2026!', 'new_password': 'OperatorNewPassphrase-2026!'})
        client.post('/api/auth/step-up', headers=headers, json={'password': 'OperatorNewPassphrase-2026!'})
        listed = client.get('/api/admin/projects')
        assert listed.status_code == 200, listed.text
        assert [row['id'] for row in listed.json()['projects']] == ['project-visible']
        grant = {'subject_type': 'user', 'subject_id': people['person-b'], 'access_level': 'read'}
        assert client.post('/api/admin/projects/project-private/grants', headers=headers, json=grant).status_code == 403
        assert client.post('/api/admin/projects/project-visible/grants', headers=headers,
                           json={**grant, 'subject_id': people['person-c']}).status_code == 403
        assert client.post('/api/admin/projects/project-visible/grants', headers=headers, json=grant).status_code == 200
        assert client.get('/api/admin/projects/project-private/grants').status_code == 403
        assert client.get('/api/projects').json() == {'projects': []}
        catalog = client.get('/api/admin/providers/assignment-catalog')
        assert catalog.status_code == 200, catalog.text
        assert catalog.json() == {'providers': [{'id': provider_id, 'name': 'Company API', 'enabled': True}]}
        assert client.get('/api/admin/providers').status_code == 403
        own = {'subject_type': 'user', 'subject_id': people['person-b']}
        url = f'/api/admin/providers/{provider_id}'
        assert client.post(url + '/assign', headers=headers, json=outside).status_code == 403
        assert client.post(url + '/assign', headers=headers, json=own).status_code == 200
        assert client.post(url + '/assign', headers=headers, json={'subject_type': 'device', 'subject_id': 'private'}).status_code == 403
        assert client.post(url + '/assign', headers=headers, json={'subject_type': 'device', 'subject_id': 'visible'}).status_code == 200
        assignments = client.get(url + '/assignments').json()
        assert assignments['total'] == 2
        assert {row['subject_id'] for row in assignments['assignments']} == {people['person-b'], 'visible'}
        assert client.put(url + '/assign/default', headers=headers, json={**outside, 'enabled': True}).status_code == 403
        assert client.post(url + '/assign/revoke', headers=headers, json=outside).status_code == 403
        assert client.put(url + '/assign/default', headers=headers, json={**own, 'enabled': True}).status_code == 200
        assert client.post(url + '/assign/revoke', headers=headers, json=own).status_code == 204
        capability = {'capability': 'task.create', 'scope_type': 'project', 'scope_id': 'project-visible', 'effect': 'allow'}
        own_url = f"/api/admin/capabilities/{people['person-b']}"
        assert client.post(own_url, headers=headers, json=capability).status_code == 200
        assert client.post(f"/api/admin/capabilities/{people['person-c']}", headers=headers, json=capability).status_code == 403
        assert client.post(own_url, headers=headers, json={**capability, 'scope_id': 'project-private'}).status_code == 403
        assert client.post(own_url, headers=headers, json={**capability, 'scope_type': 'global', 'scope_id': None}).status_code == 403
        assert client.get('/api/admin/projects/project-visible/task-create-users').status_code == 200
        assert client.get('/api/admin/projects/project-private/task-create-users').status_code == 403
        assert client.get('/api/admin/projects/project-visible/task-create-groups').status_code == 200
        assert client.post(own_url + '/revoke', headers=headers, json={key: value for key, value in capability.items() if key != 'effect'}).status_code == 204
