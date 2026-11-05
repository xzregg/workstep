from fastapi.testclient import TestClient
from gateway.app import create_app
from gateway.config import GatewaySettings
from test_external_identity import _setup


def test_secret_reveal_is_explicit_admin_only_and_not_cached(tmp_path, monkeypatch):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url='https://gateway.test') as client:
        csrf = _setup(client)
        headers = {'X-CSRF-Token': csrf}
        for provider in ('dingtalk', 'wecom', 'feishu', 'lark'):
            body = dict(provider=provider, tenant_id='tenant', client_id='app', agent_id='1001', client_secret='test-private-secret')
            source_id = client.post('/api/admin/identity-sources', headers=headers, json=body).json()['id']
            url = f'/api/admin/identity-sources/{source_id}/secret/reveal'
            assert 'test-private-secret' not in client.get('/api/admin/identity-sources').text
            assert client.post(url).status_code == 403
            result = client.post(url, headers=headers)
            assert result.status_code == 200, result.text
            assert result.json() == {'client_secret': 'test-private-secret'}
            assert result.headers['cache-control'] == 'no-store'
        assert client.post('/api/admin/identity-sources/missing/secret/reveal', headers=headers).status_code == 404
        # Environment-based deployments use the same credential resolver.
        monkeypatch.setenv('WORKSTEP_TEST_APP_SECRET', 'environment-secret')
        source_id = client.post('/api/admin/identity-sources', headers=headers, json=dict(provider='dingtalk', tenant_id='environment', client_id='app', secret_env='WORKSTEP_TEST_APP_SECRET')).json()['id']
        url = f'/api/admin/identity-sources/{source_id}/secret/reveal'
        assert client.post(url, headers=headers).json()['client_secret'] == 'environment-secret'
        monkeypatch.delenv('WORKSTEP_TEST_APP_SECRET')
        assert client.post(url, headers=headers).status_code == 409
        async def audit():
            from sqlalchemy import select
            from gateway.models import AuditEvent
            async with app.state.database.session() as session:
                rows = (await session.scalars(select(AuditEvent).where(AuditEvent.action == 'admin.identity_source_secret_revealed'))).all()
                assert len(rows) == 5
                assert all('secret' not in row.metadata_json for row in rows)
        client.portal.call(audit)
        client.post('/api/auth/step-up', headers=headers, json={'password':'OwnerPassphrase-2026!'})
        client.put('/api/admin/registration-policy', headers=headers, json={'mode':'open'})
        client.cookies.clear()
        assert client.post(url, headers=headers).status_code == 401
        assert client.post('/api/auth/register', json=dict(username='alice', display_name='Alice', password='AlicePassphrase-2026!')).status_code == 201
        token = client.get('/api/auth/session').json()['csrf_token']
        assert client.post(url, headers={'X-CSRF-Token': token}).status_code == 403


def test_secret_reveal_audit_lock_keeps_health_responsive(tmp_path):
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
                pending = asyncio.create_task(actor.post(f'/api/admin/identity-sources/{source}/secret/reveal', headers={'X-CSRF-Token': csrf}))
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
