"""Routine metadata writes keep role/CSRF checks without demanding fresh passwords."""
from fastapi.testclient import TestClient
from gateway.app import create_app
from gateway.config import GatewaySettings
from gateway.models import Device
from test_external_identity import _setup


def test_routine_writes_without_step_up_keep_sensitive_operations_protected(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url='https://gateway.test') as client:
        headers = {'X-CSRF-Token': _setup(client)}

        async def seed():
            async with app.state.database.session() as session:
                async with session.begin():
                    session.add(Device(id='pc', name='PC', public_key='key', status='active'))
        client.portal.call(seed)
        for path, method, body, expected in [
            ('/api/groups', 'post', {'name': '空组', 'slug': 'empty'}, 201),
            ('/api/admin/device-groups', 'post', {'name': '空设备组'}, 201),
            ('/api/admin/devices/pc/name', 'put', {'name': '新名称'}, 204),
            ('/api/admin/company-display-name', 'put', {'company_display_name': '演示'}, 200),
        ]:
            assert getattr(client, method)(path, json=body).status_code == 403
            response = getattr(client, method)(path, headers=headers, json=body)
            assert response.status_code == expected, response.text
        group = client.get('/api/admin/device-groups').json()['groups'][0]['id']
        assert client.put(f'/api/admin/device-groups/{group}/devices/pc', headers=headers).status_code == 403
        assert client.post('/api/admin/devices/pc/disable', headers=headers).status_code == 403
        assert client.put('/api/admin/platform-address', headers=headers, json={'public_origin': 'https://example.test'}).status_code == 403
        client.cookies.clear()
        assert client.post('/api/groups', headers=headers, json={'name': '空组', 'slug': 'other'}).status_code == 401
