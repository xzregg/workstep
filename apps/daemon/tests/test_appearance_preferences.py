import asyncio
import time
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from services.appearance_preferences import identity_scope


def application(tmp_path, monkeypatch, *, user='alice', gateway='gateway', device='device'):
    from api import appearance
    from services.appearance_preferences import AppearancePreferences
    monkeypatch.setattr(appearance, 'preferences', AppearancePreferences(tmp_path))
    app = FastAPI()
    app.state.gateway_client = SimpleNamespace(managed_config=SimpleNamespace(gateway_id=gateway))

    @app.middleware('http')
    async def actor(request, call_next):
        # Simulate the identity installed by DesktopSecurityMiddleware, never headers.
        if user:
            request.state.managed_actor = SimpleNamespace(user_id=user, device_id=device)
        return await call_next(request)

    app.include_router(appearance.router)

    @app.get('/health')
    async def health():
        return {'ok': True}

    return app


@pytest.mark.asyncio
async def test_identity_isolation_restart_and_shared_selection(tmp_path, monkeypatch):
    async def call(user, gateway='gateway', device='device', patch=None):
        app = application(tmp_path, monkeypatch, user=user, gateway=gateway, device=device)
        async with AsyncClient(transport=ASGITransport(app), base_url='http://test') as client:
            if patch is not None:
                return await client.patch('/api/appearance/preferences', json=patch, headers={'X-Appearance-Scope': identity_scope(gateway, device, user)})
            return await client.get('/api/appearance/preferences')

    first = (await call('alice')).json()
    assert first['preferences']['skin_id'] == 'default'
    assert (await call('alice', patch={'skin_id': 'ocean', 'font_size': 'large', 'language': 'pack:spanish'})).status_code == 200
    assert (await call('bob', patch={'skin_id': 'ocean', 'font_family': 'serif'})).status_code == 200
    assert (await call('alice')).json()['preferences']['font_size'] == 'large'
    assert (await call('bob')).json()['preferences']['font_size'] == 'standard'
    assert (await call('alice', device='another')).json()['preferences']['skin_id'] == 'default'
    assert (await call('alice', gateway='another')).json()['preferences']['skin_id'] == 'default'
    assert (await call('alice', patch={'font_size': 'small'})).json()['preferences']['skin_id'] == 'ocean'
    assert (await call('alice')).json()['scope'] == first['scope']


@pytest.mark.asyncio
async def test_forged_identity_and_invalid_fields_are_rejected(tmp_path, monkeypatch):
    app = application(tmp_path, monkeypatch, user=None)
    async with AsyncClient(transport=ASGITransport(app), base_url='http://test') as client:
        assert (await client.get('/api/appearance/preferences', headers={'X-WorkStep-Actor-Id': 'alice'})).json()['scope'] is None
        assert (await client.patch('/api/appearance/preferences', json={'skin_id': 'ocean'}, headers={'X-WorkStep-Actor-Id': 'alice'})).status_code == 403
    app = application(tmp_path, monkeypatch)
    async with AsyncClient(transport=ASGITransport(app), base_url='http://test', headers={'X-Appearance-Scope': identity_scope('gateway', 'device', 'alice')}) as client:
        for invalid in ({'user_id': 'bob'}, {'font_size': 'huge'}, {'skin_id': '../other'}, {'language': 'unknown'}, {'font_family': None}):
            assert (await client.patch('/api/appearance/preferences', json=invalid)).status_code == 422
        assert (await client.patch('/api/appearance/preferences?user_id=bob', json={'skin_id': 'ocean'})).status_code == 400
        assert (await client.patch('/api/appearance/preferences', json={'skin_id': 'ocean'}, headers={'X-Appearance-Scope': identity_scope('gateway', 'device', 'bob')})).status_code == 409
        assert (await client.get('/api/appearance/preferences')).json()['preferences']['skin_id'] == 'default'


@pytest.mark.asyncio
async def test_readonly_project_selection_passes_the_real_authenticated_device_bridge(tmp_path, monkeypatch):
    import base64
    import json
    from api import appearance
    from api.desktop_security import DesktopSecurityMiddleware
    from services.appearance_preferences import AppearancePreferences
    from services.gateway_client.bridge import ManagedHttpBridge
    from workstep_gateway_protocol import FrameType, ProxyFrame

    async def audit(*args):
        pass

    monkeypatch.setattr('api.desktop_security.record_remote_request_failure', audit)
    monkeypatch.setattr(appearance, 'preferences', AppearancePreferences(tmp_path))
    app = FastAPI()
    app.state.gateway_client = SimpleNamespace(managed_config=SimpleNamespace(gateway_id='gateway'))
    app.add_middleware(DesktopSecurityMiddleware)
    app.include_router(appearance.router)

    async def call(user, method='GET', patch=None):
        frames = []

        async def capture(frame):
            frames.append(frame)

        scope = identity_scope('gateway', 'device', user)
        bridge = ManagedHttpBridge(app, 'appearance', {
            'method': method, 'path': '/api/appearance/preferences', 'query': '',
            'headers': [['content-type', 'application/json'], ['X-Appearance-Scope', scope]],
            'user_id': user, 'username': user, 'project_id': 'project', 'access_level': 'read',
        }, capture, 'device')
        bridge.start_task()
        if patch is not None:
            await bridge.feed(ProxyFrame(stream_id='appearance', type=FrameType.http_request, payload={
                'phase': 'body', 'data': base64.b64encode(json.dumps(patch).encode()).decode(),
            }))
            await bridge.feed(ProxyFrame(stream_id='appearance', type=FrameType.http_request, payload={'phase': 'end'}))
        await asyncio.wait_for(bridge._task, 2)
        assert frames[0].payload['status'] == 200
        body = b''.join(base64.b64decode(frame.payload['data']) for frame in frames if frame.payload.get('phase') == 'body')
        return json.loads(body)

    assert (await call('alice', 'PATCH', {'skin_id': 'ocean'}))['preferences']['skin_id'] == 'ocean'
    assert (await call('bob'))['preferences']['skin_id'] == 'default'
    assert (await call('alice'))['preferences']['skin_id'] == 'ocean'


@pytest.mark.asyncio
async def test_slow_disk_api_keeps_health_responsive_and_merges_concurrent_fields(tmp_path, monkeypatch):
    from api import appearance
    app = application(tmp_path, monkeypatch)
    original = appearance.preferences.update

    def slow(*args):
        time.sleep(.25)
        return original(*args)

    monkeypatch.setattr(appearance.preferences, 'update', slow)
    async with AsyncClient(transport=ASGITransport(app), base_url='http://test', headers={'X-Appearance-Scope': identity_scope('gateway', 'device', 'alice')}) as client:
        pending = asyncio.create_task(client.patch('/api/appearance/preferences', json={'font_size': 'large'}))
        await asyncio.sleep(.05)
        assert (await asyncio.wait_for(client.get('/health'), .1)).json()['ok']
        other = asyncio.create_task(client.patch('/api/appearance/preferences', json={'font_family': 'serif'}))
        assert (await pending).status_code == (await other).status_code == 200
        result = (await client.get('/api/appearance/preferences')).json()['preferences']
        assert result['font_size'] == 'large' and result['font_family'] == 'serif'
