import sqlite3
from datetime import datetime
from fastapi.testclient import TestClient
from sqlalchemy import text
from gateway.app import create_app
from gateway.config import GatewaySettings
from gateway.models import (Device, PlatformProject, PlatformShare, PlatformShareSession,
    ProjectAccessGrant, CapabilityAssignment, GroupDevice, UserGroup, GroupProject,
    GroupCapabilityAssignment, CompletionNotification)
from test_desktop_authorization import _setup, _authorize, _redeem, _public_key


def test_device_deletion_removes_related_registration_without_touching_other_devices(tmp_path):
    with TestClient(create_app(GatewaySettings(data_dir=tmp_path, gateway_id='gateway-test')),
                    base_url='https://gateway.test') as client:
        csrf = _setup(client); headers = {'X-CSRF-Token': csrf}
        key = _public_key()
        device_id = _redeem(client, _authorize(client, csrf), key).json()['device']['id']
        user_id = client.get('/api/auth/session').json()['user']['id']

        async def seed():
            async with client.app.state.database.engine.begin() as connection:
                await connection.execute(text('PRAGMA foreign_keys=ON'))
            async with client.app.state.database.session() as session:
                async with session.begin():
                    session.add_all([Device(id='other', name='Other PC', public_key='other-key', status='active'),
                        UserGroup(id='group', name='Team', slug='team', created_by_user_id=user_id),
                        PlatformProject(id='project', device_id=device_id, host_project_id='local-project', name='Demo'),
                        PlatformProject(id='other-project', device_id='other', host_project_id='other', name='Other')])
                    await session.flush()
                    session.add(PlatformShare(id='share', token_hash='old-share', device_id=device_id,
                        project_id='project', task_id='task', mode='read', title='Demo', created_by_user_id=user_id))
                    await session.flush()
                    session.add_all([PlatformShareSession(id='session', share_id='share', session_token_hash='old-session',
                        expires_at=datetime(2030, 1, 1)),
                        ProjectAccessGrant(id='grant', project_id='project', subject_type='user', subject_id=user_id, access_level='read'),
                        GroupDevice(id='group-device', group_id='group', device_id=device_id),
                        GroupProject(id='group-project', group_id='group', platform_project_id='project', assigned_by_user_id=user_id),
                        GroupCapabilityAssignment(id='group-capability', group_id='group', project_id='project',
                            capability='task.create', effect='allow', assigned_by_user_id=user_id),
                        CapabilityAssignment(id='cap-device', user_id=user_id, capability='task.create',
                            scope_type='device', scope_id=device_id, effect='allow', assigned_by_user_id=user_id),
                        CapabilityAssignment(id='cap-project', user_id=user_id, capability='task.create',
                            scope_type='project', scope_id='project', effect='allow', assigned_by_user_id=user_id),
                        CompletionNotification(event_key='event', device_id=device_id, host_project_id='local-project',
                            project_name='Demo', payload_json='{}', occurred_at=1)])

        client.portal.call(seed)
        client.post('/api/auth/step-up', headers=headers, json={'password': 'OwnerPassphrase-2026!'})
        assert client.delete(f'/api/admin/devices/{device_id}', headers=headers).status_code == 204
        assert [row['id'] for row in client.get('/api/admin/devices').json()['devices']] == ['other']
        with sqlite3.connect(tmp_path / 'workstep_platform.db') as connection:
            assert connection.execute('PRAGMA foreign_key_check').fetchall() == []
            assert connection.execute('SELECT id FROM platform_projects').fetchall() == [('other-project',)]
            for table in ('platform_shares', 'platform_share_sessions', 'project_access_grants', 'group_devices',
                          'group_projects', 'group_capability_assignments', 'capability_assignments', 'completion_notifications'):
                assert connection.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0] == 0
