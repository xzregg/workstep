import base64
import json

import pytest
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from gateway.app import create_app
from gateway.config import GatewaySettings
from gateway.models import Device, PlatformProject
from gateway.services.identity import IdentityService, COOKIE_NAME


@pytest.mark.parametrize('mode', ['read_only', 'interactive'])
def test_login_share_requires_live_login_and_signs_actual_visitor(tmp_path, monkeypatch, mode):
    app = create_app(GatewaySettings(data_dir=tmp_path, public_origin='https://gateway.test'))
    with TestClient(app, base_url='https://gateway.test') as client:
        setup = client.post('/api/platform/setup', json={
            'username': 'owner', 'display_name': 'Owner', 'password': 'OwnerPassphrase-2026!',
            'recovery_username': 'recovery', 'recovery_password': 'RecoveryPassphrase-2026!',
            'registration_mode': 'closed',
        })
        async def seed():
            async with app.state.database.session() as session:
                async with session.begin():
                    session.add(Device(id='device-1', name='PC', public_key='test', status='active', app_instance_id='app', version='1'))
                    session.add(PlatformProject(id='project-1', device_id='device-1', host_project_id='host-1', name='Project', status='active'))
            service = IdentityService(app.state.database)
            owner, _ = await service.session_user(client.cookies[COOKIE_NAME])
            user = await service.admin_create_user('visitor', '访问者', 'VisitorPassphrase-2026!', 'active', owner.id)
            return user.id
        visitor_id = client.portal.call(seed)
        created = client.post('/api/platform-shares', headers={'X-CSRF-Token': setup.json()['csrf_token']}, json={
            'project_id': 'project-1', 'task_id': 'task-1', 'title': 'Login share',
            'mode': mode, 'require_login': mode == 'read_only', 'password': 'must-not-be-stored',
        })
        assert created.status_code == 201, created.text
        share = created.json()
        assert share['require_login'] is True
        assert share['has_password'] is False and share['access_password'] == ''
        if mode == 'interactive':
            # Old editable links also require login even before their row is backfilled.
            from gateway.models import PlatformShare
            async def legacy():
                async with app.state.database.session() as session:
                    async with session.begin():
                        row = await session.get(PlatformShare, share['id'])
                        row.require_login = False
                        row.password_hash = 'legacy-password-hash'
            client.portal.call(legacy)
        saved = client.get('/api/platform-shares?project_id=project-1&task_id=task-1').json()['shares'][0]
        assert saved['require_login'] is True and saved['access_password'] == ''
        assert saved['has_password'] is False
        token = share['url'].rsplit('/', 1)[1]
        base = f'/api/public/shares/{token}'
        client.cookies.clear()
        assert client.get(base + '/meta').json()['require_login'] is True
        assert client.post(base + '/unlock', json={'password': 'must-not-be-stored'}).status_code == 401
        assert client.get(base + '/task').status_code == 401
        for path in ('/artifacts/' + 'a' * 64 + '/preview', '/artifacts/' + 'a' * 64 + '/content'):
            assert client.get(base + path).status_code == 401
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(f'wss://gateway.test/ws/public/shares/{token}', headers={'Origin': 'https://gateway.test'}):
                pass

        async def login():
            _, auth = await IdentityService(app.state.database).login('visitor', 'VisitorPassphrase-2026!')
            return auth
        auth = client.portal.call(login)
        client.cookies.set(COOKIE_NAME, auth)
        unlocked = client.post(base + '/unlock', json={})
        assert unlocked.status_code == 200, unlocked.text
        assert client.get(base + '/session').status_code == 200
        tickets = []
        class Connection:
            async def proxy_websocket(self, ws, *, share_ticket, target_path, authorization_check):
                await authorization_check()
                await ws.accept()
                await ws.send_json({'connected': True})
                await ws.receive_json()
                await authorization_check()
                pytest.fail('A logged-out visitor must lose the live connection')

            async def proxy_http(self, call, *, share_ticket, target_path, authorization_check, **kwargs):
                await authorization_check()
                tickets.append(json.loads(base64.urlsafe_b64decode(share_ticket.split('.')[1] + '===')))
                return JSONResponse({'id': 'task-1'})
        async def data(_): return Connection()
        monkeypatch.setattr(app.state.control_connections, 'is_online', lambda _: True)
        monkeypatch.setattr(app.state.control_connections, 'request_data', data)
        assert client.get(base + '/task').status_code == 200
        artifact = '/artifacts/' + 'a' * 64
        for path in (artifact + '/preview', artifact + '/content'):
            assert client.get(base + path).status_code == 200
        assert tickets[-1]['actor'] == {'user_id': visitor_id, 'username': 'visitor', 'display_name': '访问者'}
        if mode == 'interactive':
            result = client.post(base + '/steps/step-1/message', json={'content': 'test', 'user_id': 'owner'},
                                 headers={'X-Share-CSRF': unlocked.json()['csrf_token']})
            assert result.status_code == 200, result.text
            assert tickets[-1]['actor']['user_id'] == visitor_id
        with client.websocket_connect(f'wss://gateway.test/ws/public/shares/{token}', headers={'Origin': 'https://gateway.test'}) as ws:
            assert ws.receive_json() == {'connected': True}
            client.portal.call(IdentityService(app.state.database).logout, auth)
            ws.send_json({'check': 'logged out'})
            with pytest.raises(WebSocketDisconnect) as closed:
                ws.receive_json()
            assert closed.value.code == 4401
        assert client.get(base + '/session').status_code == 401
        assert client.get(base + '/task').status_code == 401
        for path in (artifact + '/preview', artifact + '/content'):
            assert client.get(base + path).status_code == 401
