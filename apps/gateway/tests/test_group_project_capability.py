from fastapi.testclient import TestClient

from gateway.app import create_app
from gateway.services.capabilities import compiled_device_policy
from gateway.config import GatewaySettings
from gateway.models import Device, PlatformProject
from gateway.services.project_publication import record_project_publication


def test_group_task_create_tracks_current_membership_and_denies_override(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url='https://gateway.test') as client:
        setup = client.post('/api/platform/setup', json={
            'username': 'owner', 'display_name': 'Owner', 'password': 'OwnerPassphrase-2026!',
            'recovery_username': 'recovery', 'recovery_password': 'RecoveryPassphrase-2026!',
            'registration_mode': 'open',
        })
        headers = {'X-CSRF-Token': setup.json()['csrf_token']}
        user_id = client.post('/api/admin/users', headers=headers, json={
            'username': 'worker', 'display_name': 'Worker', 'password': 'WorkerPassphrase-2026!',
        }).json()['id']
        assert client.post('/api/auth/step-up', headers=headers, json={
            'password': 'OwnerPassphrase-2026!',
        }).status_code == 200
        group_id = client.post('/api/groups', headers=headers, json={
            'name': 'Engineering', 'slug': 'engineering',
        }).json()['id']

        async def seed():
            async with app.state.database.session() as session:
                async with session.begin():
                    session.add(Device(id='pc-1', name='PC', public_key='test',
                                       status='active', app_instance_id='app', version='1.0'))
                    session.add(PlatformProject(id='project-1', device_id='pc-1',
                                                host_project_id='host-1', name='Project',
                                                access_mode='remote_published', status='active'))

        client.portal.call(seed)
        assert client.post(f'/api/groups/{group_id}/members', headers=headers, json={
            'user_id': user_id,
        }).status_code == 200
        url = f'/api/admin/projects/project-1/task-create-groups/{group_id}'
        assert client.post(url, headers=headers, json={'effect': 'allow'}).status_code == 200
        listed = client.get('/api/admin/projects/project-1/task-create-groups')
        assert listed.json()['assignments'][0]['group_name'] == 'Engineering'

        def policy():
            return client.portal.call(compiled_device_policy, app.state.database, 'pc-1', user_id)

        first = policy()
        assert first[3] == ['host-1']
        assert client.delete(f'/api/groups/{group_id}/members/{user_id}', headers=headers).status_code == 204
        removed = policy()
        assert removed[0] > first[0]
        assert removed[3] == []
        assert client.post(f'/api/groups/{group_id}/members', headers=headers, json={
            'user_id': user_id,
        }).status_code == 200
        restored = policy()
        assert restored[0] > removed[0]
        assert restored[3] == ['host-1']
        assert client.post(f'/api/admin/capabilities/{user_id}', headers=headers, json={
            'capability': 'task.create', 'scope_type': 'project', 'scope_id': 'project-1',
            'effect': 'deny',
        }).status_code == 200
        user_rules = client.get('/api/admin/projects/project-1/task-create-users').json()['assignments']
        assert user_rules[0]['username'] == 'worker'
        assert user_rules[0]['effect'] == 'deny'
        denied = policy()
        assert denied[3] == []
        assert denied[4] == ['host-1']
        assert client.post(f'/api/admin/capabilities/{user_id}/revoke', headers=headers, json={
            'capability': 'task.create', 'scope_type': 'project', 'scope_id': 'project-1',
        }).status_code == 204
        assert policy()[3] == ['host-1']
        async def publish(action):
            return await record_project_publication(
                app.state.database, device_id='pc-1', user_id='owner',
                host_project_id='host-1', name='Project', action=action,
            )

        client.portal.call(publish, 'unpublish')
        unpublished = policy()
        assert unpublished[0] > restored[0]
        assert unpublished[3] == []
        client.portal.call(publish, 'publish')
        assert policy()[3] == ['host-1']
        assert client.post(url, headers=headers, json={'effect': 'deny'}).status_code == 200
        assert policy()[4] == ['host-1']
        assert client.delete(url, headers=headers).status_code == 204
        assert policy()[3] == []
        assert client.get('/api/admin/projects/project-1/task-create-groups').json()['assignments'] == []
        client.cookies.clear()
        assert client.get('/api/admin/projects/project-1/task-create-groups').status_code == 401
        login = client.post('/api/auth/login', json={
            'username': 'worker', 'password': 'WorkerPassphrase-2026!',
        })
        assert login.status_code == 200
        assert client.get('/api/admin/projects/project-1/task-create-users').status_code == 403
        assert client.post(url, headers={'X-CSRF-Token': login.json()['csrf_token']},
                           json={'effect': 'allow'}).status_code == 403
