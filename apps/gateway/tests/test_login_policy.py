from fastapi.testclient import TestClient
from gateway.app import create_app
from gateway.config import GatewaySettings


def test_password_login_switch_and_private_scan_directory(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url='https://gateway.test') as client:
        setup = client.post('/api/platform/setup', json={
            'username': 'owner', 'display_name': 'Owner', 'password': 'OwnerPassword123',
            'recovery_username': 'recovery', 'recovery_password': 'RecoveryPassword123', 'registration_mode': 'open',
        }).json()
        headers = {'X-CSRF-Token': setup['csrf_token']}
        url = '/api/admin/login-policy'
        body = {'password_login_enabled': False}
        assert client.put(url, json=body, headers=headers).status_code == 403
        client.post('/api/auth/step-up', json={'password': 'OwnerPassword123'}, headers=headers)
        assert client.put(url, json=body, headers=headers).status_code == 409
        source = client.post('/api/admin/identity-sources', headers=headers, json={
            'provider': 'dingtalk', 'tenant_id': 'private-corp-123', 'client_id': 'private-client', 'client_secret': 'secret',
        }).json()['id']
        public = client.get('/api/auth/identity-sources').json()
        assert public == {'sources': [{'id': source, 'provider': 'dingtalk'}]}
        assert client.put(url, json=body).status_code == 403
        assert client.put(url, json=body, headers=headers).status_code == 200
        assert client.get('/api/auth/registration-policy').json() == {'mode': 'closed', 'password_login_enabled': False}
        assert client.get('/api/admin/platform-settings').json()['password_login_enabled'] is False
        # Password closure must not leave an alternate local registration route.
        assert client.post('/api/auth/register', json={'username': 'alice', 'display_name': 'Alice', 'password': 'UserPassword123'}).status_code == 403
        assert client.post('/api/auth/login', json={'username': 'owner', 'password': 'OwnerPassword123'}).status_code == 403
        assert client.post('/api/auth/login', json={'username': 'recovery', 'password': 'RecoveryPassword123'}).status_code == 403
        assert client.get('/api/auth/identity-sources').json() == public
        assert client.put(f'/api/admin/identity-sources/{source}', headers=headers, json={
            'provider': 'dingtalk', 'tenant_id': 'private-corp-123', 'client_id': 'private-client',
            'login_enabled': False,
        }).status_code == 409
        assert client.post(f'/api/admin/identity-sources/{source}/disable', headers=headers).status_code == 409
        # Existing authenticated administrator can restore password sign-in.
        assert client.put(url, json={'password_login_enabled': True}, headers=headers).status_code == 200
        assert client.get('/api/auth/registration-policy').json() == {'mode': 'open', 'password_login_enabled': True}
        client.cookies.clear()
        assert client.post('/api/auth/login', json={'username': 'owner', 'password': 'OwnerPassword123'}).status_code == 200


def test_login_policy_write_lock_keeps_health_responsive_and_survives_restart(tmp_path):
    import asyncio
    import sqlite3
    import threading
    from httpx import ASGITransport, AsyncClient
    from sqlalchemy import event
    settings=GatewaySettings(data_dir=tmp_path)
    app=create_app(settings)
    with TestClient(app,base_url='https://gateway.test') as client:
        csrf=client.post('/api/platform/setup',json={
            'username':'owner','display_name':'Owner','password':'OwnerPassword123',
            'recovery_username':'recovery','recovery_password':'RecoveryPassword123','registration_mode':'open',
        }).json()['csrf_token']
        headers={'X-CSRF-Token':csrf}
        client.post('/api/auth/step-up',json={'password':'OwnerPassword123'},headers=headers)
        client.post('/api/admin/identity-sources',headers=headers,json={
            'provider':'dingtalk','tenant_id':'private-corp','client_id':'app','client_secret':'secret',
        })
        reached=threading.Event()
        def before_execute(connection,cursor,statement,parameters,context,many):
            if statement.startswith('UPDATE platform_settings'):reached.set()
        engine=app.state.database.engine.sync_engine
        event.listen(engine,'before_cursor_execute',before_execute)
        async def scenario():
            async with AsyncClient(transport=ASGITransport(app=app),base_url='https://gateway.test',cookies=client.cookies) as actor:
                pending=asyncio.create_task(actor.put('/api/admin/login-policy',headers=headers,json={'password_login_enabled':False}))
                try:
                    assert await asyncio.to_thread(reached.wait,2)
                    assert (await asyncio.wait_for(actor.get('/api/health'),.5)).status_code==200
                    assert not pending.done()
                finally:await asyncio.to_thread(lock.rollback)
                assert (await pending).status_code==200
        try:
            with sqlite3.connect(tmp_path/'workstep_platform.db',check_same_thread=False) as lock:
                lock.execute('BEGIN IMMEDIATE')
                client.portal.call(scenario)
        finally:event.remove(engine,'before_cursor_execute',before_execute)
    with TestClient(create_app(settings),base_url='https://gateway.test') as client:
        assert client.get('/api/auth/registration-policy').json()['password_login_enabled'] is False
        assert client.post('/api/auth/login',json={'username':'owner','password':'OwnerPassword123'}).status_code==403
