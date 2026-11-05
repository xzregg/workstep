from fastapi.testclient import TestClient
from gateway.app import create_app
from gateway.config import GatewaySettings
from test_external_identity import _setup


def test_source_enabled_changes_only_status_and_preserves_last_login(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url='https://gateway.test') as client:
        headers = {'X-CSRF-Token': _setup(client)}
        body = dict(provider='dingtalk', tenant_id='tenant', client_id='app', client_secret='test-secret', login_enabled=True, sync_enabled=False)
        source = client.post('/api/admin/identity-sources', headers=headers, json=body).json()['id']
        url = f'/api/admin/identity-sources/{source}/enabled'
        assert client.put(url, json={'enabled':False}).status_code == 403
        response = client.put(url, headers=headers, json={'enabled':False})
        assert response.status_code == 200, response.text
        assert response.json() == {'id':source, 'enabled':False}
        saved = client.get('/api/admin/identity-sources').json()['sources'][0]
        assert saved['enabled'] is False
        assert saved['login_enabled'] is True and saved['sync_enabled'] is False and saved['secret_configured'] is True
        assert client.get('/api/auth/identity-sources').json()['sources'] == []
        assert client.put(url, headers=headers, json={'enabled':True}).status_code == 200
        assert client.get('/api/auth/identity-sources').json()['sources'] == [{'id':source,'provider':'dingtalk'}]
        client.post('/api/auth/step-up', headers=headers, json={'password':'OwnerPassphrase-2026!'})
        assert client.put('/api/admin/login-policy', headers=headers, json={'password_login_enabled':False}).status_code == 200
        assert client.put(url, headers=headers, json={'enabled':False}).status_code == 409
        assert client.get('/api/admin/identity-sources').json()['sources'][0]['enabled'] is True
        assert client.put('/api/admin/identity-sources/missing/enabled', headers=headers, json={'enabled':True}).status_code == 404
    with TestClient(create_app(GatewaySettings(data_dir=tmp_path)), base_url='https://gateway.test') as client:
        assert client.get('/api/auth/identity-sources').json()['sources'] == [{'id':source,'provider':'dingtalk'}]
        client.cookies.clear()
        assert client.put(url, headers=headers, json={'enabled':False}).status_code == 401


def test_source_switch_lock_keeps_health_responsive(tmp_path):
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
        source = client.post('/api/admin/identity-sources', headers={'X-CSRF-Token':csrf}, json={'provider':'dingtalk', 'tenant_id':'tenant', 'client_id':'app', 'client_secret':'test-secret'}).json()['id']
        reached_write = threading.Event()
        engine = app.state.database.engine.sync_engine
        def before_execute(_connection, _cursor, statement, _parameters, _context, _many):
            if statement.startswith(('INSERT', 'UPDATE')):
                reached_write.set()
        event.listen(engine, 'before_cursor_execute', before_execute)
        async def scenario():
            async with AsyncClient(transport=ASGITransport(app=app), base_url='https://gateway.test', cookies=client.cookies) as actor:
                pending = asyncio.create_task(actor.put(f'/api/admin/identity-sources/{source}/enabled', headers={'X-CSRF-Token': csrf}, json={'enabled':False}))
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



def test_regular_user_cannot_switch_application(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url='https://gateway.test') as client:
        headers = {'X-CSRF-Token':_setup(client)}
        client.post('/api/auth/step-up', headers=headers, json={'password':'OwnerPassphrase-2026!'})
        client.put('/api/admin/registration-policy', headers=headers, json={'mode':'open'})
        client.post('/api/auth/register', json={'username':'alice','display_name':'Alice','password':'AlicePassphrase-2026!'})
        token = client.get('/api/auth/session').json()['csrf_token']
        assert client.put('/api/admin/identity-sources/source/enabled', headers={'X-CSRF-Token':token}, json={'enabled':False}).status_code == 403
