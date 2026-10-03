import json
from fastapi.testclient import TestClient
from gateway.app import create_app
from gateway.config import GatewaySettings
from test_external_identity import _setup


def test_application_configuration_encrypts_secret_and_controls_scan_login(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url="https://gateway.test") as client:
        assert client.get('/api/admin/user-groups/tree').status_code == 401
        csrf = _setup(client); headers={"X-CSRF-Token":csrf}
        body={"provider":"wecom","tenant_id":"corp-a","client_id":"corp-a","agent_id":"10001", "client_secret":"private-application-key", "login_enabled":False,"sync_enabled":True}
        created=client.post('/api/admin/identity-sources',headers=headers,json=body)
        assert created.status_code==201,created.text
        source_id=created.json()['id']
        listing=client.get('/api/admin/identity-sources').json()['sources'][0]
        assert listing['secret_configured'] and not listing['login_enabled']
        assert 'private-application-key' not in json.dumps(listing)
        assert client.get('/api/auth/identity-sources').json()['sources']==[]
        assert client.post(f'/api/auth/external/{source_id}/start').status_code==403
        changed=client.put(f'/api/admin/identity-sources/{source_id}',headers=headers,json={**body,'client_secret':None,'login_enabled':True})
        assert changed.status_code==200,changed.text
        assert client.get('/api/auth/identity-sources').json()['sources'][0]['id']==source_id
        assert client.put(f'/api/admin/identity-sources/{source_id}',json=body).status_code==403
    assert b'private-application-key' not in (tmp_path/'workstep_platform.db').read_bytes()


def test_directory_sync_creates_group_tree_and_filters_user_table(tmp_path):
    app=create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app,base_url='https://gateway.test') as client:
        csrf=_setup(client);headers={'X-CSRF-Token':csrf}
        source=client.post('/api/admin/identity-sources',headers=headers,json={'provider':'dingtalk','tenant_id':'corp','client_id':'app','secret_env':'TEST_APP_SECRET'}).json()['id']
        snapshot={'departments':[{'external_id':'root','display_name':'公司'},{'external_id':'child','display_name':'研发','parent_external_id':'root'}], 'people':[{'subject':'u1','display_name':'小王','department_ids':['child']}]}
        for _ in range(2): assert client.post(f'/api/admin/identity-sources/{source}/sync',headers=headers,json=snapshot).status_code==200
        tree=client.get('/api/admin/user-groups/tree');assert tree.status_code==200,tree.text
        groups=tree.json()['groups'];assert len(groups)==2
        child=next(g for g in groups if g['name']=='研发');root=next(g for g in groups if g['name']=='公司')
        assert child['parent_id']==root['id'] and child['member_count']==1
        users=client.get('/api/admin/users',params={'group_id':child['id']}).json()
        assert users['total']==1 and users['users'][0]['display_name']=='小王'
        assert client.get('/api/admin/users',params={'group_id':root['id']}).json()['total']==0
        snapshot['people'][0]['display_name']='小王更新'
        assert client.post(f'/api/admin/identity-sources/{source}/sync',headers=headers,json=snapshot).status_code==200
        assert client.get('/api/admin/users',params={'group_id':child['id']}).json()['users'][0]['display_name']=='小王更新'
        snapshot['people']=[]
        assert client.post(f'/api/admin/identity-sources/{source}/sync',headers=headers,json=snapshot).status_code==200
        assert client.get('/api/admin/users',params={'group_id':child['id']}).json()['total']==0


def test_disabled_application_and_sync_switch_prevent_provider_requests(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    class Connector:
        calls = 0
        async def fetch_directory(self, source):
            self.calls += 1
            return {'departments': [], 'people': []}
    connector = Connector()
    app.state.identity_connectors = {'dingtalk': connector}
    with TestClient(app, base_url='https://gateway.test') as client:
        csrf = _setup(client); headers = {'X-CSRF-Token': csrf}
        body = {'provider': 'dingtalk', 'tenant_id': 'corp', 'client_id': 'app', 'client_secret': 'test-secret', 'enabled': False}
        source = client.post('/api/admin/identity-sources', headers=headers, json=body).json()['id']
        assert client.get('/api/admin/identity-sources').json()['sources'][0]['enabled'] is False
        assert client.post(f'/api/admin/identity-sources/{source}/reconcile', headers=headers).status_code == 403
        assert connector.calls == 0
        assert client.put(f'/api/admin/identity-sources/{source}', headers=headers, json={**body, 'client_secret': None, 'enabled': True, 'sync_enabled': False}).status_code == 200
        assert client.post(f'/api/admin/identity-sources/{source}/reconcile', headers=headers).status_code == 403
        from gateway.services.reconciliation import DirectoryReconciler
        client.portal.call(DirectoryReconciler(app.state.database, app.state.identity_connectors).run_once)
        assert connector.calls == 0
        assert client.post(f'/api/admin/identity-sources/{source}/events', headers=headers, json={'event_id': 'disabled-sync-event', 'kind': 'person_delete', 'subject': 'employee'}).status_code == 403


def test_application_update_waiting_for_database_lock_keeps_health_responsive(tmp_path):
    import asyncio
    import sqlite3
    import threading
    from httpx import AsyncClient, ASGITransport
    from sqlalchemy import event

    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url='https://gateway.test') as client:
        csrf = _setup(client)
        body = {'provider': 'dingtalk', 'tenant_id': 'corp', 'client_id': 'app', 'client_secret': 'test-secret'}
        source = client.post('/api/admin/identity-sources', headers={'X-CSRF-Token': csrf}, json=body).json()['id']
        reached_write = threading.Event()
        engine = app.state.database.engine.sync_engine
        def before_execute(_connection, _cursor, statement, _parameters, _context, _many):
            if statement.startswith('UPDATE identity_sources'):
                reached_write.set()
        event.listen(engine, 'before_cursor_execute', before_execute)
        async def scenario():
            async with AsyncClient(transport=ASGITransport(app=app), base_url='https://gateway.test', cookies=client.cookies) as actor:
                pending = asyncio.create_task(actor.put(f'/api/admin/identity-sources/{source}', headers={'X-CSRF-Token': csrf}, json={**body, 'client_id': 'updated'}))
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
