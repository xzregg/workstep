import sqlite3
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from gateway.app import create_app
from gateway.config import GatewaySettings
from test_identity_api import _setup


def create_invited(client, headers, **extra):
    response = client.post('/api/admin/users', headers=headers,
                           json={'display_name': '邀请用户', **extra})
    assert response.status_code == 201, response.text
    return response.json()['id']


def issue(client, headers, user_id):
    response = client.post(f'/api/admin/users/{user_id}/invitation', headers=headers)
    assert response.status_code == 200, response.text
    return response.json()['url'].split('#')[1]


def accept(client, token, username='invitee'):
    return client.post('/api/auth/invitation/accept', json={
        'token': token, 'username': username, 'password': 'InvitePassphrase-2026!',
    })


def test_invitation_rotation_activation_and_empty_password_login(tmp_path):
    with TestClient(create_app(GatewaySettings(data_dir=tmp_path)), base_url='https://gateway.test') as client:
        headers = {'X-CSRF-Token': _setup(client).json()['csrf_token']}
        uid = create_invited(client, headers, username='reserved', password='')
        admin_cookie = client.cookies.get('workstep_gateway_session')
        assert client.post('/api/auth/login', json={'username': 'reserved', 'password': ''}).status_code == 401
        first = issue(client, headers, uid)
        second = issue(client, headers, uid)
        assert first == second
        with sqlite3.connect(tmp_path / 'workstep_platform.db') as db:
            db.execute("UPDATE users SET invitation_expires_at='2000-01-01' WHERE id=?", (uid,))
        second = issue(client, headers, uid)
        assert first != second
        assert accept(client, first).status_code == 410
        for _ in range(2):
            preview = client.post('/api/auth/invitation/inspect', json={'token': second})
            assert preview.status_code == 200
            assert preview.json()['display_name'] == '邀请用户'
        with sqlite3.connect(tmp_path / 'workstep_platform.db') as db:
            stored = db.execute('SELECT invitation_token_hash FROM users WHERE id=?', (uid,)).fetchone()[0]
            assert second not in stored and len(stored) == 64
        assert accept(client, second).status_code == 200
        assert accept(client, second, 'another').status_code == 410
        client.cookies.set('workstep_gateway_session', admin_cookie, domain='gateway.test', path='/')
        assert client.post(f'/api/admin/users/{uid}/invitation', headers=headers).status_code == 200
        client.cookies.clear()
        login = client.post('/api/auth/login', json={'username': 'invitee', 'password': 'InvitePassphrase-2026!'})
        assert login.status_code == 200
        assert login.json()['user']['display_name'] == '邀请用户'


@pytest.mark.parametrize('change', ['expired', 'disabled', 'deleted'])
def test_unavailable_invitation_cannot_activate(tmp_path, change):
    with TestClient(create_app(GatewaySettings(data_dir=tmp_path)), base_url='https://gateway.test') as client:
        headers = {'X-CSRF-Token': _setup(client).json()['csrf_token']}
        uid = create_invited(client, headers)
        token = issue(client, headers, uid)
        with sqlite3.connect(tmp_path / 'workstep_platform.db') as db:
            if change == 'expired':
                db.execute("UPDATE users SET invitation_expires_at='2000-01-01' WHERE id=?", (uid,))
            else:
                db.execute('UPDATE users SET status=? WHERE id=?', (change, uid))
        assert accept(client, token).status_code == 410


@pytest.mark.parametrize('source', ['admin_created', 'local', 'directory_sync'])
def test_existing_password_can_be_reset_with_link_and_old_sessions_revoked(tmp_path, source):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url='https://gateway.test') as client:
        headers = {'X-CSRF-Token': _setup(client).json()['csrf_token']}
        uid = create_invited(client, headers, username='existing', password='OriginalPassphrase-2026!')
        with sqlite3.connect(tmp_path / 'workstep_platform.db') as db:
            db.execute('UPDATE users SET registration_source=? WHERE id=?', (source, uid))
        token = issue(client, headers, uid)
        preview = client.post('/api/auth/invitation/inspect', json={'token': token})
        assert preview.json()['username'] == 'existing'
        assert client.post('/api/auth/login', json={
            'username': 'existing', 'password': 'OriginalPassphrase-2026!',
        }).status_code == 200
        old_cookie = client.cookies.get('workstep_gateway_session')
        result = accept(client, token, 'existing')
        assert result.status_code == 200
        assert result.json()['signed_in'] is True
        assert client.get('/api/auth/session').json()['user']['id'] == uid
        assert client.cookies.get('workstep_gateway_session') != old_cookie
        client.cookies.set('workstep_gateway_session', old_cookie, domain='gateway.test', path='/')
        assert client.get('/api/auth/session').status_code == 401
        assert client.post('/api/auth/login', json={
            'username': 'existing', 'password': 'OriginalPassphrase-2026!',
        }).status_code == 401
        assert client.post('/api/auth/login', json={
            'username': 'existing', 'password': 'InvitePassphrase-2026!',
        }).status_code == 200
        assert accept(client, token, 'existing').status_code == 410


def test_validation_conflict_and_concurrent_single_use(tmp_path):
    with TestClient(create_app(GatewaySettings(data_dir=tmp_path)), base_url='https://gateway.test') as client:
        headers = {'X-CSRF-Token': _setup(client).json()['csrf_token']}
        uid = create_invited(client, headers, status='pending')
        token = issue(client, headers, uid)
        assert accept(client, token, 'owner').status_code == 409
        assert accept(client, token, 'invalid name').status_code == 422
        assert client.post('/api/auth/invitation/accept', json={
            'token': token, 'username': 'invitee', 'password': 'Password1!',
        }).status_code == 422
        with ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(lambda name: accept(client, token, name), ['firstuser', 'seconduser']))
        assert sorted(r.status_code for r in responses) == [200, 410]
        assert next(r for r in responses if r.status_code == 200).json()['status'] == 'pending'


def test_invitation_requires_management_and_csrf(tmp_path):
    with TestClient(create_app(GatewaySettings(data_dir=tmp_path)), base_url='https://gateway.test') as client:
        headers = {'X-CSRF-Token': _setup(client).json()['csrf_token']}
        uid = create_invited(client, headers)
        assert client.post(f'/api/admin/users/{uid}/invitation').status_code == 403
        client.cookies.clear()
        assert client.post(f'/api/admin/users/{uid}/invitation', headers=headers).status_code == 401
        registered = client.post('/api/auth/register', json={
            'username': 'member', 'display_name': 'Member', 'password': 'MemberPassphrase-2026!',
        }).json()
        assert client.post(f'/api/admin/users/{uid}/invitation', headers={
            'X-CSRF-Token': registered['csrf_token'],
        }).status_code == 403


def test_existing_link_survives_restart_and_concurrent_gets(tmp_path):
    settings = GatewaySettings(data_dir=tmp_path)
    with TestClient(create_app(settings), base_url='https://gateway.test') as client:
        headers = {'X-CSRF-Token': _setup(client).json()['csrf_token']}
        uid = create_invited(client, headers)
        token = issue(client, headers, uid)
        with sqlite3.connect(tmp_path / 'workstep_platform.db') as db:
            encrypted = db.execute('SELECT invitation_token_ciphertext FROM users WHERE id=?', (uid,)).fetchone()[0]
            assert token not in encrypted
    with TestClient(create_app(settings), base_url='https://gateway.test') as client:
        headers = {'X-CSRF-Token': client.post('/api/auth/login', json={
            'username': 'owner', 'password': 'OwnerPassphrase-2026!',
        }).json()['csrf_token']}
        with ThreadPoolExecutor(max_workers=2) as pool:
            assert list(pool.map(lambda _: issue(client, headers, uid), range(2))) == [token, token]


@pytest.mark.parametrize('operation', ['password', 'reset-password', 'edit'])
def test_other_password_changes_revoke_an_outstanding_link(tmp_path, operation):
    with TestClient(create_app(GatewaySettings(data_dir=tmp_path)), base_url='https://gateway.test') as client:
        setup = _setup(client).json()
        headers = {'X-CSRF-Token': setup['csrf_token']}
        uid = setup['user']['id']
        token = issue(client, headers, uid)
        if operation == 'password':
            result = client.post('/api/auth/password', headers=headers, json={
                'current_password': 'OwnerPassphrase-2026!', 'new_password': 'UpdatedPassphrase-2026!',
            })
        else:
            assert client.post('/api/auth/step-up', headers=headers,
                               json={'password': 'OwnerPassphrase-2026!'}).status_code == 200
            if operation == 'reset-password':
                result = client.post(f'/api/admin/users/{uid}/reset-password', headers=headers,
                                     json={'new_password': 'UpdatedPassphrase-2026!'})
            else:
                result = client.patch(f'/api/admin/users/{uid}', headers=headers,
                                      json={'display_name': 'Owner', 'new_password': 'UpdatedPassphrase-2026!'})
        assert result.status_code in [200, 204]
        assert accept(client, token, 'owner').status_code == 410


def test_invitation_database_lock_keeps_health_responsive(tmp_path):
    import time
    with TestClient(create_app(GatewaySettings(data_dir=tmp_path)), base_url='https://gateway.test') as client:
        headers = {'X-CSRF-Token': _setup(client).json()['csrf_token']}
        uid = create_invited(client, headers)
        token = issue(client, headers, uid)
        with ThreadPoolExecutor(max_workers=1) as pool:
            with sqlite3.connect(tmp_path / 'workstep_platform.db') as db:
                db.execute('BEGIN EXCLUSIVE')
                pending = pool.submit(accept, client, token)
                time.sleep(.1)
                assert not pending.done()
                started = time.monotonic()
                assert client.get('/api/health').status_code == 200
                assert time.monotonic() - started < .3
                db.rollback()
            assert pending.result(timeout=5).status_code == 200
