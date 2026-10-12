"""Project UI policies preserve existing device protocol authorization."""
from fastapi.testclient import TestClient
from gateway.app import create_app
from gateway.config import GatewaySettings
from gateway.models import Device, PlatformProject


def test_project_presets_assign_users_without_devices_and_merge_group_denials(tmp_path, monkeypatch):
    app = create_app(GatewaySettings(data_dir=tmp_path, public_origin='https://gateway.test'))
    with TestClient(app, base_url='https://gateway.test') as client:
        setup = client.post('/api/platform/setup', json={
            'username': 'owner', 'display_name': 'Owner', 'password': 'OwnerPassphrase-2026!',
            'recovery_username': 'recovery', 'recovery_password': 'RecoveryPassphrase-2026!', 'registration_mode': 'open',
        }).json()
        headers = {'X-CSRF-Token': setup['csrf_token']}
        client.post('/api/auth/step-up', headers=headers, json={'password': 'OwnerPassphrase-2026!'})
        worker = client.post('/api/admin/users', headers=headers, json={
            'username': 'worker', 'display_name': 'Worker', 'password': 'WorkerPassphrase-2026!',
        }).json()['id']
        group = client.post('/api/groups', headers=headers, json={'name': 'Team', 'slug': 'team'}).json()['id']
        client.post(f'/api/groups/{group}/members', headers=headers, json={'user_id': worker})
        async def seed():
            async with app.state.database.session() as session:
                async with session.begin():
                    session.add(Device(id='device', name='PC', public_key='test', status='active', app_instance_id='app', version='1'))
                    session.add(PlatformProject(id='project', device_id='device', host_project_id='host', name='Project', access_mode='remote_published'))
        client.portal.call(seed)
        catalog = client.get('/api/admin/permissions/catalog').json()
        creator = next(p for p in catalog['project_permission_sets'] if p['id'] == 'creator')
        body = {'subject_type': 'user', 'subject_id': worker, 'project_id': 'project', 'allow': creator['permissions'], 'deny': []}
        endpoint = '/api/admin/permissions/project-set'
        assert client.post(endpoint, json=body).status_code == 403
        assert client.post(endpoint, headers=headers, json={**body, 'allow': ['admin.super_admin']}).status_code == 422
        saved = client.post(endpoint, headers=headers, json=body)
        assert saved.status_code == 200, saved.text
        listed = client.get(f'/api/admin/permissions?subject_type=user&subject_id={worker}').json()['assignments']
        row = next(r for r in listed if r['id'] == saved.json()['id'])
        assert row['ui_permissions']['allow'] == sorted(creator['permissions'])
        assert row['permission'] == 'project.edit'
        assert client.post(endpoint, headers=headers, json={
            'subject_type': 'group', 'subject_id': group, 'project_id': 'project',
            'allow': ['task.read', 'workflow.read', 'task.chat'], 'deny': ['task.create'],
        }).status_code == 200
        monkeypatch.setattr(app.state.control_connections, 'is_online', lambda _: True)
        client.cookies.clear()
        client.post('/api/auth/login', json={'username': 'worker', 'password': 'WorkerPassphrase-2026!'})
        assert client.get('/api/devices').json() == {'devices': []}
        host = 'https://d-device.gateway.test'
        ticket = client.get('/api/projects/project/access').json()['ticket']
        assert client.post(host+'/api/remote/redeem', data={'ticket': ticket}, follow_redirects=False).status_code == 303
        remote = client.get(host+'/api/remote/session').json()
        assert remote['access_level'] == 'edit'
        assert 'task.chat' in remote['permissions']
        assert 'task.create' not in remote['permissions']
        for permission in ('workflow.edit', 'git.write', 'file.edit', 'session.create', 'session.chat'):
            assert permission not in remote['permissions']
        assert remote['task_create'] is False
        client.cookies.clear()
        login = client.post('/api/auth/login', json={'username': 'owner', 'password': 'OwnerPassphrase-2026!'}).json()
        headers = {'X-CSRF-Token': login['csrf_token']}
        client.post('/api/auth/step-up', headers=headers, json={'password': 'OwnerPassphrase-2026!'})
        client.delete(f'/api/groups/{group}/members/{worker}', headers=headers)
        client.cookies.clear()
        client.post('/api/auth/login', json={'username': 'worker', 'password': 'WorkerPassphrase-2026!'})
        ticket = client.get('/api/projects/project/access').json()['ticket']
        client.post(host+'/api/remote/redeem', data={'ticket': ticket}, follow_redirects=False)
        remote = client.get(host+'/api/remote/session').json()
        assert 'task.create' in remote['permissions']
        assert 'task.chat' not in remote['permissions']
        assert remote['task_create'] is True
        client.cookies.clear()
        login = client.post('/api/auth/login', json={'username': 'owner', 'password': 'OwnerPassphrase-2026!'}).json()
        headers = {'X-CSRF-Token': login['csrf_token']}
        client.post('/api/auth/step-up', headers=headers, json={'password': 'OwnerPassphrase-2026!'})
        assert client.post(endpoint, headers=headers, json={**body, 'allow': ['task.read', 'task.copy']}).status_code == 200
        client.cookies.clear()
        client.post('/api/auth/login', json={'username': 'worker', 'password': 'WorkerPassphrase-2026!'})
        ticket = client.get('/api/projects/project/access').json()['ticket']
        client.post(host+'/api/remote/redeem', data={'ticket': ticket}, follow_redirects=False)
        remote = client.get(host+'/api/remote/session').json()
        assert remote['task_create'] is True
        assert 'task.copy' in remote['permissions']
        assert 'task.create' not in remote['permissions']


def test_project_policy_write_waiting_for_sqlite_lock_keeps_health_responsive(tmp_path):
    import sqlite3
    import time
    from concurrent.futures import ThreadPoolExecutor
    from test_control_connection import _active_device
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id='gateway-test'))
    with TestClient(app, base_url='https://gateway.test') as client:
        device, _, _, csrf = _active_device(client)
        headers = {'X-CSRF-Token': csrf}
        owner = client.get('/api/auth/session').json()['user']['id']
        async def seed():
            async with app.state.database.session() as session:
                async with session.begin():
                    session.add(PlatformProject(id='project', device_id=device, host_project_id='host', name='Project', access_mode='remote_published'))
        client.portal.call(seed)
        with ThreadPoolExecutor(max_workers=1) as pool:
            with sqlite3.connect(tmp_path / 'workstep_platform.db') as holder:
                holder.execute('BEGIN IMMEDIATE')
                pending = pool.submit(client.post, '/api/admin/permissions/project-set', headers=headers, json={
                    'subject_type': 'user', 'subject_id': owner, 'project_id': 'project', 'allow': ['task.read', 'task.create'], 'deny': [],
                })
                time.sleep(.1)
                assert not pending.done()
                started = time.monotonic()
                assert client.get('/api/health').status_code == 200
                assert time.monotonic() - started < .3
                holder.rollback()
            result = pending.result(timeout=5)
            assert result.status_code == 200, result.text
        grant_id = result.json()['id']
        assert client.delete(f'/api/admin/permissions/{grant_id}', headers=headers).status_code == 204
        remaining = client.get(f'/api/admin/permissions?subject_type=user&subject_id={owner}').json()['assignments']
        assert not any(row['scope_id'] == 'project' for row in remaining)
