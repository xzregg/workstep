import sqlite3

from fastapi.testclient import TestClient

from gateway.app import create_app
from gateway.config import GatewaySettings


def _setup(client):
    return client.post('/api/platform/setup', json={
        'username': 'owner', 'display_name': 'Owner', 'password': 'OwnerPassphrase-2026!',
        'recovery_username': 'recovery', 'recovery_password': 'RecoveryPassphrase-2026!',
        'registration_mode': 'closed',
    }).json()['csrf_token']


def _source(client, csrf):
    result = client.post('/api/admin/identity-sources', headers={'X-CSRF-Token': csrf}, json={
        'provider': 'wecom', 'tenant_id': 'tenant-a', 'client_id': 'app',
        'agent_id': '10001', 'secret_env': 'WORKSTEP_TEST_WECOM_SECRET',
    })
    assert result.status_code == 201, result.text
    return result.json()['id']


def test_directory_sync_records_cursor_counts_and_provider_failure(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url='https://gateway.test') as client:
        csrf = _setup(client)
        source_id = _source(client, csrf)
        endpoint = f'/api/admin/identity-sources/{source_id}/sync'
        first = client.post(endpoint, headers={'X-CSRF-Token': csrf}, json={
            'cursor': 'cursor-1',
            'departments': [{'external_id': 'a', 'display_name': 'A'},
                            {'external_id': 'b', 'display_name': 'B'}],
            'people': [{'subject': 'person-1', 'display_name': 'One', 'department_ids': ['a']}],
        })
        assert first.status_code == 200, first.text
        state = client.get('/api/admin/identity-sources').json()['sources'][0]['sync_state']
        assert state['cursor'] == 'cursor-1'
        assert state['last_success_at'] is not None
        assert state['last_error_code'] is None
        assert state['changes']['departments_added'] == 2
        assert state['changes']['people_added'] == 1

        second = client.post(endpoint, headers={'X-CSRF-Token': csrf}, json={
            'cursor': 'cursor-2',
            'departments': [{'external_id': 'a', 'display_name': 'A renamed'},
                            {'external_id': 'c', 'display_name': 'C'}],
            'people': [{'subject': 'person-1', 'display_name': 'One renamed', 'department_ids': ['c']},
                       {'subject': 'person-2', 'display_name': 'Two', 'department_ids': ['a']}],
        })
        assert second.status_code == 200, second.text
        state = client.get('/api/admin/identity-sources').json()['sources'][0]['sync_state']
        assert state['cursor'] == 'cursor-2'
        assert {key: state['changes'][key] for key in ('departments_added', 'departments_updated', 'departments_moved', 'departments_deleted', 'people_added', 'people_updated', 'people_transferred', 'people_departed')} == {
            'departments_added': 1, 'departments_updated': 1, 'departments_moved': 0,
            'departments_deleted': 1, 'people_added': 1, 'people_updated': 1,
            'people_transferred': 1, 'people_departed': 0,
        }
        last_success = state['last_success_at']

        invalid = client.post(endpoint, headers={'X-CSRF-Token': csrf}, json={
            'departments': [{'external_id': 'a', 'display_name': 'A'},
                            {'external_id': 'a', 'display_name': 'Duplicate'}],
            'people': [],
        })
        assert invalid.status_code == 422
        assert client.get('/api/admin/identity-sources').json()['sources'][0]['sync_state']['last_error_code'] == 'snapshot_invalid'

        class BrokenConnector:
            async def fetch_directory(self, _source, *, selected_department_ids=None):
                raise RuntimeError('private provider detail')

        app.state.identity_connectors['wecom'] = BrokenConnector()
        from gateway.models import PlatformSetting
        from gateway.services.organization_settings import option_key
        async def choose_scope():
            async with app.state.database.session() as session:
                async with session.begin():
                    row = await session.get(PlatformSetting, option_key(source_id))
                    options = __import__('json').loads(row.value_json)
                    options['selected_department_ids'] = ['a']
                    row.value_json = __import__('json').dumps(options)
        client.portal.call(choose_scope)
        result = client.post(f'/api/admin/identity-sources/{source_id}/reconcile',
                             headers={'X-CSRF-Token': csrf})
        assert result.status_code == 502
        state = client.get('/api/admin/identity-sources').json()['sources'][0]['sync_state']
        assert state['last_error_code'] == 'provider_unavailable'
        assert state['last_success_at'] == last_success
        assert 'private provider detail' not in str(state)
        with sqlite3.connect(tmp_path / 'workstep_platform.db') as connection:
            connection.execute("""INSERT INTO directory_event_receipts
                (id, source_id, event_id, status) VALUES ('receipt-1', ?, 'event-1', 'pending')""", (source_id,))
        source = client.get('/api/admin/identity-sources').json()['sources'][0]
        assert source['pending_callbacks'] == 1
        assert source['oldest_pending_at'] is not None
        assert source['pending_delay_seconds'] >= 0
