from fastapi.testclient import TestClient
from gateway.app import create_app
from gateway.config import GatewaySettings
from gateway.models import Device
from test_admin_bulk_people import setup


def test_deleted_and_purged_department_groups_cannot_be_listed_or_assigned(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url='https://gateway.test') as client:
        _, headers, _ = setup(client)
        source = client.post('/api/admin/identity-sources', headers=headers, json={
            'provider':'dingtalk', 'tenant_id':'corp', 'client_id':'app', 'client_secret':'secret',
        }).json()['id']
        snapshot = {'departments':[{'external_id':'1','display_name':'保留部门'},
                                   {'external_id':'2','display_name':'删除部门'}], 'people':[]}
        assert client.post(f'/api/admin/identity-sources/{source}/sync', headers=headers, json=snapshot).status_code == 200
        rows = client.get('/api/admin/departments').json()['departments']
        ids = {row['external_id']:row['id'] for row in rows}
        group = next(row['id'] for row in client.get('/api/admin/user-groups/tree').json()['groups'] if row['name']=='删除部门')
        async def seed():
            async with app.state.database.session() as session:
                async with session.begin():
                    session.add(Device(id='pc', name='PC', public_key='key', status='active'))
        client.portal.call(seed)
        endpoint = '/api/admin/devices/pc/department'
        assert client.put(endpoint, headers=headers, json={'department_id':ids['2']}).status_code == 204
        assert client.post('/api/groups/bulk', headers=headers, json={'group_ids':[group],'action':'delete'}).status_code == 200
        def check():
            response = client.get('/api/admin/departments').json()
            assert {row['id'] for row in response['departments']} == {ids['1']}
            assert response['total']==1
            assert client.put(endpoint, headers=headers, json={'department_id':ids['2']}).status_code == 422
            assert client.put(endpoint, headers=headers, json={'department_id':ids['1']}).status_code == 204
            assert client.put(endpoint, headers=headers, json={'department_id':None}).status_code == 204
        check()
        assert client.post('/api/groups/bulk', headers=headers, json={'group_ids':[group],'action':'restore'}).status_code == 200
        assert client.get('/api/admin/departments').json()['total']==2
        assert client.post('/api/groups/bulk', headers=headers, json={'group_ids':[group],'action':'delete'}).status_code == 200
        assert client.post('/api/groups/bulk', headers=headers, json={'group_ids':[group],'action':'purge'}).status_code == 200
        check()
        # Reconciliation must not make a locally purged department selectable.
        assert client.post(f'/api/admin/identity-sources/{source}/sync', headers=headers, json=snapshot).status_code == 200
        check()


def test_department_assignment_database_lock_keeps_health_responsive(tmp_path):
    import asyncio
    import sqlite3
    import threading
    from httpx import AsyncClient, ASGITransport
    from sqlalchemy import event
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url='https://gateway.test') as client:
        _, headers, _ = setup(client)
        async def seed():
            async with app.state.database.session() as session:
                async with session.begin():
                    session.add(Device(id='pc', name='PC', public_key='key', status='active'))
        client.portal.call(seed)
        reached = threading.Event()
        engine = app.state.database.engine.sync_engine
        def before_execute(connection, cursor, statement, parameters, context, many):
            if statement.startswith(('UPDATE ', 'INSERT ')): reached.set()
        event.listen(engine, 'before_cursor_execute', before_execute)
        async def scenario():
            async with AsyncClient(transport=ASGITransport(app=app), base_url='https://gateway.test', cookies=client.cookies) as actor:
                pending = asyncio.create_task(actor.put('/api/admin/devices/pc/department', headers=headers, json={'department_id':None}))
                try:
                    assert await asyncio.to_thread(reached.wait, 2)
                    assert (await asyncio.wait_for(actor.get('/api/health'), .5)).status_code == 200
                    assert not pending.done()
                finally:
                    await asyncio.to_thread(lock.rollback)
                    response = await pending
                assert response.status_code == 204
        # Make null assignment a real update while retaining a valid FK.
        source = client.post('/api/admin/identity-sources', headers=headers, json={
            'provider':'dingtalk','tenant_id':'corp','client_id':'app','client_secret':'secret'}).json()['id']
        client.post(f'/api/admin/identity-sources/{source}/sync', headers=headers, json={
            'departments':[{'external_id':'1','display_name':'部门'}],'people':[]})
        department = client.get('/api/admin/departments').json()['departments'][0]['id']
        client.put('/api/admin/devices/pc/department', headers=headers, json={'department_id':department})
        reached.clear()
        try:
            with sqlite3.connect(tmp_path / 'workstep_platform.db', check_same_thread=False) as lock:
                lock.execute('BEGIN IMMEDIATE')
                client.portal.call(scenario)
        finally:
            event.remove(engine, 'before_cursor_execute', before_execute)
