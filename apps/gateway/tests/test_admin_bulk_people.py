from fastapi.testclient import TestClient
from gateway.app import create_app
from gateway.config import GatewaySettings
import pytest


def setup(client):
    result = client.post('/api/platform/setup', json={
        'username': 'owner', 'display_name': '管理员', 'password': 'OwnerPassword123',
        'recovery_username': 'recovery', 'recovery_password': 'RecoveryPassword123',
        'registration_mode': 'open',
    }).json()
    headers = {'X-CSRF-Token': result['csrf_token']}
    client.post('/api/auth/step-up', json={'password': 'OwnerPassword123'}, headers=headers)
    users = [client.post('/api/admin/users', json={
        'username': name, 'display_name': name.upper(), 'password': 'UserPassword123',
        'status': 'pending',
    }, headers=headers).json()['id'] for name in ['alice', 'bobby']]
    return result['user']['id'], headers, users


def test_users_bulk_atomic_status_and_last_admin_protection(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url='https://gateway.test') as client:
        owner, headers, users = setup(client)
        from gateway.models import User
        from sqlalchemy import update
        async def inactive_recovery():
            async with app.state.database.session() as session:
                async with session.begin():
                    await session.execute(update(User).where(User.is_recovery == 1).values(status='disabled'))
        client.portal.call(inactive_recovery)
        url = '/api/admin/users/bulk'
        assert client.post(url, json={'user_ids': [], 'action': 'approve'}, headers=headers).status_code == 422
        assert client.post(url, json={'user_ids': users, 'action': 'approve'}).status_code == 403
        assert client.post(url, json={'user_ids': users, 'action': 'approve'}, headers=headers).status_code == 200
        assert client.post(url, json={'user_ids': [*users, owner], 'action': 'disable'}, headers=headers).status_code == 409
        assert client.post(url, json={'user_ids': [*users, owner], 'action': 'delete'}, headers=headers).status_code == 409
        rows = client.get('/api/admin/users').json()['users']
        assert all(row['status'] == 'active' for row in rows if row['id'] in users)
        assert client.post(url, json={'user_ids': users, 'action': 'disable'}, headers=headers).json()['updated'] == 2
        assert client.post(url, json={'user_ids': users, 'action': 'enable'}, headers=headers).status_code == 200
        client.cookies.clear()
        assert client.post('/api/auth/login', json={'username': 'alice', 'password': 'UserPassword123'}).status_code == 200


def test_group_bulk_members_atomic_and_directory_read_only(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url='https://gateway.test') as client:
        _, headers, users = setup(client)
        client.post('/api/admin/users/bulk', json={'user_ids': users, 'action': 'approve'}, headers=headers)
        group = client.post('/api/groups', json={'name': '研发组', 'slug': 'dev'}, headers=headers).json()['id']
        url = f'/api/groups/{group}/members/bulk'
        assert client.post(url, json={'user_ids': [users[0], 'missing'], 'action': 'add'}, headers=headers).status_code == 404
        assert client.get(f'/api/groups/{group}/members').json()['members'] == []
        assert client.post(url, json={'user_ids': users, 'action': 'add'}, headers=headers).json()['updated'] == 2
        assert client.post(url, json={'user_ids': users, 'action': 'set_role', 'role': 'leader'}, headers=headers).status_code == 200
        assert all(row['role'] == 'leader' for row in client.get(f'/api/groups/{group}/members').json()['members'])
        from gateway.models import GroupMembership
        from sqlalchemy import select
        async def directory_member():
            async with app.state.database.session() as session:
                async with session.begin():
                    member = await session.scalar(select(GroupMembership).where(GroupMembership.user_id == users[1], GroupMembership.group_id == group))
                    member.source = 'directory_sync'
        client.portal.call(directory_member)
        assert client.post(url, json={'user_ids': users, 'action': 'remove'}, headers=headers).status_code == 409
        assert len(client.get(f'/api/groups/{group}/members').json()['members']) == 2
        assert client.post(url, json={'user_ids': [users[0]], 'action': 'remove'}, headers=headers).status_code == 200
        assert len(client.get(f'/api/groups/{group}/members').json()['members']) == 1


@pytest.mark.parametrize('target', ['users', 'members', 'delete_users', 'delete_groups', 'purge_users', 'purge_groups'])
def test_bulk_database_contention_keeps_health_responsive(tmp_path, target):
    import asyncio
    import sqlite3
    import threading
    from httpx import ASGITransport, AsyncClient
    from sqlalchemy import event
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url='https://gateway.test') as client:
        _, headers, users = setup(client)
        client.post('/api/admin/users/bulk', json={'user_ids': users, 'action': 'approve'}, headers=headers)
        group = client.post('/api/groups', json={'name': '研发组', 'slug': 'dev'}, headers=headers).json()['id']
        url = '/api/admin/users/bulk' if target in ['users', 'delete_users', 'purge_users'] else '/api/groups/bulk' if target in ['delete_groups', 'purge_groups'] else f'/api/groups/{group}/members/bulk'
        body = {'group_ids': [group], 'action': 'delete'} if target in ['delete_groups', 'purge_groups'] else {'user_ids': users, 'action': 'delete' if target == 'delete_users' else 'disable' if target == 'users' else 'add'}
        if target == 'purge_users':
            client.post(url, json={'user_ids': users, 'action': 'delete'}, headers=headers)
            body = {'user_ids': users, 'action': 'purge'}
        if target == 'purge_groups':
            client.post(url, json={'group_ids': [group], 'action': 'delete'}, headers=headers)
            body = {'group_ids': [group], 'action': 'purge'}
        reached = threading.Event()
        def before_execute(connection, cursor, statement, parameters, context, many):
            if statement.startswith('UPDATE platform_settings') or statement.startswith('INSERT INTO group_memberships'):
                reached.set()
        engine = app.state.database.engine.sync_engine
        event.listen(engine, 'before_cursor_execute', before_execute)
        async def scenario():
            async with AsyncClient(transport=ASGITransport(app=app), base_url='https://gateway.test', cookies=client.cookies) as actor:
                pending = asyncio.create_task(actor.post(url, json=body, headers=headers))
                try:
                    assert await asyncio.to_thread(reached.wait, 2)
                    assert (await asyncio.wait_for(actor.get('/api/health'), .5)).status_code == 200
                    assert not pending.done()
                finally:
                    await asyncio.to_thread(lock.rollback)
                assert (await pending).status_code == 200
        try:
            with sqlite3.connect(tmp_path / 'workstep_platform.db', check_same_thread=False) as lock:
                lock.execute('BEGIN IMMEDIATE')
                client.portal.call(scenario)
        finally:
            event.remove(engine, 'before_cursor_execute', before_execute)


def test_bulk_operations_deny_non_admin_and_outside_group(tmp_path):
    with TestClient(create_app(GatewaySettings(data_dir=tmp_path)), base_url='https://gateway.test') as client:
        _, headers, users = setup(client)
        client.post('/api/admin/users/bulk', json={'user_ids': users, 'action': 'approve'}, headers=headers)
        groups = [client.post('/api/groups', json={'name': slug, 'slug': slug}, headers=headers).json()['id'] for slug in ['dev', 'other']]
        client.post(f'/api/groups/{groups[0]}/members/bulk', json={'user_ids': [users[0]], 'action': 'add', 'role': 'leader'}, headers=headers)
        client.cookies.clear()
        login = client.post('/api/auth/login', json={'username': 'alice', 'password': 'UserPassword123'}).json()
        headers = {'X-CSRF-Token': login['csrf_token']}
        client.post('/api/auth/password', json={'current_password': 'UserPassword123', 'new_password': 'ChangedPassword123'}, headers=headers)
        assert client.post('/api/admin/users/bulk', json={'user_ids': [users[1]], 'action': 'disable'}, headers=headers).status_code == 403
        assert client.post(f'/api/groups/{groups[1]}/members/bulk', json={'user_ids': [users[1]], 'action': 'add'}, headers=headers).status_code == 403
        own = f'/api/groups/{groups[0]}/members/bulk'
        assert client.post(own, json={'user_ids': [users[1]], 'action': 'add', 'role': 'leader'}, headers=headers).status_code == 403
        assert client.post(own, json={'user_ids': [users[1]], 'action': 'add'}, headers=headers).status_code == 200
        assert client.post(own, json={'user_ids': users, 'action': 'set_role', 'role': 'member'}, headers=headers).status_code == 403


def test_people_delete_is_atomic_protected_and_recoverable(tmp_path):
    with TestClient(create_app(GatewaySettings(data_dir=tmp_path)), base_url='https://gateway.test') as client:
        owner, headers, users = setup(client)
        recovery = next(row['id'] for row in client.get('/api/admin/users').json()['users'] if row['is_recovery'])
        url = '/api/admin/users/bulk'
        assert client.post(url, json={'user_ids': [users[0], recovery], 'action': 'delete'}, headers=headers).status_code == 403
        assert client.post(url, json={'user_ids': [users[0], owner], 'action': 'delete'}, headers=headers).status_code == 409
        assert client.post(url, json={'user_ids': users, 'action': 'delete'}).status_code == 403
        assert client.post(url, json={'user_ids': users, 'action': 'delete'}, headers=headers).status_code == 200
        assert not set(users).intersection(row['id'] for row in client.get('/api/admin/users').json()['users'])
        assert {row['id'] for row in client.get('/api/admin/users?status=deleted').json()['users']} == set(users)
        assert client.post(f'/api/admin/users/{users[0]}/approve', headers=headers).status_code == 409
        assert client.post(url, json={'user_ids': users, 'action': 'enable'}, headers=headers).status_code == 409
        assert client.post(url, json={'user_ids': users, 'action': 'restore'}, headers=headers).status_code == 200
        assert all(row['status'] == 'disabled' for row in client.get('/api/admin/users').json()['users'] if row['id'] in users)


def test_groups_delete_and_restore_without_removing_users(tmp_path):
    with TestClient(create_app(GatewaySettings(data_dir=tmp_path)), base_url='https://gateway.test') as client:
        _, headers, users = setup(client)
        client.post('/api/admin/users/bulk', json={'user_ids': users, 'action': 'approve'}, headers=headers)
        group = client.post('/api/groups', json={'name': '研发', 'slug': 'dev'}, headers=headers).json()['id']
        client.post(f'/api/groups/{group}/members/bulk', json={'user_ids': users, 'action': 'add'}, headers=headers)
        url = '/api/groups/bulk'
        assert client.post(url, json={'group_ids': [group, 'missing'], 'action': 'delete'}, headers=headers).status_code == 404
        assert client.post(url, json={'group_ids': [group], 'action': 'delete'}).status_code == 403
        assert client.post(url, json={'group_ids': [group], 'action': 'delete'}, headers=headers).status_code == 200
        assert client.get('/api/admin/user-groups/tree').json()['groups'] == []
        assert [row['id'] for row in client.get('/api/groups/deleted').json()['groups']] == [group]
        assert client.get(f'/api/groups/{group}/members').status_code == 404
        assert len(client.get('/api/admin/users').json()['users']) == 4
        assert client.post(url, json={'group_ids': [group], 'action': 'restore'}, headers=headers).status_code == 200
        assert len(client.get(f'/api/groups/{group}/members').json()['members']) == 2


def test_deleted_user_cannot_login_or_reuse_session(tmp_path):
    with TestClient(create_app(GatewaySettings(data_dir=tmp_path)), base_url='https://gateway.test') as client:
        _, headers, users = setup(client)
        client.post('/api/admin/users/bulk', json={'user_ids': users, 'action': 'approve'}, headers=headers)
        admin_cookies = dict(client.cookies)
        client.cookies.clear()
        assert client.post('/api/auth/login', json={'username': 'alice', 'password': 'UserPassword123'}).status_code == 200
        user_cookies = dict(client.cookies)
        client.cookies.clear()
        client.cookies.update(admin_cookies)
        assert client.post('/api/admin/users/bulk', json={'user_ids': [users[0]], 'action': 'delete'}, headers=headers).status_code == 200
        client.cookies.clear()
        client.cookies.update(user_cookies)
        assert client.get('/api/auth/session').status_code in [401, 403]
        assert client.post('/api/auth/login', json={'username': 'alice', 'password': 'UserPassword123'}).status_code == 403


def test_legacy_tenant_root_shows_organization_name_in_tree_directory_and_deleted_list(tmp_path):
    with TestClient(create_app(GatewaySettings(data_dir=tmp_path)), base_url='https://gateway.test') as client:
        _, headers, _ = setup(client)
        source = client.post('/api/admin/identity-sources', headers=headers, json={
            'provider': 'dingtalk', 'tenant_id': '5055796336', 'client_id': 'app', 'client_secret': 'secret',
        }).json()['id']
        assert client.post(f'/api/admin/identity-sources/{source}/sync', headers=headers, json={
            'departments': [{'external_id': '1', 'display_name': '5055796336'},
                            {'external_id': '2', 'display_name': '研发', 'parent_external_id': '1'}], 'people': [],
        }).status_code == 200
        rows = client.get('/api/admin/user-groups/tree').json()['groups']
        root = next(row for row in rows if row['parent_id'] is None)
        assert root['name'] == '钉钉组织'
        assert next(row for row in rows if row['name'] == '研发')['parent_id'] == root['id']
        departments = client.get('/api/admin/org/departments').json()['departments']
        assert next(row for row in departments if row['external_id'] == '1')['display_name'] == '钉钉组织'
        assert client.post('/api/groups/bulk', headers=headers, json={'group_ids': [root['id']], 'action': 'delete'}).status_code == 200
        assert client.get('/api/groups/deleted').json()['groups'][0]['name'] == '钉钉组织'


def test_recycle_bin_permanent_delete_requires_deleted_status_and_preserves_audit(tmp_path):
    import sqlite3
    with TestClient(create_app(GatewaySettings(data_dir=tmp_path)),base_url='https://gateway.test') as client:
        _,headers,users=setup(client)
        url='/api/admin/users/bulk'
        assert client.post(url,headers=headers,json={'user_ids':users,'action':'purge'}).status_code==409
        assert client.post(url,headers=headers,json={'user_ids':users,'action':'delete'}).status_code==200
        assert client.post(url,json={'user_ids':users,'action':'purge'}).status_code==403
        assert client.post(url,headers=headers,json={'user_ids':users,'action':'purge'}).status_code==200
        assert client.get('/api/admin/users?status=deleted').json()['users']==[]
        with sqlite3.connect(tmp_path/'workstep_platform.db') as db:
            assert db.execute("select count(*) from users where id in (?,?)",users).fetchone()[0]==0
            assert db.execute("select count(*) from audit_events where action='user.bulk_purge'").fetchone()[0]==1


def test_group_recycle_bin_purge_removes_group_links_but_keeps_users(tmp_path):
    import sqlite3
    with TestClient(create_app(GatewaySettings(data_dir=tmp_path)),base_url='https://gateway.test') as client:
        _,headers,users=setup(client)
        group=client.post('/api/groups',headers=headers,json={'name':'回收组','slug':'recycle'}).json()['id']
        client.post(f'/api/groups/{group}/members/bulk',headers=headers,json={'user_ids':users,'action':'add'})
        url='/api/groups/bulk'
        assert client.post(url,headers=headers,json={'group_ids':[group],'action':'purge'}).status_code==409
        assert client.post(url,headers=headers,json={'group_ids':[group],'action':'delete'}).status_code==200
        assert client.post(url,json={'group_ids':[group],'action':'purge'}).status_code==403
        assert client.post(url,headers=headers,json={'group_ids':[group],'action':'purge'}).status_code==200
        assert client.get('/api/groups/deleted').json()['groups']==[]
        with sqlite3.connect(tmp_path/'workstep_platform.db') as db:
            assert db.execute('select count(*) from users where id in (?,?)',users).fetchone()[0]==2
            assert db.execute('select count(*) from group_memberships where group_id=?',(group,)).fetchone()[0]==0
            assert db.execute('select count(*) from user_groups where id=?',(group,)).fetchone()[0]==0


def test_admin_edits_user_name_and_password(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url='https://gateway.test') as client:
        _, headers, users = setup(client)
        url = f'/api/admin/users/{users[0]}'
        assert client.patch(url, json={'display_name': '新名字'}).status_code == 403
        assert client.patch(url, json={'display_name': '   '}, headers=headers).status_code == 422
        assert client.patch(url, json={'display_name': '新名字', 'new_password': 'short'}, headers=headers).status_code == 422
        response = client.patch(url, json={'display_name': '新名字', 'new_password': 'ChangedPassword123'}, headers=headers)
        assert response.status_code == 200, response.text
        assert response.json()['display_name'] == '新名字'
        client.post('/api/admin/users/bulk', json={'user_ids': [users[0]], 'action': 'approve'}, headers=headers)
        client.cookies.clear()
        assert client.post('/api/auth/login', json={'username': 'alice', 'password': 'UserPassword123'}).status_code == 401
        assert client.post('/api/auth/login', json={'username': 'alice', 'password': 'ChangedPassword123'}).status_code == 200


def test_user_edit_password_hash_does_not_block_health(tmp_path, monkeypatch):
    import threading
    import time
    from concurrent.futures import ThreadPoolExecutor
    import gateway.services.identity as identity_module
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url='https://gateway.test') as client:
        _, headers, users = setup(client)
        entered = threading.Event()
        original = identity_module._password_hasher.hash
        def slow_hash(password):
            entered.set()
            time.sleep(0.7)
            return original(password)
        from types import SimpleNamespace
        monkeypatch.setattr(identity_module, '_password_hasher', SimpleNamespace(hash=slow_hash))
        with ThreadPoolExecutor() as executor:
            pending = executor.submit(client.patch, f'/api/admin/users/{users[0]}',
                json={'display_name':'Slow hash', 'new_password':'ChangedPassword123'}, headers=headers)
            assert entered.wait(2)
            started = time.monotonic()
            assert client.get('/api/health').status_code == 200
            assert time.monotonic() - started < 0.4
            assert pending.result().status_code == 200
