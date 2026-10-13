import pytest
from sqlalchemy import select
from gateway.config import GatewaySettings
from gateway.database import GatewayDatabase
from gateway.models import DirectoryPerson, DirectoryDepartment, User, GroupMembership
from gateway.services.external_identity import ExternalIdentityService
from gateway.services.reconciliation import DirectoryReconciler


@pytest.mark.asyncio
@pytest.mark.parametrize('mode,expected', [('all', {'a','b','new','sales'}), ('departments', {'a','b','new'}), ('users', {'a'})])
async def test_maintenance_modes_control_future_new_users_and_departments(tmp_path, mode, expected):
    db=GatewayDatabase(GatewaySettings(data_dir=tmp_path));await db.start()
    try:
        service=ExternalIdentityService(db)
        source=await service.create_source('wecom','corp','app','SECRET',options={'maintenance_policy':{
            'mode':mode,'department_ids':['2'] if mode=='departments' else [],
            'subjects':['a'] if mode=='users' else [],'excluded_subjects':[]}})
        class Connector:
            async def fetch_directory(self, source, **kwargs):
                return {'departments':[{'external_id':'1','display_name':'公司'},
                    {'external_id':'2','display_name':'研发','parent_external_id':'1'},
                    {'external_id':'3','display_name':'新销售','parent_external_id':'1'}],
                    'people':[{'subject':id,'display_name':id,'department_ids':[dept]}
                              for id,dept in [('a','2'),('b','2'),('new','2'),('sales','3')]],'complete':True}
        reconciler=DirectoryReconciler(db,{'wecom':Connector()})
        await reconciler.run_once()
        async with db.session() as session:
            assert set((await session.scalars(select(DirectoryPerson.subject))).all())==expected
    finally:await db.close()


@pytest.mark.asyncio
async def test_preview_comparison_does_not_write_accounts_or_acquire_a_database_write_lock(tmp_path):
    from sqlalchemy import event
    import asyncio
    import sqlite3
    db=GatewayDatabase(GatewaySettings(data_dir=tmp_path));await db.start()
    writes=[]
    def capture(connection,cursor,statement,parameters,context,many):
        if statement.lstrip().upper().startswith(('INSERT','UPDATE','DELETE')):writes.append(statement)
    try:
        service=ExternalIdentityService(db)
        source=await service.create_source('wecom','corp','app','SECRET')
        event.listen(db.engine.sync_engine,'before_cursor_execute',capture)
        with sqlite3.connect(tmp_path/'workstep_platform.db') as lock:
            lock.execute('BEGIN IMMEDIATE')
            preview=await asyncio.wait_for(service.full_sync(source.id,
                [{'external_id':'2','display_name':'研发'}],
                [{'subject':'new','display_name':'新员工','department_ids':['2']}],dry_run=True),.5)
            assert preview['people_added']==1
            assert writes==[]
            lock.rollback()
    finally:
        event.remove(db.engine.sync_engine,'before_cursor_execute',capture)
        await db.close()


@pytest.mark.asyncio
async def test_organization_only_batch_preserves_users_without_changing_future_user_policy(tmp_path):
    from gateway.services.directory_maintenance import apply_maintenance
    from gateway.services.organization_settings import source_options
    from gateway.models import UserGroup
    db=GatewayDatabase(GatewaySettings(data_dir=tmp_path));await db.start()
    try:
        service=ExternalIdentityService(db)
        source=await service.create_source('wecom','corp','app','SECRET')
        await service.full_sync(source.id,[{'external_id':'2','display_name':'研发'}],
            [{'subject':'a','display_name':'原姓名','department_ids':['2']}])
        snapshot={'departments':[{'external_id':'2','display_name':'新版研发'}],
                  'people':[{'subject':'a','display_name':'新姓名','department_ids':['2'],'active':False}],'complete':True}
        policy={'mode':'all','department_ids':[],'subjects':[],'excluded_subjects':[]}
        result=await apply_maintenance(service,source.id,snapshot,policy,groups_only=True,persist=True)
        assert result['people']==0
        async with db.session() as session:
            person=await session.scalar(select(DirectoryPerson))
            assert person.display_name=='原姓名'
            assert (await session.get(User,person.user_id)).status=='active'
            assert (await session.scalar(select(UserGroup))).name=='新版研发'
        assert (await source_options(db,source.id))['maintenance_policy']['excluded_subjects']==[]
        await apply_maintenance(service,source.id,snapshot,policy)
        async with db.session() as session:
            assert (await session.get(User,person.user_id)).status=='disabled'
    finally:await db.close()


@pytest.mark.asyncio
async def test_direct_person_events_obey_the_saved_user_range(tmp_path):
    db=GatewayDatabase(GatewaySettings(data_dir=tmp_path));await db.start()
    try:
        service=ExternalIdentityService(db)
        source=await service.create_source('wecom','corp','app','SECRET',options={'maintenance_policy':{
            'mode':'users','department_ids':[],'subjects':['a'],'excluded_subjects':[]}})
        await service.full_sync(source.id,[{'external_id':'2','display_name':'研发'}],
            [{'subject':id,'display_name':id,'department_ids':['2']} for id in ['a','keep']])
        await service.apply_person_event(source.id,'event-keep','person_delete','keep',None,[])
        await service.apply_person_event(source.id,'event-new','person_upsert','new','不应创建',['2'])
        async with db.session() as session:
            rows={row.subject:row for row in (await session.scalars(select(DirectoryPerson))).all()}
            assert rows['keep'].active==1
            assert 'new' not in rows
        await service.apply_person_event(source.id,'event-a','person_delete','a',None,[])
        async with db.session() as session:
            assert (await session.get(User,rows['a'].user_id)).status=='disabled'
    finally:await db.close()


@pytest.mark.asyncio
async def test_existing_enterprise_login_account_is_updated_without_duplicate_and_follows_enterprise_status(tmp_path):
    from gateway.models import ExternalIdentity
    db=GatewayDatabase(GatewaySettings(data_dir=tmp_path));await db.start()
    try:
        service=ExternalIdentityService(db)
        source=await service.create_source('dingtalk','corp','app','SECRET')
        async with db.session() as session:
            async with session.begin():
                session.add(User(id='existing',username='enterprise-login',display_name='旧姓名',status='active',registration_source='dingtalk'))
                await session.flush()
                session.add(ExternalIdentity(id='binding',source_id=source.id,subject='a',user_id='existing',display_name='旧姓名'))
        departments=[{'external_id':'2','display_name':'研发'}]
        person={'subject':'a','display_name':'新姓名','department_ids':['2']}
        await service.full_sync(source.id,departments,[person])
        async with db.session() as session:
            assert (await session.scalar(select(DirectoryPerson))).user_id=='existing'
            assert (await session.get(User,'existing')).display_name=='新姓名'
            assert len((await session.scalars(select(User).where(User.registration_source.in_(['directory_sync','dingtalk'])))).all())==1
        await service.full_sync(source.id,departments,[{**person,'active':False}])
        async with db.session() as session:assert (await session.get(User,'existing')).status=='disabled'
        result=await service.full_sync(source.id,departments,[person])
        assert result['people_added']==0
        assert result['people_reactivated']==1
        async with db.session() as session:assert (await session.get(User,'existing')).status=='active'
    finally:await db.close()


@pytest.mark.asyncio
async def test_directory_group_creation_works_with_real_foreign_key_enforcement(tmp_path):
    from sqlalchemy import text
    from gateway.models import UserGroup
    db=GatewayDatabase(GatewaySettings(data_dir=tmp_path));await db.start()
    try:
        async with db.engine.connect() as connection:
            await connection.exec_driver_sql('PRAGMA foreign_keys=ON')
        service=ExternalIdentityService(db)
        source=await service.create_source('wecom','corp','app','SECRET')
        await service.full_sync(source.id,[{'external_id':'1','display_name':'公司'},
            {'external_id':'2','display_name':'研发','parent_external_id':'1'}],
            [{'subject':'a','display_name':'员工','department_ids':['2']}])
        async with db.session() as session:
            assert len((await session.scalars(select(UserGroup))).all())==2
            assert (await session.execute(text('PRAGMA foreign_key_check'))).all()==[]
    finally:await db.close()


def test_confirmed_user_policy_is_saved_and_future_sync_preserves_unselected_accounts(tmp_path):
    import time
    from fastapi.testclient import TestClient
    from gateway.app import create_app
    from test_external_identity import _setup
    state={'departments':[{'external_id':'1','display_name':'公司'}, {'external_id':'2','display_name':'研发','parent_external_id':'1'}],
           'people':[{'subject':'a','display_name':'员工A','department_ids':['2']}, {'subject':'b','display_name':'员工B','department_ids':['2']}]}
    class Connector:
        async def fetch_directory(self,source,*,departments_only=False,**kwargs):
            return {'departments':state['departments'],'people':[] if departments_only else state['people'],
                    'complete':True,'whole_company':True,'selected_department_ids':[row['external_id'] for row in state['departments']]}
    app=create_app(GatewaySettings(data_dir=tmp_path));app.state.identity_connectors={'wecom':Connector()}
    with TestClient(app,base_url='https://gateway.test') as client:
        headers={'X-CSRF-Token':_setup(client)}
        created=client.post('/api/admin/identity-sources',headers=headers,json={'provider':'wecom','tenant_id':'corp','client_id':'app','agent_id':'1001','client_secret':'secret'})
        assert created.status_code==201,created.text
        source=created.json()['id']
        base=f'/api/admin/identity-sources/{source}'
        assert client.get(base+'/directory-preview').json()['is_initialized'] is False
        def read():
            client.post(base+'/sync-jobs',headers=headers,json={'department_ids':[row['external_id'] for row in state['departments']],
                'selection_department_ids':['2'],'preview':True,'refresh':True,'full_directory':True})
            for _ in range(100):
                job=client.get(base+'/sync-jobs/latest').json()
                if job['status'] in ('preview','failed'):break
                time.sleep(.01)
            assert job['status']=='preview',job
            return job
        job=read()
        policy={'mode':'users','subjects':['a'],'department_ids':[],'excluded_subjects':[]}
        response=client.post(base+'/sync-jobs/confirm',headers=headers,json={'job_id':job['id'],'department_ids':['2'],'selected_subjects':['a'],'maintenance_policy':policy})
        assert response.status_code==202,response.text
        for _ in range(100):
            final=client.get(base+'/sync-jobs/latest').json()
            if final['status'] in ('completed','failed'):break
            time.sleep(.01)
        assert final['status']=='completed',final
        assert client.get(base+'/directory-preview').json()['maintenance_policy']['subjects']==['a']
        state['people']=[dict(state['people'][0],display_name='改名A'),*state['people'][1:],{'subject':'new','display_name':'新员工','department_ids':['2']}]
        client.portal.call(app.state.directory_reconciler.run_once)
        users=client.get('/api/admin/users').json()['users']
        assert any(row['display_name']=='改名A' for row in users)
        assert not any(row['display_name'] in ['员工B','新员工'] for row in users)
        state['people']=[]
        job=read()
        assert next(row for row in job['result']['user_candidates'] if row['subject']=='a')['kind']=='source_deleted'
        response=client.post(base+'/sync-jobs/confirm',headers=headers,json={'job_id':job['id'],'department_ids':['2'],'selected_subjects':['a'],'maintenance_policy':policy})
        assert response.status_code==202,response.text
        for _ in range(100):
            final=client.get(base+'/sync-jobs/latest').json()
            if final['status'] in ('completed','failed'):break
            time.sleep(.01)
        assert final['status']=='completed',final
        user=next(row for row in client.get('/api/admin/users').json()['users'] if row['display_name']=='改名A')
        assert user['status']=='disabled'


@pytest.mark.asyncio
async def test_selected_user_moves_and_source_deletion_does_not_touch_unselected_users(tmp_path):
    db=GatewayDatabase(GatewaySettings(data_dir=tmp_path));await db.start()
    try:
        service=ExternalIdentityService(db)
        source=await service.create_source('wecom','corp','app','SECRET')
        departments=[{'external_id':'1','display_name':'公司'}, {'external_id':'2','display_name':'研发','parent_external_id':'1'}, {'external_id':'3','display_name':'销售','parent_external_id':'1'}]
        people=[{'subject':id,'display_name':id,'department_ids':['2']} for id in ['a','keep']]
        await service.full_sync(source.id,departments,people)
        from gateway.services.directory_maintenance import apply_maintenance
        policy={'mode':'users','subjects':['a'],'department_ids':[],'excluded_subjects':[]}
        moved={'departments':departments,'people':[dict(people[0],department_ids=['3']),dict(people[1],display_name='不要改')],'complete':True}
        await apply_maintenance(service,source.id,moved,policy)
        async with db.session() as session:
            rows={row.subject:row for row in (await session.scalars(select(DirectoryPerson))).all()}
            assert rows['keep'].display_name=='keep'
            assert (await session.get(User,rows['a'].user_id)).status=='active'
        partial={'departments':departments,'people':[],'complete':False}
        result=await apply_maintenance(service,source.id,partial,policy)
        assert result['people_unverified']==1
        async with db.session() as session:
            assert (await session.get(User,rows['a'].user_id)).status=='active'
        restricted={**partial,'complete':True,'whole_company':False}
        result=await apply_maintenance(service,source.id,restricted,policy)
        assert result['people_unverified']==1
        async with db.session() as session:
            assert (await session.get(User,rows['a'].user_id)).status=='active'
        unproven={**partial,'complete':True}
        result=await apply_maintenance(service,source.id,unproven,policy)
        assert result['people_unverified']==1
        async with db.session() as session:
            assert (await session.get(User,rows['a'].user_id)).status=='active'
        complete={**partial,'complete':True,'whole_company':True}
        preview=await apply_maintenance(service,source.id,complete,policy,dry_run=True)
        assert next(row for row in preview['user_candidates'] if row['subject']=='a')['kind']=='source_deleted'
        await apply_maintenance(service,source.id,complete,policy)
        async with db.session() as session:
            assert (await session.get(User,rows['a'].user_id)).status=='disabled'
            assert (await session.get(User,rows['keep'].user_id)).status=='active'
    finally:await db.close()
