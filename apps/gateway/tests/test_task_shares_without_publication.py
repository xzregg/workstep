import json
from sqlalchemy import select
from fastapi.testclient import TestClient
from gateway.app import create_app
from gateway.config import GatewaySettings
from gateway.models import Device, PlatformProject, ProjectAccessGrant, User
from gateway.contracts import JsonValue


def test_device_workspace_shares_unpublished_task_without_publishing_project(tmp_path, monkeypatch):
    app = create_app(GatewaySettings(data_dir=tmp_path, public_origin='https://gateway.test'))
    with TestClient(app, base_url='https://gateway.test') as client:
        setup = client.post('/api/platform/setup', json={'username': 'owner', 'display_name': 'Owner',
            'password': 'OwnerPassphrase-2026!', 'recovery_username': 'recovery',
            'recovery_password': 'RecoveryPassphrase-2026!', 'registration_mode': 'closed'})
        assert setup.status_code == 201
        async def seed():
            async with app.state.database.session() as session:
                async with session.begin():
                    session.add(Device(id='device-1', name='PC', public_key='test', status='active', app_instance_id='app', version='1'))
                    session.add(Device(id='device-2', name='Other', public_key='test', status='active', app_instance_id='other', version='1'))
                    session.add(PlatformProject(id='other-project', device_id='device-2', host_project_id='other-host', name='Other', access_mode='policy_only'))
        client.portal.call(seed)
        async def native_control_share():
            from types import SimpleNamespace
            from gateway.services.device_task_shares import manage
            async with app.state.database.session() as session:
                actor = await session.scalar(select(User).where(User.username == 'owner'))
            call = SimpleNamespace(database=app.state.database, settings=app.state.settings, tokens={}, gateway_signer=app.state.gateway_signer)
            body = {'version': 1, 'host_project_id': 'native-unpublished', 'action': 'list', 'payload': {'task_id': 'native-task'}}
            assert await manage(call, 'device-1', actor.id, body) == {'shares': []}
            body.update(action='create', payload={'task_id': 'native-task', 'password': 'access-key'})
            created = await manage(call, 'device-1', actor.id, body)
            assert created['url'].startswith('https://gateway.test/share/')
            async with app.state.database.session() as session:
                project = await session.scalar(select(PlatformProject).where(PlatformProject.host_project_id == 'native-unpublished'))
                assert project.access_mode == 'policy_only' and project.published_at is None
            body.update(action='list', payload={'task_id': 'native-task'})
            listed = await manage(call, 'device-1', actor.id, body)
            assert listed['shares'][0]['url'] == created['url']
            assert listed['shares'][0]['access_password'] == 'access-key'
            body.update(action='revoke', payload={'share_id': created['id']})
            assert await manage(call, 'device-1', actor.id, body) == {'ok': True}
        client.portal.call(native_control_share)
        monkeypatch.setattr(app.state.control_connections, 'is_online', lambda _id: True)
        class Connection:
            async def proxy_http(self, request, *, share_ticket, target_path, authorization_check, **kwargs):
                await authorization_check()
                assert target_path == '/api/platform-share/task'
                return JsonValue({'id': 'task-1'})
        async def connection(_device): return Connection()
        monkeypatch.setattr(app.state.control_connections, 'request_data', connection)
        for base, origin in [('https://d-device-1.gateway.test', 'https://d-device-1.gateway.test'),
                             ('https://gateway.test/workspace/device-1', 'https://gateway.test')]:
            ticket = client.get('/api/devices/device-1/access').json()['ticket']
            assert client.post(base + '/api/remote/redeem', data={'ticket': ticket}, follow_redirects=False).status_code == 303
            target = client.get(base + '/api/remote/session?project_id=unpublished-host')
            assert target.status_code == 200, target.text
            assert target.json()['share_create'] is True
            assert target.json()['host_project_id'] == 'unpublished-host'
            share_api = base + '/api/remote/task-shares'
            assert client.get(share_api + '?host_project_id=unpublished-host&task_id=task-1').status_code == 200
            headers = {'Origin': origin, 'X-WorkStep-Share-Intent': 'manage'}
            assert client.post(share_api, json={'host_project_id': 'unpublished-host', 'task_id': 'task-1'}).status_code == 403
            assert client.post(share_api, json={'project_id': 'other-project', 'task_id': 'task-1'}, headers=headers).status_code == 403
            for mode in ('read_only', 'interactive'):
                created = client.post(share_api, json={'host_project_id': 'unpublished-host', 'task_id': 'task-1', 'mode': mode, 'password': 'access-key'}, headers=headers)
                assert created.status_code == 201, created.text
                share = created.json()
                async def registry():
                    async with app.state.database.session() as session:
                        project = await session.scalar(select(PlatformProject).where(PlatformProject.device_id == 'device-1', PlatformProject.host_project_id == 'unpublished-host'))
                        grants = (await session.scalars(select(ProjectAccessGrant).where(ProjectAccessGrant.project_id == project.id))).all()
                        return project.access_mode, project.published_at, grants
                assert client.portal.call(registry) == ('policy_only', None, [])
                token = share['url'].rsplit('/', 1)[1]
                public = '/api/public/shares/' + token
                assert client.get(public + '/meta').status_code == 200
                assert client.post(public + '/unlock', json={'password': 'access-key'}).status_code == 200
                assert client.get(public + '/task').json()['id'] == 'task-1'
                listing = client.get(share_api + '?host_project_id=unpublished-host&task_id=task-1')
                assert any(item['id'] == share['id'] for item in listing.json()['shares'])
                assert client.post(share_api + '/' + share['id'] + '/revoke', headers=headers).status_code == 204
                assert client.get(public + '/meta').status_code == 404
