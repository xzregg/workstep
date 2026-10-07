from __future__ import annotations

from fastapi import FastAPI, WebSocket
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
import pytest

from api.desktop_security import (
    DesktopSecurityMiddleware,
    desktop_websocket_allowed,
)
from services.gateway_client.identity import ManagedActor, ManagedLocalSessions
from services.remote_access import get_effective_actor
from api.managed import router as managed_router


def _app() -> FastAPI:
    app = FastAPI()
    app.add_middleware(DesktopSecurityMiddleware)
    app.include_router(managed_router)

    @app.get('/api/private')
    async def private():
        return {'ok': True}

    @app.post('/api/remote-project/share')
    @app.post('/api/remote-project/add')
    @app.post('/api/task-share/task-1/create')
    async def legacy_share():
        return {'ok': True}

    @app.get('/api/task-share/public/old-token/meta')
    async def legacy_public_share():
        return {'ok': True}

    @app.get('/api/actor')
    async def actor():
        current = get_effective_actor()
        return {'id': current.actor_id, 'source': current.source,
                'name': current.user_name, 'username': current.username}

    @app.get('/')
    async def index():
        return {'ok': True}

    @app.get('/api/fs/project-raw/{project_ref}/{full_path:path}')
    async def project_raw(project_ref: str, full_path: str):
        return {'ok': True}

    @app.websocket('/ws')
    async def websocket_endpoint(ws: WebSocket):
        if not await desktop_websocket_allowed(ws):
            await ws.close(code=4401)
            return
        await ws.accept()
        await ws.send_text('ok')

    @app.websocket('/ws/remote-project')
    async def legacy_remote_project(ws: WebSocket):
        if not await desktop_websocket_allowed(ws):
            await ws.close(code=4403)
            return
        await ws.accept()
        await ws.send_text('ok')

    return app


def test_desktop_api_requires_runtime_token(monkeypatch):
    monkeypatch.setenv('WORKSTEP_DESKTOP_RUNTIME', '1')
    monkeypatch.setenv('WORKSTEP_DESKTOP_TOKEN', 'runtime-secret')

    with TestClient(_app()) as client:
        assert client.get('/api/private').status_code == 401
        response = client.get(
            '/api/private',
            headers={'X-WorkStep-Desktop-Token': 'runtime-secret'},
        )

    assert response.status_code == 200
    assert response.headers['content-security-policy'].startswith("default-src 'self'")
    assert response.headers['x-content-type-options'] == 'nosniff'
    assert response.headers['referrer-policy'] == 'no-referrer'


def test_enabled_remote_access_can_use_desktop_http_and_websocket_without_desktop_token(monkeypatch):
    monkeypatch.setenv('WORKSTEP_DESKTOP_RUNTIME', '1')
    monkeypatch.setenv('WORKSTEP_DESKTOP_TOKEN', 'runtime-secret')
    app = _app()
    app.state.remote_access_service = type('RemoteAccess', (), {
        'settings': lambda _self: {'enabled': True},
    })()

    with TestClient(app) as client:
        assert client.get('/api/private').status_code == 200
        with client.websocket_connect('/ws') as websocket:
            assert websocket.receive_text() == 'ok'


def test_static_shell_is_available_but_receives_security_headers(monkeypatch):
    monkeypatch.setenv('WORKSTEP_DESKTOP_RUNTIME', '1')
    monkeypatch.setenv('WORKSTEP_DESKTOP_TOKEN', 'runtime-secret')

    with TestClient(_app()) as client:
        response = client.get('/')

    assert response.status_code == 200
    assert "frame-ancestors *" in response.headers['content-security-policy']
    assert 'x-frame-options' not in {k.lower() for k in response.headers}


def test_project_raw_allows_same_origin_iframe(monkeypatch):
    monkeypatch.setenv('WORKSTEP_DESKTOP_RUNTIME', '1')
    monkeypatch.setenv('WORKSTEP_DESKTOP_TOKEN', 'runtime-secret')

    with TestClient(_app()) as client:
        response = client.get(
            '/api/fs/project-raw/proj/foo.html',
            headers={'X-WorkStep-Desktop-Token': 'runtime-secret'},
        )

    assert response.status_code == 200
    assert 'x-frame-options' not in {k.lower() for k in response.headers}
    assert "frame-ancestors *" in response.headers['content-security-policy']


def test_desktop_websocket_requires_runtime_token(monkeypatch):
    monkeypatch.setenv('WORKSTEP_DESKTOP_RUNTIME', '1')
    monkeypatch.setenv('WORKSTEP_DESKTOP_TOKEN', 'runtime-secret')

    with TestClient(_app()) as client:
        with client.websocket_connect(
            '/ws', headers={'X-WorkStep-Desktop-Token': 'runtime-secret'}
        ) as websocket:
            assert websocket.receive_text() == 'ok'


def test_non_desktop_runtime_keeps_existing_access_behavior(monkeypatch):
    monkeypatch.delenv('WORKSTEP_DESKTOP_RUNTIME', raising=False)
    monkeypatch.delenv('WORKSTEP_DESKTOP_TOKEN', raising=False)

    with TestClient(_app()) as client:
        assert client.get('/api/private').status_code == 200
        with client.websocket_connect('/ws') as websocket:
            assert websocket.receive_text() == 'ok'


def test_managed_runtime_requires_gateway_derived_local_session(monkeypatch):
    monkeypatch.setenv('WORKSTEP_DESKTOP_RUNTIME', '1')
    monkeypatch.setenv('WORKSTEP_DESKTOP_TOKEN', 'runtime-secret')
    app = _app()
    sessions = ManagedLocalSessions()
    actor = ManagedActor('user-1', 'alice', 'device-1', 'instance-1', 1,
                         display_name='Alice Display')
    local_token = sessions.create(actor)
    app.state.gateway_client = type('GatewayClient', (), {
        'managed_config': object(), 'local_sessions': sessions,
    })()
    with TestClient(app) as client:
        missing = client.get('/api/private', headers={
            'X-WorkStep-Desktop-Token': 'runtime-secret',
        })
        assert missing.status_code == 401
        assert missing.headers['x-workstep-managed-session-expired'] == '1'
        assert client.get('/api/private', headers={
            'X-WorkStep-Desktop-Token': 'runtime-secret',
            'X-WorkStep-Local-Session': local_token,
            'Origin': 'https://attacker.example',
        }).status_code == 200
        assert client.get('/api/private', headers={
            'X-WorkStep-Local-Session': local_token,
            'Origin': 'https://attacker.example',
        }).status_code == 401
        assert client.get('/api/private', headers={
            'X-WorkStep-Desktop-Token': 'runtime-secret',
            'X-WorkStep-Local-Session': local_token,
        }).status_code == 200
        assert client.get('/api/actor', headers={
            'X-WorkStep-Desktop-Token': 'runtime-secret',
            'X-WorkStep-Local-Session': local_token,
        }).json() == {'id': 'user-1', 'source': 'managed',
                      'name': 'Alice Display', 'username': 'alice'}
        with client.websocket_connect('/ws', headers={
            'X-WorkStep-Desktop-Token': 'runtime-secret',
            'X-WorkStep-Local-Session': local_token,
        }) as websocket:
            assert websocket.receive_text() == 'ok'
        # WS 握手只校验 token + local session，不做 Origin 同源校验：TLS 终结
        # 的逆向代理把 wss 转成本机 ws 后 Origin scheme 是 https，硬校验会把
        # 合法反代部署全部挡掉。
        with client.websocket_connect('/ws', headers={
            'X-WorkStep-Desktop-Token': 'runtime-secret',
            'X-WorkStep-Local-Session': local_token,
            'Origin': 'https://attacker.example',
        }) as websocket:
            assert websocket.receive_text() == 'ok'


def test_managed_runtime_rejects_legacy_share_credentials(monkeypatch):
    monkeypatch.setenv('WORKSTEP_DESKTOP_RUNTIME', '1')
    monkeypatch.setenv('WORKSTEP_DESKTOP_TOKEN', 'runtime-secret')
    app = _app()
    sessions = ManagedLocalSessions()
    local_token = sessions.create(ManagedActor(
        'user-1', 'alice', 'device-1', 'instance-1', 1,
    ))
    app.state.gateway_client = type('GatewayClient', (), {
        'managed_config': object(), 'local_sessions': sessions,
    })()
    headers = {'X-WorkStep-Desktop-Token': 'runtime-secret',
               'X-WorkStep-Local-Session': local_token}
    with TestClient(app) as client:
        assert client.get('/api/managed/mode', headers=headers).json() == {'managed': True}
        for path in ('/api/remote-project/share', '/api/remote-project/add',
                     '/api/task-share/task-1/create'):
            assert client.post(path, headers=headers).status_code == 403
        assert client.get('/api/task-share/public/old-token/meta',
                          headers=headers).status_code == 403
        with pytest.raises(WebSocketDisconnect) as denied:
            with client.websocket_connect('/ws/remote-project', headers=headers):
                pass
        assert denied.value.code == 4403

    with TestClient(_app()) as local_client:
        assert local_client.get('/api/managed/mode', headers=headers).json() == {'managed': False}
        assert local_client.post('/api/remote-project/share', headers=headers).status_code == 200
        assert local_client.get('/api/task-share/public/old-token/meta',
                                headers=headers).status_code == 200


def _browser_managed_app():
    from types import SimpleNamespace
    from services.gateway_client.browser_login import COOKIE
    app = _app()
    sessions = ManagedLocalSessions()
    token = sessions.create(ManagedActor('user-1', 'alice', 'device-1', 'instance-1', 1))
    app.state.gateway_client = SimpleNamespace(managed_config=object(), local_sessions=sessions)
    app.state.gateway_browser_login = SimpleNamespace(desktop_local_session=token)
    @app.post('/api/private')
    async def write(): return {'ok': True}
    return app, token, COOKIE


def test_browser_platform_cookie_requires_same_origin_writes_and_websocket(monkeypatch):
    monkeypatch.delenv('WORKSTEP_DESKTOP_RUNTIME', raising=False)
    app, token, cookie = _browser_managed_app()
    with TestClient(app, base_url='http://localhost:8765') as client:
        assert client.get('/', follow_redirects=False).headers['location'] == '/gateway/login'
        client.cookies.set(cookie, token)
        assert client.get('/').status_code == 200
        assert client.get('/api/actor').json()['id'] == 'user-1'
        assert client.post('/api/private').status_code == 403
        assert client.post('/api/private', headers={'Origin': 'https://evil.test'}).status_code == 403
        assert client.post('/api/private', headers={'Origin': 'http://localhost:8765'}).status_code == 200
        with client.websocket_connect('ws://localhost:8765/ws', headers={'Origin': 'http://localhost:8765'}) as ws:
            assert ws.receive_text() == 'ok'
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect('ws://localhost:8765/ws', headers={'Origin': 'https://evil.test'}): pass


def test_normal_desktop_uses_correlated_browser_login_without_special_package(monkeypatch):
    monkeypatch.setenv('WORKSTEP_DESKTOP_RUNTIME', '1')
    monkeypatch.setenv('WORKSTEP_DESKTOP_TOKEN', 'runtime-secret')
    app, _, _ = _browser_managed_app()
    with TestClient(app) as client:
        assert client.get('/api/private').status_code == 401
        headers = {'X-WorkStep-Desktop-Token': 'runtime-secret'}
        assert client.get('/api/actor', headers=headers).json()['id'] == 'user-1'
        assert client.get('/', headers=headers).status_code == 200
        with client.websocket_connect('/ws', headers=headers) as ws:
            assert ws.receive_text() == 'ok'
        app.state.gateway_client.local_sessions.clear()
        assert client.get('/api/private', headers=headers).status_code == 401
