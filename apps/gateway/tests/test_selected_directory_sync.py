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


def test_selected_sync_updates_and_reports_locally_deleted_records(tmp_path):
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
        assert job['result']['departments_deleted_skipped']==0
        with sqlite3.connect(tmp_path/'workstep_platform.db') as db:
            assert db.execute("select display_name,active from directory_people where subject='old'").fetchone()==('改名用户',1)
            assert db.execute("select active from directory_people where subject='missing'").fetchone()==(1,)
            assert db.execute("select status from user_groups").fetchone()==('active',)

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

        async def preview():
            from gateway.services.external_identity import ExternalIdentityService
            return await ExternalIdentityService(app.state.database).full_sync(source,
                [{'external_id':'2','display_name':'研发'}],
                [{'subject':'deleted','display_name':'删除用户','department_ids':['2']},
                 {'subject':'never-imported','display_name':'新用户','department_ids':['2']}], dry_run=True)
        candidates = client.portal.call(preview)['user_candidates']
        purged_candidate = next(row for row in candidates if row['subject']=='deleted')
        assert purged_candidate['skipped'] is True
        assert purged_candidate['skip_reason'] == 'purged'
        assert next(row for row in candidates if row['subject']=='never-imported')['skipped'] is False

        # An explicit checked selection may restore both soft-deleted and purged users.
        with sqlite3.connect(tmp_path/'workstep_platform.db') as db:
            db.execute("update users set status='deleted' where id in (select user_id from directory_people where subject='old')")
        client.post(base+'/sync-jobs',headers=headers,json={'department_ids':['2'],'preview':True})
        for _ in range(100):
            preview_job=client.get(base+'/sync-jobs/latest').json()
            if preview_job['status'] in ('preview','failed'): break
            time.sleep(.02)
        assert preview_job['status']=='preview',preview_job
        assert next(row for row in preview_job['result']['user_candidates'] if row['subject']=='old')['skip_reason']=='deleted'
        confirmed=client.post(base+'/sync-jobs/confirm',headers=headers,json={'job_id':preview_job['id'],'selected_subjects':['old','deleted']})
        assert confirmed.status_code==202,confirmed.text
        for _ in range(100):
            restored=client.get(base+'/sync-jobs/latest').json()
            if restored['status'] in ('completed','failed'): break
            time.sleep(.02)
        assert restored['status']=='completed',restored
        assert restored['result']['people_restored']==2
        groups=client.get('/api/admin/user-groups/tree').json()['groups']
        assert any(row['name']=='改名' for row in groups)
        with sqlite3.connect(tmp_path/'workstep_platform.db') as db:
            assert db.execute("select count(*) from users where status='active' and id in (select user_id from directory_people where subject in ('old','deleted'))").fetchone()[0]==2
            assert db.execute("select count(*) from platform_settings where key like 'directory-purged:%'").fetchone()[0]==0


def test_preview_does_not_apply_until_confirmed_and_history_is_durable(tmp_path):
    import sqlite3
    app = create_app(GatewaySettings(data_dir=tmp_path))
    app.state.identity_connectors = {'dingtalk': Connector()}
    with TestClient(app, base_url='https://gateway.test') as client:
        csrf = _setup(client); headers = {'X-CSRF-Token': csrf}
        source = client.post('/api/admin/identity-sources', headers=headers, json={
            'provider': 'dingtalk', 'tenant_id': 'corp', 'client_id': 'app', 'client_secret': 'secret',
        }).json()['id']
        base = f'/api/admin/identity-sources/{source}'
        response = client.post(base + '/sync-jobs', headers=headers, json={'department_ids': ['2'], 'preview': True})
        for _ in range(100):
            job = client.get(base + '/sync-jobs/latest').json()
            if job['status'] in ('preview', 'failed'): break
            time.sleep(.02)
        assert job['status'] == 'preview', job
        assert 'snapshot' not in job
        with sqlite3.connect(tmp_path / 'workstep_platform.db') as db:
            assert db.execute('select count(*) from directory_people').fetchone()[0] == 0
        assert client.post(base + '/sync-jobs/confirm', json={'job_id': job['id']}).status_code == 403
        assert client.post(base + '/sync-jobs/confirm', headers=headers, json={'job_id': 'wrong'}).status_code == 409
        assert job['result']['user_candidates']
        assert client.post(base + '/sync-jobs/confirm', headers=headers, json={'job_id': job['id'], 'selected_subjects': ['forged']}).status_code == 422
        assert client.post(base + '/sync-jobs/confirm', headers=headers, json={'job_id': job['id'], 'selected_subjects': []}).status_code == 202
        for _ in range(100):
            final = client.get(base + '/sync-jobs/latest').json()
            if final['status'] in ('completed', 'failed'): break
            time.sleep(.02)
        assert final['status'] == 'completed', final
        with sqlite3.connect(tmp_path / 'workstep_platform.db') as db:
            assert db.execute('select count(*) from directory_people').fetchone()[0] == 0
            assert db.execute('select count(*) from directory_departments').fetchone()[0] == 1
        assert client.get(base + '/sync-history').json()['jobs'][0]['id'] == job['id']


def test_schedule_api_validation_and_directory_notices_are_scoped_and_acknowledged(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url='https://gateway.test') as client:
        csrf = _setup(client); headers = {'X-CSRF-Token':csrf}
        body={'provider':'dingtalk','tenant_id':'corp','client_id':'app','client_secret':'secret',
              'sync_schedule':{'frequency':'weekly','time':'09:30','timezone':'Asia/Shanghai','weekday':1}}
        assert client.post('/api/admin/identity-sources', headers=headers, json={**body,'sync_schedule':{'frequency':'daily','timezone':'invalid'}}).status_code == 422
        source = client.post('/api/admin/identity-sources', headers=headers, json=body).json()['id']
        listed = client.get('/api/admin/identity-sources').json()['sources'][0]
        assert listed['sync_schedule'] == body['sync_schedule']
        assert listed['next_sync_at']
        endpoint=f'/api/admin/identity-sources/{source}/sync'
        snapshot={'departments':[{'external_id':'2','display_name':'研发'}], 'people':[{'subject':'employee','display_name':'员工','department_ids':['2']}]}
        assert client.post(endpoint, headers=headers, json=snapshot).status_code == 200
        notices=client.get('/api/admin/directory-notices').json()['notices']
        assert len(notices)==1
        notice={'source_id':source,'at':notices[0]['at']}
        assert client.post('/api/admin/directory-notices/read',json=notice).status_code == 403
        assert client.post('/api/admin/directory-notices/read',headers=headers,json=notice).status_code == 200
        assert client.get('/api/admin/directory-notices').json()['notices']==[]
        # Unchanged snapshots must not notify again.
        client.post(endpoint,headers=headers,json=snapshot)
        assert client.get('/api/admin/directory-notices').json()['notices']==[]
        client.post('/api/auth/logout',headers=headers)
        assert client.get('/api/admin/directory-notices').status_code == 401


def test_confirmed_department_selection_recreates_purged_groups_and_hierarchy(tmp_path):
    app=create_app(GatewaySettings(data_dir=tmp_path))
    departments=[{'external_id':'1','display_name':'公司'},
                 {'external_id':'2','display_name':'研发','parent_external_id':'1'},
                 {'external_id':'3','display_name':'销售'}]
    class HierarchyConnector:
        async def fetch_directory(self, source, *, selected_department_ids=None, progress=None):
            return {'departments':[row for row in departments if row['external_id'] in selected_department_ids],
                    'people':[], 'selected_department_ids':selected_department_ids, 'complete':True}
    app.state.identity_connectors={'dingtalk':HierarchyConnector()}
    with TestClient(app,base_url='https://gateway.test') as client:
        headers={'X-CSRF-Token':_setup(client)}
        client.post('/api/auth/step-up',headers=headers,json={'password':'OwnerPassphrase-2026!'})
        source=client.post('/api/admin/identity-sources',headers=headers,json={'provider':'dingtalk','tenant_id':'corp','client_id':'app','client_secret':'secret'}).json()['id']
        base=f'/api/admin/identity-sources/{source}'
        assert client.post(base+'/sync',headers=headers,json={'departments':departments,'people':[]}).status_code==200
        groups=client.get('/api/admin/user-groups/tree').json()['groups']
        parent_id=next(row['parent_id'] for row in groups if row['name']=='研发')
        child_id=next(row['id'] for row in groups if row['name']=='研发')
        sales_id=next(row['id'] for row in groups if row['name']=='销售')
        assert client.post('/api/groups/bulk',headers=headers,json={'group_ids':[row['id'] for row in groups],'action':'delete'}).status_code==200
        assert client.post('/api/groups/bulk',headers=headers,json={'group_ids':[parent_id,child_id],'action':'purge'}).status_code==200
        client.post(base+'/sync-jobs',headers=headers,json={'department_ids':['1','2'],'preview':True})
        for _ in range(100):
            preview=client.get(base+'/sync-jobs/latest').json()
            if preview['status'] in ('preview','failed'):break
            time.sleep(.02)
        assert preview['status']=='preview',preview
        assert client.post(base+'/sync-jobs/confirm',headers=headers,json={'job_id':preview['id'],'selected_subjects':[]}).status_code==202
        for _ in range(100):
            final=client.get(base+'/sync-jobs/latest').json()
            if final['status'] in ('completed','failed'):break
            time.sleep(.02)
        assert final['status']=='completed',final
        groups=client.get('/api/admin/user-groups/tree').json()['groups']
        assert len(groups)==2
        child=next(row for row in groups if row['name']=='研发')
        assert child['parent_id'] in {row['id'] for row in groups}
        deleted=client.get('/api/groups/deleted').json()['groups']
        assert any(row['id']==sales_id for row in deleted)


def test_full_preview_only_applies_selected_users_and_required_department_groups(tmp_path):
    app=create_app(GatewaySettings(data_dir=tmp_path))
    class FullConnector:
        async def fetch_directory(self,source,*,selected_department_ids=None,progress=None):
            return {'departments':[{'external_id':'1','display_name':'公司'},
                {'external_id':'2','display_name':'研发','parent_external_id':'1'},
                {'external_id':'3','display_name':'销售','parent_external_id':'1'}],
                'people':[{'subject':'dev','display_name':'研发用户','department_ids':['2']},
                          {'subject':'sales','display_name':'销售用户','department_ids':['3']}],
                'selected_department_ids':['1','2','3'],'complete':True}
    app.state.identity_connectors={'dingtalk':FullConnector()}
    with TestClient(app,base_url='https://gateway.test') as client:
        headers={'X-CSRF-Token':_setup(client)}
        source=client.post('/api/admin/identity-sources',headers=headers,json={'provider':'dingtalk','tenant_id':'corp','client_id':'app','client_secret':'secret'}).json()['id']
        base=f'/api/admin/identity-sources/{source}'
        client.post(base+'/sync-jobs',headers=headers,json={'department_ids':['1','2','3'],'selection_department_ids':[],'preview':True})
        for _ in range(100):
            preview=client.get(base+'/sync-jobs/latest').json()
            if preview['status'] in ('preview','failed'):break
            time.sleep(.02)
        assert preview['status']=='preview',preview
        assert preview['selection_department_ids']==[]
        assert client.get('/api/admin/user-groups/tree').json()['groups']==[]
        assert client.post(base+'/sync-jobs/confirm',headers=headers,json={'job_id':preview['id'],'department_ids':['unknown'],'selected_subjects':['dev']}).status_code==422
        response=client.post(base+'/sync-jobs/confirm',headers=headers,json={'job_id':preview['id'],'department_ids':['2'],'selected_subjects':['dev']})
        assert response.status_code==202,response.text
        for _ in range(100):
            final=client.get(base+'/sync-jobs/latest').json()
            if final['status'] in ('completed','failed'):break
            time.sleep(.02)
        assert final['status']=='completed',final
        users=client.get('/api/admin/users').json()['users']
        assert any(row['display_name']=='研发用户' for row in users)
        assert not any(row['display_name']=='销售用户' for row in users)
        groups=client.get('/api/admin/user-groups/tree').json()['groups']
        assert len(groups)==2
        assert not any(row['name']=='销售' for row in groups)
        dev=next(row for row in groups if row['name']=='研发')
        assert dev['parent_id'] in {row['id'] for row in groups}
        members=client.get('/api/groups/'+dev['id']+'/members').json()['members']
        assert any(row['display_name']=='研发用户' for row in members)
        from gateway.services.organization_settings import source_options
        options=client.portal.call(source_options,app.state.database,source)
        assert options['selected_department_ids']==['2']
