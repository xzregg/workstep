"""Usage summaries and event pages share the auditor's explicit scope."""
from datetime import datetime, timezone
import sqlite3
import pytest
from fastapi.testclient import TestClient
from gateway.app import create_app
from gateway.config import GatewaySettings
from gateway.models import Device
from gateway.usage_ledger import record_usage_batch
from gateway.usage_rollups import advance_rollups
from test_org_api import _setup, _directory


@pytest.mark.parametrize('scope_type', ['department', 'organization', 'device_group'])
def test_auditor_usage_scope_survives_rollup_rebuild_and_filters(tmp_path, monkeypatch, scope_type):
    async def idle(_db, stop):
        await stop.wait()
    monkeypatch.setattr('gateway.app.run_usage_rollups', idle)
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url='https://gateway.test') as client:
        csrf = _setup(client); headers = {'X-CSRF-Token': csrf}
        source = _directory(client, csrf)
        auditor = client.post('/api/admin/users', headers=headers, json={
            'username': 'auditor', 'display_name': 'Auditor', 'password': 'AuditorPassphrase-2026!',
        }).json()['id']
        with sqlite3.connect(tmp_path / 'workstep_platform.db') as db:
            dept = dict(db.execute('SELECT external_id,id FROM directory_departments'))
            users = dict(db.execute('SELECT subject,user_id FROM directory_people'))
        async def seed():
            async with app.state.database.session() as session:
                async with session.begin():
                    session.add(Device(id='visible', name='Visible', public_key='key', status='active', department_id=dept['child']))
                    session.add(Device(id='private', name='Private', public_key='key', status='active', department_id=dept['other']))
        client.portal.call(seed)
        client.post('/api/auth/step-up', headers=headers, json={'password': 'OwnerPassphrase-2026!'})
        group = client.post('/api/admin/device-groups', headers=headers, json={'name': 'PCs'}).json()['id']
        client.put(f'/api/admin/device-groups/{group}/devices/visible', headers=headers)
        scope_id = {'department': dept['root'], 'organization': source, 'device_group': group}[scope_type]
        assert client.post(f'/api/admin/users/{auditor}/roles', headers=headers, json={
            'role': 'audit_admin', 'scope_type': scope_type, 'scope_id': scope_id,
        }).status_code == 201
        for device, person, tokens in [('visible', 'person-b', 10), ('private', 'person-c', 100)]:
            client.portal.call(record_usage_batch, app.state.database, device, device, [{
                'usage_event_id': device, 'user_id': users[person], 'initiated_by_user_id': users[person],
                'input_tokens': tokens, 'output_tokens': 2, 'total_tokens': tokens + 2,
                'occurred_at': datetime.now(timezone.utc).isoformat(),
            }])
        client.cookies.clear()
        csrf = client.post('/api/auth/login', json={'username': 'auditor', 'password': 'AuditorPassphrase-2026!'}).json()['csrf_token']
        client.post('/api/auth/password', headers={'X-CSRF-Token': csrf}, json={
            'current_password': 'AuditorPassphrase-2026!', 'new_password': 'AuditorNewPassphrase-2026!',
        })
        expected = 2 if scope_type == 'organization' else 1
        for rebuilt in (False, True):
            if rebuilt: client.portal.call(advance_rollups, app.state.database)
            response = client.get('/api/admin/usage?group_by=device')
            assert response.status_code == 200, response.text
            assert response.json()['event_count'] == expected
            assert response.json()['group_total'] == expected
            events = client.get('/api/admin/usage/events?page_size=1')
            assert events.status_code == 200, events.text
            assert events.json()['total'] == expected
            assert client.get('/api/admin/usage?device_id=private').json()['event_count'] == (1 if expected == 2 else 0)
        assert client.get('/api/admin/usage/reconciliation?provider_id=provider&from_day=2026-09-01&to_day=2026-09-01').status_code == 403
        assert client.post('/api/admin/usage/provider-bills', headers={'X-CSRF-Token': csrf}, json={'batch_id': 'bill', 'lines': [{'line_id': 'one', 'provider_id': 'provider', 'model': 'model', 'day': '2026-09-01', 'input_tokens': 1, 'output_tokens': 1, 'currency': 'USD', 'billed_cost': '0.01'}]}).status_code == 403
