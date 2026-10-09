from fastapi.testclient import TestClient

from gateway.app import create_app
from gateway.config import GatewaySettings
from gateway.models import Device, PlatformProject


def test_admin_project_directory_is_paged_and_contains_only_published_metadata(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url='https://gateway.test') as client:
        setup = client.post('/api/platform/setup', json={
            'username': 'owner', 'display_name': 'Owner', 'password': 'OwnerPassphrase-2026!',
            'recovery_username': 'recovery', 'recovery_password': 'RecoveryPassphrase-2026!',
            'registration_mode': 'open',
        })
        csrf = setup.json()['csrf_token']
        worker = client.post('/api/admin/users', headers={'X-CSRF-Token': csrf}, json={
            'username': 'worker', 'display_name': 'Worker', 'password': 'WorkerPassphrase-2026!',
        }).json()['id']

        async def seed():
            async with app.state.database.session() as session:
                async with session.begin():
                    session.add(Device(id='pc-1', name='Main PC', public_key='test',
                                       status='active', app_instance_id='app-1', version='1.0'))
                    for project_id, name, mode in (
                        ('project-a', 'Alpha', 'remote_published'),
                        ('project-b', 'Beta', 'remote_published'),
                        ('project-local', 'Private', 'policy_only'),
                    ):
                        session.add(PlatformProject(id=project_id, device_id='pc-1',
                                                    host_project_id=f'host-{project_id}',
                                                    name=name, access_mode=mode, status='active'))

        client.portal.call(seed)
        assert client.post('/api/auth/step-up', headers={'X-CSRF-Token': csrf}, json={
            'password': 'OwnerPassphrase-2026!',
        }).status_code == 200
        group = client.post('/api/groups', headers={'X-CSRF-Token': csrf}, json={
            'name': 'Engineering', 'slug': 'engineering',
        })
        assert group.status_code == 201, group.text
        assert client.post('/api/admin/projects/project-a/grants', headers={'X-CSRF-Token': csrf}, json={
            'subject_type': 'user', 'subject_id': worker, 'access_level': 'edit',
        }).status_code == 200
        listed = client.get('/api/admin/projects?sort=name&direction=asc&page_size=1')
        assert listed.status_code == 200, listed.text
        assert listed.json()['total'] == 2
        first = listed.json()['projects'][0]
        assert first['id'] == 'project-a'
        assert first['device_name'] == 'Main PC'
        assert first['device_online'] is False
        assert first['grant_users'] == 1
        assert first['grant_groups'] == 0
        assert first['grant_levels'] == {'read': 0, 'edit': 1}
        grants = client.get('/api/admin/projects/project-a/grants').json()['grants']
        assert grants[0]['subject_name'] == 'worker'
        assert 'host_project_id' not in first
        assert 'content' not in first
        second = client.get('/api/admin/projects?sort=name&direction=asc&page=2&page_size=1').json()
        assert second['projects'][0]['name'] == 'Beta'
        assert client.get('/api/admin/projects?q=Alpha').json()['total'] == 1
        assert client.get('/api/admin/projects?page_size=101').status_code == 422
        subjects = client.get('/api/admin/project-grant-subjects?subject_type=user&q=work&page_size=1')
        assert subjects.json()['total'] == 1
        assert subjects.json()['subjects'][0]['name'] == 'worker'
        groups = client.get('/api/admin/project-grant-subjects?subject_type=group&q=Engineer')
        assert groups.json()['total'] == 1
        assert groups.json()['subjects'][0]['name'] == 'Engineering'
        assert client.get('/api/admin/project-grant-subjects?subject_type=group&page_size=101').status_code == 422
        assert client.get('/api/admin/projects/project-local/grants').status_code == 404
        # Super administrators have project access; the seeded device is offline.
        assert client.get('/api/projects/project-a/access').status_code == 409

        client.cookies.clear()
        assert client.get('/api/admin/projects').status_code == 401
        login = client.post('/api/auth/login', json={
            'username': 'worker', 'password': 'WorkerPassphrase-2026!',
        })
        assert login.status_code == 200
        assert client.get('/api/admin/projects').status_code == 403
        assert client.get('/api/admin/project-grant-subjects?subject_type=user').status_code == 403
        assert client.get('/api/admin/projects/project-a/grants').status_code == 403
