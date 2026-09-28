from __future__ import annotations

from fastapi import FastAPI, WebSocket
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
import pytest

from services.desktop_security import (
    DesktopSecurityMiddleware,
    desktop_websocket_allowed,
)
from services.gateway_client.identity import ManagedActor, ManagedLocalSessions


def _app() -> FastAPI:
    app = FastAPI()
    app.add_middleware(DesktopSecurityMiddleware)

    @app.get('/api/private')
    async def private():
        return {'ok': True}

    @app.get('/')
    async def index():
        return {'ok': True}

    @app.get('/api/fs/project-raw/{project_ref}/{full_path:path}')
    async def project_raw(project_ref: str, full_path: str):
        return {'ok': True}

    @app.websocket('/ws')
    async def websocket_endpoint(ws: WebSocket):
        if not desktop_websocket_allowed(ws):
            await ws.close(code=4401)
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
    actor = ManagedActor('user-1', 'alice', 'device-1', 'instance-1', 1)
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
        }).status_code == 403
        assert client.get('/api/private', headers={
            'X-WorkStep-Desktop-Token': 'runtime-secret',
            'X-WorkStep-Local-Session': local_token,
        }).status_code == 200
        with client.websocket_connect('/ws', headers={
            'X-WorkStep-Desktop-Token': 'runtime-secret',
            'X-WorkStep-Local-Session': local_token,
        }) as websocket:
            assert websocket.receive_text() == 'ok'
        with pytest.raises(WebSocketDisconnect) as denied:
            with client.websocket_connect('/ws', headers={
                'X-WorkStep-Desktop-Token': 'runtime-secret',
                'X-WorkStep-Local-Session': local_token,
                'Origin': 'https://attacker.example',
            }):
                pass
        assert denied.value.code == 4401
