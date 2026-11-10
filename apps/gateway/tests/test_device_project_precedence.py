from fastapi.testclient import TestClient
import pytest
from gateway.app import create_app
from gateway.config import GatewaySettings
from gateway.contracts import JsonValue
from gateway.models import Device, PlatformProject, ProjectAccessGrant, UserDevice, UserGroup, GroupMembership, GroupDevice
from gateway.services.identity import _now


@pytest.mark.parametrize("group_grant", [False, True])
def test_device_grant_takes_precedence_and_revocation_restores_project_scope(tmp_path, monkeypatch, group_grant):
    app = create_app(GatewaySettings(data_dir=tmp_path, public_origin="https://gateway.test"))
    with TestClient(app, base_url="https://gateway.test") as client:
        client.post('/api/platform/setup', json={'username':'owner','display_name':'Owner','password':'OwnerPassphrase-2026!','recovery_username':'recovery','recovery_password':'RecoveryPassphrase-2026!','registration_mode':'open'})
        user_id = client.post('/api/auth/register', json={'username':'worker','display_name':'Worker','password':'WorkerPassphrase-2026!'}).json()['user']['id']
        async def seed():
            async with app.state.database.session() as session:
                async with session.begin():
                    session.add(Device(id='one', name='One', public_key='test', status='active'))
                    session.add(PlatformProject(id='project', device_id='one', host_project_id='host', name='Project', access_mode='remote_published'))
                    session.add(ProjectAccessGrant(id='project-grant', project_id='project', subject_type='user', subject_id=user_id, access_level='read'))
        client.portal.call(seed)
        monkeypatch.setattr(app.state.control_connections, 'is_online', lambda _: True)
        class Data:
            async def proxy_http(self, call, **identity):
                return JsonValue({'device_owner': identity.get('device_owner', False), 'project_id': identity.get('project_id')})
        async def data(_): return Data()
        monkeypatch.setattr(app.state.control_connections, 'request_data', data)
        access = client.get('/api/projects/project/access').json()
        root = '/workspace/one'
        assert client.post(root+'/api/remote/redeem', data={'ticket':access['ticket']}, follow_redirects=False).status_code == 303
        assert client.get(root+'/api/remote/session').json()['project_id'] == 'project'
        assert client.post(root+'/api/project/init', json={'path':'/data/projects/new'}).status_code == 403
        async def grant():
            async with app.state.database.session() as session:
                async with session.begin():
                    if group_grant:
                        session.add(UserGroup(id='team', name='Team', slug='team', status='active'))
                        session.add(GroupMembership(id='member', group_id='team', user_id=user_id))
                        session.add(GroupDevice(id='device-grant', group_id='team', device_id='one'))
                    else:
                        session.add(UserDevice(id='device-grant', user_id=user_id, device_id='one', access_level='edit'))
        client.portal.call(grant)
        current = client.get(root+'/api/remote/session').json()
        assert current['workspace_scope'] == 'device'
        assert current['project_id'] is None
        assert current['host_project_id'] is None
        assert 'projects' not in current
        assert client.get(root+'/api/remote/session?project_id=host').json()['workspace_scope'] == 'device'
        created = client.post(root+'/api/project/init', json={'path':'/data/projects/new'})
        assert created.status_code == 200, created.text
        assert created.json() == {'device_owner':True, 'project_id':None}
        async def revoke():
            async with app.state.database.session() as session:
                async with session.begin():
                    row = await session.get(GroupDevice if group_grant else UserDevice, 'device-grant')
                    row.revoked_at = _now()
        client.portal.call(revoke)
        restored = client.get(root+'/api/remote/session').json()
        assert restored['workspace_scope'] == 'project'
        assert restored['project_id'] == 'project'
        assert restored['access_level'] == 'read'
        assert client.post(root+'/api/project/init', json={'path':'/data/projects/new'}).status_code == 403
