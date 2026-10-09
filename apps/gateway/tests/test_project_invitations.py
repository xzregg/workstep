import asyncio
import base64
import json
from time import monotonic

import pytest
from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from gateway.app import create_app
from gateway.config import GatewaySettings
from gateway.models import Device, PlatformProject, ProjectAccessGrant, User, AuditEvent


PASSWORD = 'OwnerPassphrase-2026!'


def prepare(client, app):
    app.state.identity_rate_limiter.limit = 100
    setup = client.post('/api/platform/setup', json={
        'username': 'admin', 'display_name': 'Admin', 'password': PASSWORD,
        'recovery_username': 'recovery', 'recovery_password': 'RecoveryPassphrase-2026!',
        'registration_mode': 'open',
    })
    headers = {'X-CSRF-Token': setup.json()['csrf_token']}
    client.post('/api/auth/step-up', json={'password': PASSWORD}, headers=headers)
    ids = {}
    for username in ('owner', 'guest', 'outsider'):
        ids[username] = client.post('/api/admin/users', json={
            'username': username, 'display_name': username, 'password': PASSWORD,
        }, headers=headers).json()['id']

    async def seed():
        async with app.state.database.session() as session, session.begin():
            for user_id in ids.values():
                user = await session.get(User, user_id)
                user.must_change_password = user_id == ids['guest']  # legacy flag no longer gates account access
            session.add(Device(id='device-1', name='Owner PC', public_key='test',
                               owner_user_id=ids['owner'], status='active'))
            session.add(PlatformProject(id='project-1', device_id='device-1',
                                        host_project_id='host-1', name='Demo',
                                        access_mode='remote_published'))
            session.add(PlatformProject(id='private', device_id='device-1',
                                        host_project_id='host-private', name='Private'))
    client.portal.call(seed)
    return ids


def login(client, username):
    client.cookies.clear()
    result = client.post('/api/auth/login', json={'username': username, 'password': PASSWORD})
    return {'X-CSRF-Token': result.json()['csrf_token']}


def create_invitation(client, headers, **extra):
    response = client.post('/api/projects/project-1/invitations', headers=headers,
                           json={'access_level': 'edit', **extra})
    assert response.status_code == 201, response.text
    body = response.json()
    assert body['url'].startswith('https://gateway.test/project-invitations/')
    return body, body['url'].rsplit('/', 1)[1]


def test_owner_invites_guest_without_device_and_admin_can_revoke(tmp_path, monkeypatch):
    app = create_app(GatewaySettings(data_dir=tmp_path, public_origin='https://gateway.test'))
    with TestClient(app, base_url='https://gateway.test') as client:
        ids = prepare(client, app)
        headers = login(client, 'owner')
        assert client.get('/api/project-invitations/projects').json()['projects'][0]['id'] == 'project-1'
        assert client.post('/api/projects/private/invitations', headers=headers,
                           json={'access_level': 'edit'}).status_code == 404
        assert client.post('/api/projects/project-1/invitations',
                           json={'access_level': 'edit'}).status_code == 403
        invitation, token = create_invitation(client, headers)
        listed = client.get('/api/projects/project-1/invitations').json()['invitations']
        assert listed[0]['id'] == invitation['id']
        assert 'url' not in listed[0] and 'token_hash' not in listed[0]

        guest_headers = login(client, 'guest')
        assert client.get('/api/devices').json()['devices'] == []
        assert client.post('/api/projects/project-1/invitations', headers=guest_headers,
                           json={'access_level': 'edit'}).status_code == 403
        assert client.get('/api/projects/project-1/invitations').status_code == 403
        preview = client.get(f'/api/project-invitations/{token}')
        assert preview.json()['project_name'] == 'Demo'
        assert client.get('/api/projects').json()['projects'] == []  # preview grants nothing
        assert client.post(f'/api/project-invitations/{token}/accept').status_code == 403
        accepted = client.post(f'/api/project-invitations/{token}/accept', headers=guest_headers)
        assert accepted.status_code == 200, accepted.text
        assert accepted.json()['access_level'] == 'edit'
        assert client.post(f'/api/project-invitations/{token}/accept', headers=guest_headers).status_code == 200
        assert client.get('/api/projects').json()['projects'][0]['grant_sources'] == ['项目邀请']
        assert client.get('/api/devices/device-1/access').status_code == 403
        monkeypatch.setattr(app.state.control_connections, 'is_online', lambda _: True)
        access = client.get('/api/projects/project-1/access').json()
        claims = json.loads(base64.urlsafe_b64decode(access['ticket'].split('.')[1] + '==='))
        assert claims['host_project_id'] == 'host-1'
        assert claims['access_level'] == 'edit'
        host = 'https://d-device-1.gateway.test'
        assert client.post(f'{host}/api/remote/redeem', data={'ticket': access['ticket']},
                           follow_redirects=False).status_code == 303
        remote_cookie = client.cookies.get('workstep_gateway_session', domain='d-device-1.gateway.test')
        assert client.get(f'{host}/api/remote/session').status_code == 200

        admin_headers = login(client, 'admin')
        client.post('/api/auth/step-up', json={'password': PASSWORD}, headers=admin_headers)
        records = client.get('/api/admin/projects/project-1/invitations').json()
        assert len(records['invitations'][0]['members']) == 1
        assert records['invitations'][0]['members'][0]['user_id'] == ids['guest']
        assert records['invitations'][0]['created_by'] == 'owner'
        assert client.delete(f"/api/admin/projects/project-1/grants/user/{ids['guest']}",
                             headers=admin_headers).status_code == 204
        assert client.get(f'{host}/api/remote/session', headers={
            'Cookie': f'workstep_gateway_session={remote_cookie}',
        }).status_code == 403
        records = client.get('/api/admin/projects/project-1/invitations').json()
        assert records['invitations'][0]['members'][0]['status'] == 'blocked'
        guest_headers = login(client, 'guest')
        assert client.get('/api/projects').json()['projects'] == []
        assert client.post(f'/api/project-invitations/{token}/accept', headers=guest_headers).status_code == 403
        # A new owner link cannot undo an administrator's revocation.
        new_invitation, new_token = create_invitation(client, login(client, 'owner'))
        guest_headers = login(client, 'guest')
        assert client.post(f'/api/project-invitations/{new_token}/accept', headers=guest_headers).status_code == 403

        async def check_records():
            async with app.state.database.session() as session:
                grants = (await session.scalars(select(ProjectAccessGrant))).all()
                assert len(grants) == 1
                events = (await session.scalars(select(AuditEvent).where(
                    AuditEvent.action == 'project.invitation_accepted'))).all()
                assert len(events) == 1
        client.portal.call(check_records)
        admin_headers = login(client, 'admin')
        client.post('/api/auth/step-up', json={'password': PASSWORD}, headers=admin_headers)
        # Only explicit administrator authorization can lift the invitation block.
        assert client.post('/api/admin/projects/project-1/grants', headers=admin_headers, json={
            'subject_type': 'user', 'subject_id': ids['guest'], 'access_level': 'read',
        }).status_code == 200
        guest_headers = login(client, 'guest')
        restored = client.post(f'/api/project-invitations/{new_token}/accept', headers=guest_headers)
        assert restored.status_code == 200
        assert restored.json()['access_level'] == 'read'  # invitation cannot upgrade admin's grant


def test_admin_can_disable_join_pause_and_revoke_invitation(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path, public_origin='https://gateway.test'))
    with TestClient(app, base_url='https://gateway.test') as client:
        prepare(client, app)
        invitation, token = create_invitation(client, login(client, 'owner'), access_level='read')
        admin = login(client, 'admin')
        client.post('/api/auth/step-up', json={'password': PASSWORD}, headers=admin)
        base = f"/api/admin/projects/project-1/invitations/{invitation['id']}"
        assert client.post(base + '/pause', headers=admin).status_code == 200
        guest = login(client, 'guest')
        assert client.post(f'/api/project-invitations/{token}/accept', headers=guest).status_code == 410
        owner = login(client, 'owner')
        assert client.post(f"/api/projects/project-1/invitations/{invitation['id']}/resume", headers=owner).status_code in (404, 405)
        admin = login(client, 'admin')
        client.post('/api/auth/step-up', json={'password': PASSWORD}, headers=admin)
        assert client.post(base + '/resume', headers=admin).status_code == 200
        assert client.put('/api/admin/projects/project-1/invitation-policy', headers=admin,
                          json={'enabled': False}).status_code == 200
        guest = login(client, 'guest')
        assert client.post(f'/api/project-invitations/{token}/accept', headers=guest).status_code == 403
        owner = login(client, 'owner')
        assert client.post('/api/projects/project-1/invitations', headers=owner,
                           json={'access_level': 'edit'}).status_code == 403
        admin = login(client, 'admin')
        client.post('/api/auth/step-up', json={'password': PASSWORD}, headers=admin)
        assert client.put('/api/admin/projects/project-1/invitation-policy', headers=admin,
                          json={'enabled': True}).status_code == 200
        guest = login(client, 'guest')
        assert client.post(f'/api/project-invitations/{token}/accept', headers=guest).json()['access_level'] == 'read'
        admin = login(client, 'admin')
        client.post('/api/auth/step-up', json={'password': PASSWORD}, headers=admin)
        assert client.post(base + '/revoke', headers=admin).status_code == 200
        assert client.post(base + '/resume', headers=admin).status_code == 409
        guest = login(client, 'guest')
        assert client.get('/api/projects').json()['projects'] == []
        assert client.post(f'/api/project-invitations/{token}/accept', headers=guest).status_code == 410


def test_expired_unpublished_and_invalid_invites_do_not_grant_access(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path, public_origin='https://gateway.test'))
    with TestClient(app, base_url='https://gateway.test') as client:
        prepare(client, app)
        owner = login(client, 'owner')
        assert client.post('/api/projects/project-1/invitations', headers=owner, json={
            'access_level': 'edit', 'expires_at': '2000-01-01T00:00:00Z',
        }).status_code == 422
        _, token = create_invitation(client, owner)
        async def unpublish():
            from gateway.services.project_publication import record_project_publication
            await record_project_publication(app.state.database, device_id='device-1',
                                            user_id='admin', host_project_id='host-1',
                                            name='Demo', action='unpublish')
        client.portal.call(unpublish)
        guest = login(client, 'guest')
        assert client.post(f'/api/project-invitations/{token}/accept', headers=guest).status_code == 404
        assert client.post('/api/project-invitations/' + 'a' * 43 + '/accept', headers=guest).status_code == 404
        assert client.get('/api/projects').json()['projects'] == []


def test_concurrent_accepts_are_idempotent_and_old_owner_links_expire(tmp_path):
    from datetime import datetime, timezone, timedelta
    from gateway.models import ProjectInvitation
    app = create_app(GatewaySettings(data_dir=tmp_path, public_origin='https://gateway.test'))
    with TestClient(app, base_url='https://gateway.test') as client:
        ids = prepare(client, app)
        invitation, token = create_invitation(client, login(client, 'owner'))
        headers = login(client, 'guest')
        cookies = dict(client.cookies)

        async def join_twice():
            async with AsyncClient(transport=ASGITransport(app=app), base_url='https://gateway.test', cookies=cookies) as http:
                responses = await asyncio.gather(*[http.post(
                    f'/api/project-invitations/{token}/accept', headers=headers) for _ in range(2)])
                assert [r.status_code for r in responses] == [200, 200]
            async with app.state.database.session() as session:
                assert len((await session.scalars(select(ProjectAccessGrant))).all()) == 1
        client.portal.call(join_twice)

        async def expire():
            async with app.state.database.session() as session, session.begin():
                row = await session.get(ProjectInvitation, invitation['id'])
                row.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        client.portal.call(expire)
        assert client.get(f'/api/project-invitations/{token}').status_code == 410
        # Invite expiry closes joining, without expiring a previously granted membership.
        assert len(client.get('/api/projects').json()['projects']) == 1
        _, owner_token = create_invitation(client, login(client, 'owner'))

        async def transfer():
            async with app.state.database.session() as session, session.begin():
                device = await session.get(Device, 'device-1')
                device.owner_user_id = ids['outsider']
        client.portal.call(transfer)
        headers = login(client, 'guest')
        assert client.post(f'/api/project-invitations/{owner_token}/accept', headers=headers).status_code == 410


@pytest.mark.asyncio
async def test_invitation_accept_sqlite_lock_keeps_health_responsive(tmp_path):
    # Exercise the actual HTTP write path with SQLite lock contention.
    app = create_app(GatewaySettings(data_dir=tmp_path, public_origin='https://gateway.test'))
    with TestClient(app, base_url='https://gateway.test') as client:
        prepare(client, app)
        _, token = create_invitation(client, login(client, 'owner'))
        headers = login(client, 'guest')
        cookies = dict(client.cookies)
        async def canary():
            async with AsyncClient(transport=ASGITransport(app=app), base_url='https://gateway.test', cookies=cookies) as http:
                async with app.state.database.engine.connect() as lock:
                    await lock.exec_driver_sql('BEGIN IMMEDIATE')
                    blocked = asyncio.create_task(http.post(f'/api/project-invitations/{token}/accept', headers=headers))
                    try:
                        await asyncio.sleep(0.1)
                        assert not blocked.done()
                        start = monotonic()
                        assert (await http.get('/api/health')).status_code == 200
                        assert monotonic() - start < 0.3
                    finally:
                        await lock.rollback()
                    assert (await blocked).status_code == 200
        client.portal.call(canary)
