from fastapi.testclient import TestClient
import base64
import json
from cryptography.hazmat.primitives import serialization
from gateway.contracts import JsonValue as JSONResponse

from gateway.app import create_app
from gateway.config import GatewaySettings


def test_user_sees_only_assigned_pc_and_admin_can_revoke(tmp_path, monkeypatch):
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test",
                                     public_origin="https://gateway.test"))
    with TestClient(app, base_url="https://gateway.test") as client:
        setup = client.post("/api/platform/setup", json={
            "username": "owner", "display_name": "Owner", "password": "OwnerPassphrase-2026!",
            "recovery_username": "recovery", "recovery_password": "RecoveryPassphrase-2026!",
            "registration_mode": "open",
        })
        csrf = setup.json()["csrf_token"]
        created = client.post("/api/auth/register", json={
            "username": "alice", "display_name": "Alice", "password": "AlicePassphrase-2026!",
        })
        user_id = created.json()["user"]["id"]
        assert client.get("/api/devices").json() == {"devices": []}
        client.post("/api/auth/logout", headers={"X-CSRF-Token": created.json()["csrf_token"]})
        login = client.post("/api/auth/login", json={"username": "owner",
                                                   "password": "OwnerPassphrase-2026!"})
        csrf = login.json()["csrf_token"]
        # Device registration is covered by the authorization tests; this test starts
        # with a registered PC to isolate assignment and visibility behavior.
        from gateway.models import Device
        async def insert_device():
            async with app.state.database.session() as session:
                async with session.begin():
                    session.add(Device(id="device-1", name="Office PC", public_key="test",
                                       status="active", app_instance_id="instance-1",
                                       version="1.0.0"))
        client.portal.call(insert_device)
        assert [item['id'] for item in client.get("/api/devices").json()['devices']] == ['device-1']
        headers = {"X-CSRF-Token": csrf}
        assert client.post(f"/api/admin/devices/device-1/users", json={"user_id": user_id},
                           headers=headers).status_code == 403
        assert client.post("/api/auth/step-up", json={"password": "OwnerPassphrase-2026!"},
                           headers=headers).status_code == 200
        assigned = client.post(f"/api/admin/devices/device-1/users", json={"user_id": user_id},
                               headers=headers)
        assert assigned.status_code == 200, assigned.text
        client.post("/api/auth/logout", headers=headers)
        alice = client.post("/api/auth/login", json={"username": "alice",
                                                   "password": "AlicePassphrase-2026!"})
        assert alice.status_code == 200
        visible = client.get("/api/devices")
        assert visible.status_code == 200
        assert visible.json()["devices"] == [{"id": "device-1", "name": "Office PC",
                                               "status": "active", "online": False,
                                               "version": "1.0.0"}]
        assert client.get("/api/devices/device-1/access").status_code == 409
        monkeypatch.setattr(app.state.control_connections, "is_online", lambda _id: True)
        access = client.get("/api/devices/device-1/access")
        assert access.status_code == 200, access.text
        issued = access.json()
        assert issued["url"] == "https://gateway.test/workspace/device-1/"
        header, payload, signature = issued["ticket"].split(".")
        key = client.get("/api/platform/gateway-key").json()["public_key_pem"]
        serialization.load_pem_public_key(key.encode()).verify(
            base64.urlsafe_b64decode(signature + "=="), f"{header}.{payload}".encode(),
        )
        claims = json.loads(base64.urlsafe_b64decode(payload + "=="))
        assert claims["device_id"] == "device-1"
        assert claims["user_id"] == user_id
        assert claims["aud"] == "d-device-1.gateway.test"
        remote_url = "https://d-device-1.gateway.test"
        wrong_host = client.post("/api/remote/redeem", data={"ticket": issued["ticket"]})
        assert wrong_host.status_code == 403
        assert client.post("https://d-device-2.gateway.test/api/remote/redeem",
                           data={"ticket": issued["ticket"]}).status_code == 403
        assert client.post(f"{remote_url}/api/remote/redeem",
                           data={"ticket": issued["ticket"] + "x"}).status_code == 403
        redeemed = client.post(f"{remote_url}/api/remote/redeem", data={"ticket": issued["ticket"]},
                               follow_redirects=False)
        assert redeemed.status_code == 303, redeemed.text
        assert redeemed.headers["location"] == "/"
        assert "workstep_gateway_session=" in redeemed.headers["set-cookie"]
        assert client.post(f"{remote_url}/api/remote/redeem",
                           data={"ticket": issued["ticket"]}).status_code == 409
        assert client.get(f"{remote_url}/api/remote/session").json()["device_id"] == "device-1"
        assert client.get(f"{remote_url}/api/remote/project-grants").status_code == 403
        class FakeData:
            async def proxy_http(self, request, *, user_id, username, display_name,
                                 provider_ids, provider_grant_expires_at, authorization_check, device_owner=False):
                await authorization_check()
                assert provider_ids == []
                assert provider_grant_expires_at > 0
                assert display_name == "Alice"
                assert user_id == claims["user_id"]
                assert username == "alice"
                return JSONResponse({"proxied": request.target.path})
            async def proxy_websocket(self, ws, *, user_id, username, display_name,
                                      provider_ids, provider_grant_expires_at, authorization_check, device_owner=False):
                await authorization_check()
                assert provider_ids == []
                assert provider_grant_expires_at > 0
                assert display_name == "Alice"
                assert user_id == claims["user_id"]
                assert username == "alice"
                await ws.accept()
                await ws.send_text("remote-ready")
                await ws.close(code=1000)
        async def request_data(device_id):
            assert device_id == "device-1"
            return FakeData()
        monkeypatch.setattr(app.state.control_connections, "request_data", request_data)
        assert client.get(f"{remote_url}/api/health").json() == {"proxied": "/api/health"}
        assert client.get(f"{remote_url}/").json() == {"proxied": "/"}
        assert client.get(f"{remote_url}/assets/main.js").json() == {"proxied": "/assets/main.js"}
        with client.websocket_connect("wss://d-device-1.gateway.test/ws",
                                      headers={"origin": remote_url}) as socket:
            assert socket.receive_text() == "remote-ready"
        with client.websocket_connect("wss://d-device-1.gateway.test/ws",
                                      headers={"origin": "https://proxy.example"}) as socket:
            assert socket.receive_text() == "remote-ready"
        assert client.get("https://d-device-2.gateway.test/api/remote/session").status_code == 403
        assert client.get("/api/devices").status_code == 200
        client.post("/api/auth/logout", headers={"X-CSRF-Token": alice.json()["csrf_token"]})
        owner = client.post("/api/auth/login", json={"username": "owner",
                                                   "password": "OwnerPassphrase-2026!"})
        headers = {"X-CSRF-Token": owner.json()["csrf_token"]}
        client.post("/api/auth/step-up", json={"password": "OwnerPassphrase-2026!"}, headers=headers)
        closed = []
        async def close_data(device_id):
            closed.append(device_id)
        monkeypatch.setattr(app.state.control_connections, "close_data", close_data)
        assert client.post(f"/api/admin/devices/device-1/users/{user_id}/revoke",
                           headers=headers).status_code == 204
        assert closed == ["device-1"]
        client.post("/api/auth/logout", headers=headers)
        client.post("/api/auth/login", json={"username": "alice",
                                               "password": "AlicePassphrase-2026!"})
        assert client.get("/api/devices").json() == {"devices": []}
        assert client.get("/api/devices/device-1/access").status_code == 403
        assert client.get(f"{remote_url}/api/remote/session").status_code == 403


def test_whole_device_session_can_switch_only_to_its_assigned_devices(tmp_path, monkeypatch):
    from gateway.models import Device, UserDevice
    app = create_app(GatewaySettings(data_dir=tmp_path, public_origin='https://gateway.test'))
    with TestClient(app, base_url='https://gateway.test') as client:
        setup = client.post('/api/platform/setup', json={'username':'owner','display_name':'Owner','password':'OwnerPassphrase-2026!','recovery_username':'recovery','recovery_password':'RecoveryPassphrase-2026!','registration_mode':'open'}).json()
        user_id = client.post('/api/auth/register', json={
            'username': 'alice', 'display_name': 'Alice', 'password': 'AlicePassphrase-2026!',
        }).json()['user']['id']
        async def seed():
            async with app.state.database.session() as session:
                async with session.begin():
                    session.add_all([Device(id=id, name=id, public_key='test', status='active', app_instance_id=id, version='1') for id in ('one','two','private')])
                    session.add_all([UserDevice(id=id, user_id=user_id, device_id=id, access_level='edit') for id in ('one','two')])
        client.portal.call(seed)
        monkeypatch.setattr(app.state.control_connections,'is_online',lambda id:True)
        first = client.get('/api/devices/one/access').json()
        host = 'https://d-one.gateway.test'
        assert client.post(host+'/api/remote/redeem',data={'ticket':first['ticket']},follow_redirects=False).status_code == 303
        listing = client.get(host+'/api/remote/devices')
        assert listing.status_code == 200, listing.text
        assert {d['id'] for d in listing.json()['devices']} == {'one','two'}
        second = client.get(host+'/api/remote/devices/two/access')
        assert second.status_code == 200, second.text
        assert second.json()['url'] == 'https://gateway.test/workspace/two/'
        app.state.settings.public_origin = 'http://192.168.52.156:8700'
        assert client.get('/api/devices/two/access').json()['url'] == 'http://192.168.52.156:8700/workspace/two/'
        app.state.settings.public_origin = 'https://gateway.test'
        assert client.get(host+'/api/remote/devices/private/access').status_code == 403
        monkeypatch.setattr(app.state.control_connections,'is_online',lambda id:id!='two')
        assert client.get(host+'/api/remote/devices/two/access').status_code == 409
        assert client.get('https://d-two.gateway.test/api/remote/devices').status_code in (401,403)
        async def revoke():
            from sqlalchemy import update
            from gateway.services.identity import _now
            async with app.state.database.session() as session:
                async with session.begin():
                    await session.execute(update(UserDevice).where(UserDevice.device_id=='one').values(revoked_at=_now()))
        client.portal.call(revoke)
        assert client.get(host+'/api/remote/devices').status_code == 403


def test_lan_path_workspace_scopes_cookie_http_and_switching(tmp_path, monkeypatch):
    from gateway.models import Device, UserDevice
    app = create_app(GatewaySettings(data_dir=tmp_path, public_origin='http://192.168.52.156:8700'))
    with TestClient(app, base_url='http://192.168.52.156:8700') as client:
        setup = client.post('/api/platform/setup', json={'username':'owner','display_name':'Owner','password':'OwnerPassphrase-2026!','recovery_username':'recovery','recovery_password':'RecoveryPassphrase-2026!','registration_mode':'open'}).json()
        async def seed():
            async with app.state.database.session() as session:
                async with session.begin():
                    session.add_all([Device(id=id,name=id,public_key='test',status='active',app_instance_id=id,version='1') for id in ('one','two')])
                    session.add_all([UserDevice(id=id,user_id=setup['user']['id'],device_id=id,access_level='edit') for id in ('one','two')])
        client.portal.call(seed)
        monkeypatch.setattr(app.state.control_connections,'is_online',lambda id:True)
        access=client.get('/api/devices/one/access').json()
        assert access['url']=='http://192.168.52.156:8700/workspace/one/'
        redeemed=client.post('/workspace/one/api/remote/redeem',data={'ticket':access['ticket']},follow_redirects=False)
        assert redeemed.status_code==303,redeemed.text
        assert redeemed.headers['location']=='/workspace/one/'
        assert 'Path=/workspace/one/' in redeemed.headers['set-cookie']
        assert client.get('/workspace/one/api/remote/session').json()['device_id']=='one'
        assert client.get('/workspace/two/api/remote/session').status_code in (401,403)
        assert client.get('/api/auth/session').json()['user']['id']==setup['user']['id']
        class Data:
            async def proxy_http(self,call,**kwargs):
                return JSONResponse({'path':call.target.path,'device_path':call.workspace_path})
            async def proxy_websocket(self,call,**kwargs):
                await call.port.accept()
                await call.port.send_json({'path':call.target.path,'device_path':call.workspace_path})
                await call.port.close()
        async def data(id):return Data()
        monkeypatch.setattr(app.state.control_connections,'request_data',data)
        assert client.get('/workspace/one/api/project/list').json()=={'path':'/api/project/list','device_path':'/workspace/one/'}
        assert client.get('/workspace/one/api/remote/devices/two/access').json()['url'].endswith('/workspace/two/')
        with client.websocket_connect('ws://192.168.52.156:8700/ws/workspace/one') as socket:
            assert socket.receive_json()=={'path':'/ws','device_path':'/workspace/one/'}
        import pytest
        from starlette.websockets import WebSocketDisconnect
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect('ws://192.168.52.156:8700/ws/workspace/two'):
                pass
        with client.websocket_connect('ws://192.168.52.156:8700/workspace/one/ws') as socket:
            assert socket.receive_json()=={'path':'/ws','device_path':'/workspace/one/'}


def test_group_device_grant_is_inherited_and_revocation_blocks_existing_session(tmp_path, monkeypatch):
    from gateway.models import Device, User, GroupMembership
    app = create_app(GatewaySettings(data_dir=tmp_path, public_origin='https://gateway.test'))
    with TestClient(app, base_url='https://gateway.test') as client:
        setup = client.post('/api/platform/setup', json={'username':'owner','display_name':'Owner','password':'OwnerPassphrase-2026!','recovery_username':'recovery','recovery_password':'RecoveryPassphrase-2026!','registration_mode':'open'}).json()
        headers = {'X-CSRF-Token':setup['csrf_token']}
        client.post('/api/auth/step-up',headers=headers,json={'password':'OwnerPassphrase-2026!'})
        user = client.post('/api/admin/users', headers=headers,json={'username':'worker','display_name':'Worker','password':'WorkerPassphrase-2026!','status':'active'}).json()['id']
        group = client.post('/api/groups',headers=headers,json={'name':'研发','slug':'dev'}).json()['id']
        client.post(f'/api/groups/{group}/members/bulk',headers=headers,json={'user_ids':[user],'action':'add'})
        async def seed():
            async with app.state.database.session() as session:
                async with session.begin():
                        session.add(Device(id='one',name='One',public_key='test',status='active'))
                        (await session.get(User,user)).must_change_password = False
        client.portal.call(seed)
        url='/api/admin/devices/one/grants'
        body={'subject_type':'group','subject_id':group,'access_level':'edit'}
        assert client.post(url,json=body).status_code==403
        client.post('/api/auth/step-up',headers=headers,json={'password':'OwnerPassphrase-2026!'})
        assert client.post(url,headers=headers,json=body).status_code==200
        assert client.get(url).json()['grants'][0]['subject_name']=='研发'
        admin_cookies=dict(client.cookies)
        client.cookies.clear()
        client.post('/api/auth/login',json={'username':'worker','password':'WorkerPassphrase-2026!'})
        assert [d['id'] for d in client.get('/api/devices').json()['devices']]==['one']
        monkeypatch.setattr(app.state.control_connections,'is_online',lambda id:True)
        access=client.get('/api/devices/one/access').json()
        assert client.post('/workspace/one/api/remote/redeem',data={'ticket':access['ticket']},follow_redirects=False).status_code==303
        assert client.get('/workspace/one/api/remote/session').json()['username']=='Worker'
        worker_cookies=dict(client.cookies)
        async def membership(revoked):
            from sqlalchemy import select
            from gateway.services.identity import _now
            async with app.state.database.session() as session:
                async with session.begin():
                    row = await session.scalar(select(GroupMembership).where(GroupMembership.group_id == group, GroupMembership.user_id == user))
                    row.revoked_at = _now() if revoked else None
        client.portal.call(membership, True)
        assert client.get('/api/devices').json()['devices'] == []
        assert client.get('/workspace/one/api/remote/session').status_code == 403
        client.portal.call(membership, False)
        assert client.get('/workspace/one/api/remote/session').status_code == 200
        client.cookies.clear();client.cookies.update(admin_cookies)
        assert client.delete(url+'/group/'+group,headers=headers).status_code==204
        client.cookies.clear();client.cookies.update(worker_cookies)
        assert client.get('/api/devices').json()['devices']==[]
        assert client.get('/workspace/one/api/remote/session').status_code==403


def test_device_grant_write_lock_keeps_health_responsive(tmp_path):
    import asyncio
    import sqlite3
    import threading
    from httpx import AsyncClient, ASGITransport
    from sqlalchemy import event

    from test_external_identity import _setup
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url='https://gateway.test') as client:
        csrf = _setup(client)
        assert client.post('/api/auth/step-up', headers={'X-CSRF-Token':csrf}, json={'password':'OwnerPassphrase-2026!'}).status_code == 200
        from gateway.models import Device
        async def seed():
            async with app.state.database.session() as session:
                async with session.begin():
                    session.add(Device(id='one', name='One', public_key='test', status='active'))
        client.portal.call(seed)
        user = client.get('/api/auth/session').json()['user']['id']
        reached_write = threading.Event()
        engine = app.state.database.engine.sync_engine
        def before_execute(_connection, _cursor, statement, _parameters, _context, _many):
            if statement.startswith(('INSERT', 'UPDATE')):
                reached_write.set()
        event.listen(engine, 'before_cursor_execute', before_execute)
        async def scenario():
            async with AsyncClient(transport=ASGITransport(app=app), base_url='https://gateway.test', cookies=client.cookies) as actor:
                pending = asyncio.create_task(actor.post('/api/admin/devices/one/grants', headers={'X-CSRF-Token': csrf}, json={'subject_type':'user','subject_id':user,'access_level':'edit'}))
                try:
                    assert await asyncio.to_thread(reached_write.wait, 2)
                    assert (await asyncio.wait_for(actor.get('/api/health'), .5)).status_code == 200
                    assert not pending.done()
                finally:
                    await asyncio.to_thread(lock.rollback)
                assert (await pending).status_code == 200
        try:
            with sqlite3.connect(tmp_path/'workstep_platform.db', check_same_thread=False) as lock:
                lock.execute('BEGIN IMMEDIATE')
                client.portal.call(scenario)
        finally:
            event.remove(engine, 'before_cursor_execute', before_execute)


def test_legacy_password_change_flag_does_not_block_authorized_access(tmp_path, monkeypatch):
    from gateway.models import AdminAssignment, Device, User
    app = create_app(GatewaySettings(data_dir=tmp_path, public_origin='https://gateway.test'))
    with TestClient(app, base_url='https://gateway.test') as client:
        setup = client.post('/api/platform/setup', json={
            'username': 'owner', 'display_name': 'Owner', 'password': 'OwnerPassphrase-2026!',
            'recovery_username': 'recovery', 'recovery_password': 'RecoveryPassphrase-2026!',
            'registration_mode': 'open',
        }).json()
        user_id = client.post('/api/auth/register', json={
            'username': 'alice', 'display_name': 'Alice', 'password': 'AlicePassphrase-2026!',
        }).json()['user']['id']
        async def seed():
            async with app.state.database.session() as session:
                async with session.begin():
                    (await session.get(User, user_id)).must_change_password = 1
                    session.add(AdminAssignment(id='legacy-identity-admin', user_id=user_id,
                                                role='identity_admin', scope_type='platform'))
                    session.add(Device(id='owned', name='Owned PC', public_key='test', status='active', owner_user_id=user_id))
                    session.add(Device(id='private', name='Private PC', public_key='test', status='active'))
        client.portal.call(seed)
        monkeypatch.setattr(app.state.control_connections, 'is_online', lambda _: True)
        assert client.get('/api/auth/session').json()['user']['must_change_password'] is False
        listing = client.get('/api/devices')
        assert listing.status_code == 200, listing.text
        assert [device['id'] for device in listing.json()['devices']] == ['owned']
        assert client.get('/api/projects').status_code == 200
        assert client.get('/api/admin/users').status_code == 200
        access = client.get('/api/devices/owned/access')
        assert access.status_code == 200, access.text
        assert client.post('/workspace/owned/api/remote/redeem', data={'ticket':access.json()['ticket']}, follow_redirects=False).status_code == 303
        assert client.get('/workspace/owned/api/remote/session').status_code == 200
        assert client.get('/api/devices/private/access').status_code == 403


def test_unauthorized_workspace_documents_return_to_portal_but_api_keeps_json(tmp_path, monkeypatch):
    from gateway.services.errors import GatewayError
    import importlib
    app_module = importlib.import_module('gateway.app')
    app = create_app(GatewaySettings(data_dir=tmp_path, public_origin='https://gateway.test'))
    with TestClient(app, base_url='https://gateway.test') as client:
        root = '/workspace/device-1/'
        response = client.get(root, follow_redirects=False)
        assert response.status_code == 303
        assert response.headers['location'] == '/'
        assert client.get(root + 'api/projects').status_code == 401
        async def revoked(call):
            raise GatewayError('forbidden', 'Device access denied')
        monkeypatch.setattr(app_module, 'proxy_remote_request', revoked)
        for path in [root, root + 'tasks?project=test', root + 'chat']:
            response = client.get(path, headers={'Accept':'text/html'}, follow_redirects=False)
            assert response.status_code == 303
            assert response.headers['location'] == '/'
        denied = client.get(root + 'api/projects', headers={'Accept':'text/html'}, follow_redirects=False)
        assert denied.status_code == 403
        assert denied.json()['error']['message'] == 'Device access denied'
        assert client.get(root + 'assets/index.js', follow_redirects=False).status_code == 403
        assert client.post(root, follow_redirects=False).status_code == 403
