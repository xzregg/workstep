"""One permission matrix for current APIs and future host features."""
from types import SimpleNamespace

import pytest
from fastapi import Depends, FastAPI, Request
from httpx import ASGITransport, AsyncClient

from services.remote_access import ActorSnapshot, actor_context


@pytest.mark.asyncio
@pytest.mark.parametrize('kind,host,local', [
    ('local', 200, 200), ('desktop', 200, 200),
    ('rtc', 200, 403), ('rtc-forged', 403, 403), ('rtc-no-owner', 403, 403),
    ('gateway-owner', 200, 403), ('gateway-project', 403, 403), ('gateway-guest', 403, 403),
    ('project', 403, 403), ('share', 403, 403),
    ('remote', 403, 403), ('lan-locked', 403, 403),
    ('lan-unlocked', 200, 403), ('lan-disabled', 403, 403),
])
async def test_future_host_routes_inherit_shared_permissions(monkeypatch, kind, host, local):
    from api.workspace_access import require_host_workspace, require_local_device
    from services.webrtc_p2p.bridge import WebRtcRemoteActor
    monkeypatch.setenv('WORKSTEP_DESKTOP_RUNTIME', '1')
    monkeypatch.setenv('WORKSTEP_DESKTOP_TOKEN', 'desktop-token')
    app = FastAPI()
    app.state.webrtc_scope_token = object()
    app.state.remote_access_service = SimpleNamespace(
        settings=lambda: {'enabled': kind != 'lan-disabled'},
        access_password_required=lambda: True,
        verify_access_token=lambda value: value == 'valid-access',
    )

    @app.middleware('http')
    async def identity(request, call_next):
        actor = None
        if kind.startswith('rtc'):
            request.scope.update(webrtc_remote_actor=WebRtcRemoteActor('rtc', 'RTC', 'device'),
                                 webrtc_device_owner=kind != 'rtc-no-owner',
                                 webrtc_bridge_token=app.state.webrtc_scope_token if kind != 'rtc-forged' else object())
            actor = ActorSnapshot('rtc', 'Owner', 'device', 'Device', 'remote', access_source='webrtc_p2p')
        elif kind.startswith('gateway'):
            project = 'project' if kind == 'gateway-project' else None
            request.scope.update(gateway_remote_actor=SimpleNamespace(project_id=project), gateway_device_owner=kind == 'gateway-owner')
            actor = ActorSnapshot('owner', 'Owner', 'device', 'Device', 'managed', project_id=project)
        elif kind in ('project', 'remote'):
            actor = ActorSnapshot('user', 'User', 'device', 'Device', 'remote', project_id='project' if kind == 'project' else None)
        elif kind == 'share':
            request.scope['gateway_share_scope'] = {}
        with actor_context(actor):
            return await call_next(request)

    @app.get('/future-host-feature', dependencies=[Depends(require_host_workspace)])
    async def future_host():
        return {'ok': True}

    @app.get('/future-local-feature', dependencies=[Depends(require_local_device)])
    async def future_local():
        return {'ok': True}

    peer = '127.0.0.1' if kind in ('local', 'project', 'share') else '192.0.2.5'
    headers = {'X-WorkStep-Desktop-Token': 'desktop-token'} if kind == 'desktop' else {}
    if kind == 'lan-unlocked':
        headers['x-workstep-access'] = 'valid-access'
    async with AsyncClient(transport=ASGITransport(app=app, client=(peer, 123)), base_url='http://localhost', headers=headers) as client:
        assert (await client.get('/future-host-feature')).status_code == host
        assert (await client.get('/future-local-feature')).status_code == local


@pytest.mark.asyncio
async def test_native_access_password_io_does_not_block_event_loop():
    import asyncio
    import threading
    from api.workspace_access import require_host_workspace
    entered, release = threading.Event(), threading.Event()
    app = FastAPI()
    def settings():
        entered.set()
        release.wait(3)
        return {'enabled': True}
    app.state.remote_access_service = SimpleNamespace(settings=settings, access_password_required=lambda: False)
    @app.get('/host', dependencies=[Depends(require_host_workspace)])
    async def host(): return {'ok': True}
    @app.get('/health')
    async def health(): return {'ok': True}
    async with AsyncClient(transport=ASGITransport(app=app, client=('192.0.2.5', 123)), base_url='http://localhost') as client:
        pending = asyncio.create_task(client.get('/host'))
        try:
            assert await asyncio.to_thread(entered.wait, 1)
            assert (await asyncio.wait_for(client.get('/health'), .2)).status_code == 200
        finally:
            release.set()
        assert (await pending).status_code == 200


def test_feature_apis_cannot_reintroduce_transport_permission_checks():
    """Guard module ownership, so adding an API cannot copy a transport deny rule."""
    import ast
    from pathlib import Path
    boundary_modules = {'workspace_access.py', 'desktop_security.py', 'remote_access_guard.py'}
    forbidden_names = {'webrtc_device_owner', 'gateway_device_owner', 'desktop_runtime_authenticated', '_is_loopback', '_client_host'}
    forbidden_scope_keys = {'webrtc_remote_actor', 'gateway_remote_actor', 'webrtc_bridge_token', 'webrtc_device_owner', 'gateway_device_owner'}
    violations = []
    for file in sorted((Path(__file__).parents[1] / 'api').rglob('*.py')):
        if file.name in boundary_modules:
            continue
        tree = ast.parse(file.read_text())
        for node in ast.walk(tree):
            if isinstance(node, (ast.Name, ast.Attribute)):
                name = node.id if isinstance(node, ast.Name) else node.attr
                if name in forbidden_names:
                    violations.append(f'{file.name}:{node.lineno}: {name}')
            if isinstance(node, ast.ImportFrom):
                for imported in node.names:
                    if imported.name in forbidden_names:
                        violations.append(f'{file.name}:{node.lineno}: import {imported.name}')
            if isinstance(node, ast.Constant) and isinstance(node.value, str) and node.value in forbidden_scope_keys:
                violations.append(f'{file.name}:{node.lineno}: {node.value}')
            # Record-owner selection in native_calendar remains domain logic;
            # standalone actor-source equality is an access policy and is forbidden.
            if isinstance(node, ast.Compare) and any(isinstance(op, (ast.Eq, ast.NotEq)) for op in node.ops):
                values = [node.left, *node.comparators]
                if any(isinstance(value, ast.Attribute) and value.attr == 'source' for value in values) and any(
                    isinstance(value, ast.Constant) and value.value in ('remote', 'local') for value in values
                ):
                    violations.append(f'{file.name}:{node.lineno}: actor source comparison')
    assert not violations, 'Use api.workspace_access instead: ' + '; '.join(violations)


@pytest.mark.asyncio
@pytest.mark.parametrize('policy,expected', [('host', 200), ('scope', 200), ('gateway_configuration', 200), ('local', 403), ('local_credentials', 403), ('owner_session', 403)])
async def test_verified_direct_host_uses_every_shared_policy(policy, expected):
    from api.workspace_access import require_workspace_access
    from services.webrtc_p2p.bridge import WebRtcRemoteActor
    app = FastAPI()
    app.state.webrtc_scope_token = object()
    app.state.gateway_client = SimpleNamespace(managed_config=object(), current_user_id='owner')
    @app.middleware('http')
    async def identity(request, call_next):
        request.scope.update(webrtc_remote_actor=WebRtcRemoteActor('rtc', 'RTC', 'device'), webrtc_device_owner=True, webrtc_bridge_token=app.state.webrtc_scope_token)
        with actor_context(ActorSnapshot('rtc', 'Owner', 'device', 'Device', 'remote', access_source='webrtc_p2p')):
            return await call_next(request)
    @app.get('/feature')
    async def feature(request: Request):
        await require_workspace_access(request, policy)
        return {'ok': True}
    async with AsyncClient(transport=ASGITransport(app=app, client=('192.0.2.1', 123)), base_url='http://localhost') as client:
        assert (await client.get('/feature')).status_code == expected


@pytest.mark.asyncio
@pytest.mark.parametrize('verified', [True, False])
async def test_unlock_status_and_websocket_share_verified_direct_authentication(monkeypatch, verified):
    from api import remote_project
    from api.remote_access_guard import remote_access_authorized, websocket_access_allowed
    from fastapi import WebSocket
    from unittest.mock import AsyncMock
    from services.webrtc_p2p.bridge import WebRtcRemoteActor
    access = SimpleNamespace(access_password_required=lambda: True, verify_access_token=lambda _: False)
    monkeypatch.setattr(remote_project, 'remote_access_service', access)
    app = FastAPI()
    app.state.webrtc_scope_token = object()
    app.include_router(remote_project.router)
    @app.middleware('http')
    async def identity(request, call_next):
        request.scope.update(webrtc_remote_actor=WebRtcRemoteActor('rtc', 'RTC', 'device'), webrtc_device_owner=True,
                             webrtc_bridge_token=app.state.webrtc_scope_token if verified else object())
        return await call_next(request)
    async with AsyncClient(transport=ASGITransport(app=app, client=('192.0.2.1', 123)), base_url='http://localhost') as client:
        result = await client.get('/api/remote-project/access/status')
        assert result.json()['authorized'] is verified
        assert result.json()['local'] is False
    ws = WebSocket({'type': 'websocket', 'path': '/ws', 'headers': [], 'query_string': b'',
                    'scheme': 'ws', 'server': ('localhost', 80), 'client': ('192.0.2.1', 123), 'app': app,
                    'webrtc_remote_actor': object(),
                    'webrtc_bridge_token': app.state.webrtc_scope_token if verified else object()}, receive=AsyncMock(), send=AsyncMock())
    assert websocket_access_allowed(ws, access) is verified
    assert remote_access_authorized(ws, access) is verified


@pytest.mark.asyncio
@pytest.mark.parametrize('origin,expected', [(None, 200), ('http://localhost', 200), ('https://evil.test', 403)])
async def test_direct_mutations_keep_explicit_origin_validation(origin, expected):
    from api.workspace_access import require_workspace_access, require_same_origin
    app = FastAPI()
    app.state.webrtc_scope_token = object()
    @app.middleware('http')
    async def identity(request, call_next):
        request.scope.update(webrtc_remote_actor=object(), webrtc_device_owner=True, webrtc_bridge_token=app.state.webrtc_scope_token)
        return await call_next(request)
    @app.post('/feature')
    async def feature(request: Request):
        await require_workspace_access(request)
        require_same_origin(request)
        return {'ok': True}
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://localhost') as client:
        assert (await client.post('/feature', headers={'Origin': origin} if origin else {})).status_code == expected


@pytest.mark.asyncio
@pytest.mark.parametrize('protocol', ['rtc', 'gateway'])
@pytest.mark.parametrize('configured', [True, False])
async def test_non_owner_bridge_cannot_use_gateway_setup_fallback(protocol, configured):
    from api.workspace_access import require_workspace_access
    app = FastAPI()
    app.state.webrtc_scope_token = object()
    app.state.gateway_client = SimpleNamespace(managed_config=object() if configured else None, current_user_id='owner')
    @app.middleware('http')
    async def identity(request, call_next):
        if protocol == 'rtc':
            request.scope.update(webrtc_remote_actor=object(), webrtc_bridge_token=app.state.webrtc_scope_token, webrtc_device_owner=False)
        else:
            request.scope.update(gateway_remote_actor=SimpleNamespace(project_id=None), gateway_device_owner=False)
        return await call_next(request)
    @app.get('/feature')
    async def feature(request: Request):
        await require_workspace_access(request, 'gateway_configuration')
        return {'ok': True}
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://localhost') as client:
        assert (await client.get('/feature')).status_code == 403
