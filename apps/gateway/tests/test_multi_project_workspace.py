from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from gateway.app import create_app
from gateway.config import GatewaySettings
from gateway.contracts import JsonValue
from gateway.models import Device, PlatformProject, ProjectAccessGrant


def test_project_workspace_reads_and_streams_each_authorized_project_without_redeeming(tmp_path, monkeypatch):
    app = create_app(GatewaySettings(data_dir=tmp_path, public_origin='https://gateway.test'))
    with TestClient(app, base_url='https://gateway.test') as client:
        setup = client.post('/api/platform/setup', json={
            'username': 'owner', 'display_name': 'Owner', 'password': 'OwnerPassphrase-2026!',
            'recovery_username': 'recovery', 'recovery_password': 'RecoveryPassphrase-2026!',
            'registration_mode': 'open',
        })
        headers = {'X-CSRF-Token': setup.json()['csrf_token']}
        worker = client.post('/api/admin/users', json={
            'username': 'worker', 'display_name': 'Worker', 'password': 'WorkerPassphrase-2026!',
        }, headers=headers).json()['id']

        async def seed():
            async with app.state.database.session() as db:
                async with db.begin():
                    for device in ('one', 'two'):
                        db.add(Device(id=device, name=device, public_key='test', status='active', app_instance_id=device, version='1'))
                    for project, device, level in [('a', 'one', 'read'), ('b', 'one', 'edit'), ('private', 'one', None), ('other', 'two', 'edit')]:
                        db.add(PlatformProject(id=project, device_id=device, host_project_id='host-' + project,
                                               name=project, access_mode='remote_published'))
                        if level:
                            db.add(ProjectAccessGrant(id='grant-' + project, project_id=project, subject_type='user', subject_id=worker, access_level=level))
        client.portal.call(seed)
        monkeypatch.setattr(app.state.control_connections, 'is_online', lambda _: True)
        client.cookies.clear()
        login = client.post('/api/auth/login', json={'username': 'worker', 'password': 'WorkerPassphrase-2026!'})
        client.post('/api/auth/password', json={'current_password': 'WorkerPassphrase-2026!', 'new_password': 'WorkerNewPassphrase-2026!'},
                    headers={'X-CSRF-Token': login.json()['csrf_token']})
        ticket = client.get('/api/projects/a/access').json()['ticket']
        workspace = '/workspace/one'
        assert client.post(workspace + '/api/remote/redeem', data={'ticket': ticket}, follow_redirects=False).status_code == 303
        cookies = dict(client.cookies)
        payload = client.get(workspace + '/api/remote/session').json()
        assert {(p['host_project_id'], p['access_level']) for p in payload['projects']} == {('host-a', 'read'), ('host-b', 'edit')}
        assert client.get('/api/devices/one/access').status_code == 403

        class Connection:
            async def proxy_http(self, call, **identity):
                await identity['authorization_check']()
                return JsonValue({'project': identity['project_id'], 'level': identity['access_level']})

            async def proxy_websocket(self, ws, **identity):
                await identity['authorization_check']()
                await ws.port.accept()
                await ws.port.send_json({'project': identity['project_id']})
                await ws.port.close()

        async def connect(device):
            assert device == 'one'
            return Connection()
        monkeypatch.setattr(app.state.control_connections, 'request_data', connect)
        for project, level in [('a', 'read'), ('b', 'edit')]:
            for endpoint in (f'/api/project/host-{project}/summary', f'/api/workflow/list?project_id=host-{project}', f'/api/chat-sessions?project_id=host-{project}'):
                response = client.get(workspace + endpoint)
                assert response.status_code == 200, response.text
                assert response.json() == {'project': 'host-' + project, 'level': level}
            with client.websocket_connect(f'wss://gateway.test/ws/workspace/one?project_id=host-{project}') as ws:
                assert ws.receive_json() == {'project': 'host-' + project}
        assert client.post(workspace + '/api/workflow/create?project_id=host-a', json={'name': 'No'}).status_code == 403
        assert client.post(workspace + '/api/workflow/create?project_id=host-b', json={'name': 'Yes'}).status_code == 200
        assert client.get(workspace + '/api/remote/session?project_id=host-b').json()['access_level'] == 'edit'
        for project in ('private', 'other'):
            assert client.get(workspace + f'/api/project/host-{project}/summary').status_code == 403
            assert client.get(workspace + f'/api/chat-sessions?project_id=host-{project}').status_code == 403
            with pytest.raises(WebSocketDisconnect):
                with client.websocket_connect(f'wss://gateway.test/ws/workspace/one?project_id=host-{project}'):
                    pass
        assert client.get(workspace + '/api/chat-sessions?project_id=host-a&project_id=host-b').status_code == 403
        assert client.get(workspace + '/api/project/list').status_code == 403
        assert dict(client.cookies) == cookies

        async def revoke():
            async with app.state.database.session() as db:
                async with db.begin():
                    grant = await db.get(ProjectAccessGrant, 'grant-b')
                    grant.revoked_at = datetime.now(timezone.utc)
        client.portal.call(revoke)
        assert client.get(workspace + '/api/chat-sessions?project_id=host-b').status_code == 403
        assert [p['host_project_id'] for p in client.get(workspace + '/api/remote/session').json()['projects']] == ['host-a']

        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect('wss://gateway.test/ws/workspace/one?project_id=host-b'):
                pass
        assert client.get(workspace + '/api/remote/session?project_id=host-a').json()['access_level'] == 'read'
        assert dict(client.cookies) == cookies
