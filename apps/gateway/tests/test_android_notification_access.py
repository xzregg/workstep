import asyncio
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from threading import Event
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import update

from gateway.app import create_app
from gateway.config import GatewaySettings
from gateway.models import Device, PlatformProject, ProjectAccessGrant, UserDevice


@pytest.mark.parametrize('whole_device', [True, False])
@pytest.mark.parametrize('target', ['task_id', 'session_id'])
def test_android_destination_rechecks_access_without_collected_notification(tmp_path, monkeypatch, whole_device, target):
    with TestClient(create_app(GatewaySettings(data_dir=tmp_path, public_origin='https://gateway.test')),
                    base_url='https://gateway.test') as client:
        client.post('/api/platform/setup', json=dict(username='owner', display_name='Owner',
            password='OwnerPassphrase-2026!', recovery_username='recovery',
            recovery_password='RecoveryPassphrase-2026!', registration_mode='open'))
        user = client.post('/api/auth/register', json=dict(username='reader', display_name='Reader',
            password='ReaderPassphrase-2026!')).json()['user']['id']

        async def seed():
            async with client.app.state.database.session() as session:
                async with session.begin():
                    session.add(Device(id='one', name='One', public_key='test', status='active', app_instance_id='one', version='1'))
                    if whole_device:
                        session.add(UserDevice(id='assignment', user_id=user, device_id='one', access_level='edit'))
                    else:
                        session.add(PlatformProject(id='published', device_id='one', host_project_id='project',
                            name='演示 & 项目', access_mode='remote_published'))
                        session.add(ProjectAccessGrant(id='grant', project_id='published', subject_type='user',
                            subject_id=user, access_level='read'))

        client.portal.call(seed)
        controls = client.app.state.control_connections
        monkeypatch.setattr(controls, 'is_online', lambda device: device == 'one')
        started = Event()

        async def catalog(device):
            assert device == 'one'
            started.set()
            await asyncio.sleep(0.15)
            return [dict(id='project', name='演示 & 项目')]

        monkeypatch.setattr(controls, 'request_project_catalog', catalog)
        params = dict(project_id='gateway/one/project', **{target: 'target/1'})
        with ThreadPoolExecutor() as pool:
            pending = pool.submit(client.get, '/api/completion-notifications/access', params=params)
            if whole_device:
                assert started.wait(1)
                start = time.monotonic()
                assert client.get('/api/health').status_code == 200
                assert time.monotonic() - start < 0.1
            response = pending.result(2)
        assert response.status_code == 200, response.text
        access = response.json()
        assert access['url'] == 'https://gateway.test/workspace/one/'
        next_page = urlsplit(access['next'])
        assert next_page.path == ('tasks' if target == 'task_id' else 'chat')
        assert parse_qs(next_page.query) == dict(project=['演示 & 项目'], **{'task' if target == 'task_id' else 'session': ['target/1']})
        # Tickets still go through the normal live authorization and redemption checks.
        entered = client.post('/workspace/one/api/remote/redeem',
            data=dict(ticket=access['ticket'], next=access['next']), follow_redirects=False)
        assert entered.status_code == 303
        assert entered.headers['location'].startswith('/workspace/one/' + next_page.path + '?')
        assert client.get('/api/completion-notifications/access', params={**params, 'project_id': 'gateway/one/hidden'}).status_code == 404
        assert client.get('/api/completion-notifications/access', params={**params, 'project_id': 'gateway/other/project'}).status_code == 404
        assert client.get('/api/completion-notifications/access', params={'project_id': params['project_id']}).status_code == 422
        monkeypatch.setattr(controls, 'is_online', lambda _: False)
        assert client.get('/api/completion-notifications/access', params=params).status_code == 409
        monkeypatch.setattr(controls, 'is_online', lambda _: True)

        async def revoke():
            async with client.app.state.database.session() as session:
                async with session.begin():
                    if whole_device:
                        await session.execute(update(UserDevice).values(revoked_at=datetime.now(timezone.utc)))
                    else:
                        await session.execute(update(ProjectAccessGrant).values(revoked_at=datetime.now(timezone.utc)))

        client.portal.call(revoke)
        assert client.get('/api/completion-notifications/access', params=params).status_code == (404 if whole_device else 403)
        assert client.get('/api/completion-notifications/access', params={**params, 'project_id': 'gateway/one/project/extra'}).status_code == 422
