import asyncio
import time

from fastapi.testclient import TestClient
from gateway.app import create_app
from gateway.config import GatewaySettings
from test_external_identity import _setup


class Connector:
    started = None
    release = None

    async def fetch_directory(self, source, *, selected_department_ids=None, progress=None, departments_only=False):
        departments = [
            {'external_id': '1', 'display_name': '公司', 'parent_external_id': None},
            {'external_id': '2', 'display_name': '研发', 'parent_external_id': '1'},
            {'external_id': '3', 'display_name': '销售', 'parent_external_id': '1'},
        ]
        if departments_only:
            return {'departments': departments, 'people': []}
        assert selected_department_ids == ['2']
        if progress:
            await progress('fetching', 0, 1, '研发')
        await asyncio.sleep(.2)
        if progress:
            await progress('fetching', 1, 1, '研发')
        return {'departments': [{'external_id': '2', 'display_name': '研发', 'parent_external_id': None}],
                'people': [{'subject': 'dev', 'display_name': '研发用户', 'department_ids': ['2']}]}


def test_selected_job_reports_progress_and_preserves_other_organizations(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    app.state.identity_connectors = {'dingtalk': Connector()}
    with TestClient(app, base_url='https://gateway.test') as client:
        csrf = _setup(client); headers = {'X-CSRF-Token': csrf}
        source = client.post('/api/admin/identity-sources', headers=headers, json={
            'provider': 'dingtalk', 'tenant_id': 'corp', 'client_id': 'app', 'client_secret': 'secret',
        }).json()['id']
        base = f'/api/admin/identity-sources/{source}'
        assert client.post(base + '/sync', headers=headers, json={
            'departments': [{'external_id': '3', 'display_name': '销售'}],
            'people': [{'subject': 'sales', 'display_name': '销售用户', 'department_ids': ['3']}],
        }).status_code == 200
        assert len(client.get(base + '/directory-preview').json()['departments']) == 3
        assert client.post(base + '/sync-jobs', headers=headers, json={'department_ids': []}).status_code == 422
        assert client.post(base + '/sync-jobs', json={'department_ids': ['2']}).status_code == 403
        response = client.post(base + '/sync-jobs', headers=headers, json={'department_ids': ['2']})
        assert response.status_code == 202, response.text
        assert client.post(base + '/sync-jobs', headers=headers, json={'department_ids': ['2']}).status_code == 409
        assert client.get('/api/health').status_code == 200
        for _ in range(100):
            job = client.get(base + '/sync-jobs/latest').json()
            if job['status'] in ('completed', 'failed'):
                break
            time.sleep(.02)
        assert job['status'] == 'completed', job
        assert job['completed'] == job['total'] == 1
        groups = client.get('/api/admin/user-groups/tree').json()['groups']
        assert {group['name'] for group in groups} == {'研发', '销售'}
        assert {user['display_name'] for user in client.get('/api/admin/users').json()['users']} >= {'研发用户', '销售用户'}


def test_selected_sync_job_database_lock_does_not_block_health(tmp_path):
    import sqlite3
    import threading
    from httpx import ASGITransport, AsyncClient
    from sqlalchemy import event
    app = create_app(GatewaySettings(data_dir=tmp_path))
    app.state.identity_connectors = {'dingtalk': Connector()}
    with TestClient(app, base_url='https://gateway.test') as client:
        csrf = _setup(client); headers = {'X-CSRF-Token': csrf}
        source = client.post('/api/admin/identity-sources', headers=headers, json={
            'provider': 'dingtalk', 'tenant_id': 'corp', 'client_id': 'app', 'client_secret': 'secret',
        }).json()['id']
        reached = threading.Event()
        def before_execute(connection, cursor, statement, parameters, context, many):
            if statement.startswith('INSERT INTO platform_settings'): reached.set()
        engine = app.state.database.engine.sync_engine
        event.listen(engine, 'before_cursor_execute', before_execute)
        async def scenario():
            async with AsyncClient(transport=ASGITransport(app=app), base_url='https://gateway.test', cookies=client.cookies) as actor:
                pending = asyncio.create_task(actor.post(f'/api/admin/identity-sources/{source}/sync-jobs', headers=headers, json={'department_ids': ['2']}))
                try:
                    assert await asyncio.to_thread(reached.wait, 2)
                    assert (await asyncio.wait_for(actor.get('/api/health'), .5)).status_code == 200
                    assert not pending.done()
                finally:
                    await asyncio.to_thread(lock.rollback)
                assert (await pending).status_code == 202
        try:
            with sqlite3.connect(tmp_path / 'workstep_platform.db', check_same_thread=False) as lock:
                lock.execute('BEGIN IMMEDIATE')
                client.portal.call(scenario)
        finally:
            event.remove(engine, 'before_cursor_execute', before_execute)


def test_automatic_sync_waits_for_selection_and_restart_marks_unfinished_job_failed(tmp_path):
    from sqlalchemy import select
    from gateway.models import PlatformSetting
    import json
    app = create_app(GatewaySettings(data_dir=tmp_path))
    class UntouchedConnector:
        async def fetch_directory(self, source, **kwargs):
            raise AssertionError('unselected source must not request the provider')
    app.state.identity_connectors = {'dingtalk': UntouchedConnector()}
    with TestClient(app, base_url='https://gateway.test') as client:
        csrf = _setup(client)
        source = client.post('/api/admin/identity-sources', headers={'X-CSRF-Token': csrf}, json={
            'provider': 'dingtalk', 'tenant_id': 'corp', 'client_id': 'app', 'client_secret': 'secret',
        }).json()['id']
        assert client.post(f'/api/admin/identity-sources/{source}/reconcile', headers={'X-CSRF-Token': csrf}).status_code == 422
        client.portal.call(app.state.directory_reconciler.run_once)
        async def unfinished():
            async with app.state.database.session() as session:
                async with session.begin():
                    session.add(PlatformSetting(key='directory-job:' + source, value_json=json.dumps({'id': 'interrupted-job', 'status': 'fetching'})))
        client.portal.call(unfinished)
    restarted = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(restarted, base_url='https://gateway.test') as client:
        async def check():
            row = await restarted.state.directory_reconciler.jobs.latest(source)
            assert row['status'] == 'failed' and row['error_code'] == 'interrupted'
        client.portal.call(check)


def test_selected_sync_only_adds_and_reports_locally_deleted_records(tmp_path):
    import sqlite3
    app = create_app(GatewaySettings(data_dir=tmp_path))
    class NewConnector(Connector):
        async def fetch_directory(self, source, **kwargs):
            return {'departments':[{'external_id':'2','display_name':'改名'}], 'people':[
                {'subject':'old','display_name':'改名用户','department_ids':['2']},
                {'subject':'deleted','display_name':'删除用户','department_ids':['2']},
                {'subject':'new','display_name':'新增用户','department_ids':['2']} ]}
    app.state.identity_connectors = {'dingtalk':NewConnector()}
    with TestClient(app, base_url='https://gateway.test') as client:
        csrf = _setup(client); headers = {'X-CSRF-Token':csrf}
        source = client.post('/api/admin/identity-sources',headers=headers,json={'provider':'dingtalk','tenant_id':'corp','client_id':'app','client_secret':'secret'}).json()['id']
        base = f'/api/admin/identity-sources/{source}'
        client.post(base+'/sync',headers=headers,json={'departments':[{'external_id':'2','display_name':'原部门'}],'people':[
            {'subject':'old','display_name':'原用户','department_ids':['2']},
            {'subject':'deleted','display_name':'删除用户','department_ids':['2']},
            {'subject':'missing','display_name':'本地保留','department_ids':['2']}]})
        with sqlite3.connect(tmp_path/'workstep_platform.db') as db:
            db.execute("update users set status='deleted' where id in (select user_id from directory_people where subject='deleted')")
            db.execute("update user_groups set status='deleted'")
        client.post(base+'/sync-jobs',headers=headers,json={'department_ids':['2']})
        for _ in range(100):
            job = client.get(base+'/sync-jobs/latest').json()
            if job['status'] in ('completed','failed'): break
            time.sleep(.02)
        assert job['status']=='completed',job
        assert job['result']['people_added']==1
        assert job['result']['people_deleted_skipped']==1
        assert job['result']['departments_deleted_skipped']==1
        with sqlite3.connect(tmp_path/'workstep_platform.db') as db:
            assert db.execute("select display_name,active from directory_people where subject='old'").fetchone()==('原用户',1)
            assert db.execute("select active from directory_people where subject='missing'").fetchone()==(1,)
            assert db.execute("select status from user_groups").fetchone()==('deleted',)

        client.post('/api/auth/step-up',headers=headers,json={'password':'OwnerPassphrase-2026!'})
        with sqlite3.connect(tmp_path/'workstep_platform.db') as db:
            deleted_id=db.execute("select user_id from directory_people where subject='deleted'").fetchone()[0]
        purged=client.post('/api/admin/users/bulk',headers=headers,json={'user_ids':[deleted_id],'action':'purge'})
        assert purged.status_code==200,purged.text
        client.post(base+'/sync-jobs',headers=headers,json={'department_ids':['2']})
        for _ in range(100):
            job=client.get(base+'/sync-jobs/latest').json()
            if job['status'] in ('completed','failed'): break
            time.sleep(.02)
        assert job['status']=='completed',job
        assert job['result']['people_deleted_skipped']==1
        assert job['result']['people_added']==0
        with sqlite3.connect(tmp_path/'workstep_platform.db') as db:
            assert db.execute("select count(*) from directory_people where subject='deleted'").fetchone()[0]==0
