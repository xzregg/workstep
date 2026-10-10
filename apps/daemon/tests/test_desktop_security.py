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


def test_desktop_loopback_url_alone_cannot_replace_runtime_token(monkeypatch):
    monkeypatch.setenv('WORKSTEP_DESKTOP_RUNTIME', '1')
    monkeypatch.setenv('WORKSTEP_DESKTOP_TOKEN', 'runtime-secret')

    with TestClient(_app(), base_url='http://127.0.0.1:8766', client=('127.0.0.1', 43210)) as client:
        assert client.get('/api/private').status_code == 401
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect('/ws', headers={'host': '127.0.0.1:8766', 'origin': 'http://127.0.0.1:8766'}): pass
        with client.websocket_connect('/ws', headers={'X-WorkStep-Desktop-Token': 'runtime-secret'}) as websocket:
            assert websocket.receive_text() == 'ok'


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


def test_managed_runtime_accepts_desktop_token_and_keeps_gateway_identity(monkeypatch):
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
        desktop = client.get('/api/private', headers={
            'X-WorkStep-Desktop-Token': 'runtime-secret',
        })
        assert desktop.status_code == 200
        assert 'x-workstep-managed-session-expired' not in desktop.headers
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


def test_managed_runtime_keeps_lan_project_sharing_and_rejects_legacy_task_shares(monkeypatch):
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
        for path in ('/api/remote-project/share', '/api/remote-project/add'):
            assert client.post(path, headers=headers).status_code == 200
        assert client.post('/api/task-share/task-1/create', headers=headers).status_code == 403
        from api.remote_project import remote_project_registry
        monkeypatch.setattr(remote_project_registry, "get", lambda pid: {"id": pid} if pid == "remote-1" else None)
        assert client.post("/api/task-share/task-1/create?project_id=remote-1", headers=headers).status_code == 200
        assert client.post("/api/task-share/task-1/create?project_id=local-1", headers=headers).status_code == 403
        assert client.post("/api/task-share/task-1/create?project_id=remote-1").status_code == 401
        assert client.get("/api/task-share/public/old-token/meta?project_id=remote-1", headers=headers).status_code == 403

        assert client.get('/api/task-share/public/old-token/meta',
                          headers=headers).status_code == 403
        with client.websocket_connect('/ws/remote-project', headers=headers) as ws:
            assert ws.receive_text() == 'ok'

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
        expired = client.get('/api/actor')
        assert expired.status_code == 401
        assert expired.headers['X-WorkStep-Gateway-Login'] == '/gateway/login'
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
        assert client.get('/api/private', headers=headers).status_code == 200
        assert client.post('/api/private', headers=headers).status_code == 200
        assert client.get('/', headers=headers, follow_redirects=False).status_code == 200
        with client.websocket_connect('/ws', headers=headers) as ws:
            assert ws.receive_text() == 'ok'


@pytest.mark.parametrize('base_url', ['http://127.0.0.1:8766', 'http://10.88.0.5:8765'])
def test_desktop_container_forwarding_survives_platform_session_expiry(monkeypatch, base_url):
    monkeypatch.setenv('WORKSTEP_DESKTOP_RUNTIME', '1')
    monkeypatch.setenv('WORKSTEP_DESKTOP_TOKEN', 'runtime-secret')
    app, _, _ = _browser_managed_app()
    app.state.gateway_client.local_sessions.clear()
    headers = {'X-WorkStep-Desktop-Token': 'runtime-secret'}
    with TestClient(app, base_url=base_url, client=('10.88.0.2', 43210)) as client:
        assert client.get('/', headers=headers, follow_redirects=False).status_code == 200
        assert client.get('/api/private', headers=headers).status_code == 200
        assert client.post('/api/private', headers=headers).status_code == 200
        with client.websocket_connect('/ws', headers=headers) as ws:
            assert ws.receive_text() == 'ok'


@pytest.mark.parametrize('peer', ['10.88.0.2', '10.88.0.3'])
def test_container_ip_does_not_authorize_managed_requests(monkeypatch, peer):
    monkeypatch.setenv('WORKSTEP_DESKTOP_RUNTIME', '1')
    monkeypatch.setenv('WORKSTEP_DESKTOP_TOKEN', 'runtime-secret')
    app, _, _ = _browser_managed_app()
    app.state.gateway_client.local_sessions.clear()
    with TestClient(app, base_url='http://10.88.0.5:8765', client=(peer, 43210)) as client:
        forged = {'Host': '127.0.0.1:8766', 'Origin': 'http://127.0.0.1:8766', 'X-Forwarded-For': '127.0.0.1', 'X-Real-IP': '10.88.0.2'}
        assert client.get('/api/private', headers=forged).status_code == 401
        assert client.post('/api/private', headers=forged).status_code == 401
        for headers in ({}, {'X-WorkStep-Desktop-Token': 'wrong'}, {'X-WorkStep-Desktop': '1'}):
            assert client.get('/api/private', headers=headers).status_code == 401
            with pytest.raises(WebSocketDisconnect):
                with client.websocket_connect('/ws', headers=headers): pass


@pytest.mark.parametrize('user_id,project_id,expected', [('owner',None,200),('guest',None,403),('owner','project-a',403)])
def test_gateway_project_creation_is_reserved_for_device_owner(monkeypatch,user_id,project_id,expected):
    from starlette.middleware.base import BaseHTTPMiddleware
    app=_app()
    app.state.gateway_client=type('Client',(),{'managed_config':object(),'current_user_id':'owner','device_id':'device-1'})()
    actor=ManagedActor(user_id,user_id,'device-1','gateway-remote',0,project_id,'edit' if project_id else None)
    class BridgeActor(BaseHTTPMiddleware):
        async def dispatch(self,request,call_next):
            request.scope['gateway_remote_actor']=actor
            request.scope['gateway_device_owner']=user_id == 'owner'
            return await call_next(request)
    app.add_middleware(BridgeActor)
    @app.post('/api/project/init')
    @app.post('/api/fs/mkdir')
    @app.get('/api/fs/browse')
    async def allowed():return {'ok':True}
    with TestClient(app) as client:
        mode=client.get('/api/managed/mode').json()
        assert mode.get('can_manage_remote_projects', False) is (expected==200)
        assert client.post('/api/project/init',json={'path':'/demo'}).status_code==expected
        assert client.get('/api/fs/browse').status_code==expected
        assert client.post('/api/fs/mkdir',json={'path':'/demo','name':'project'}).status_code==expected


@pytest.mark.asyncio
async def test_remote_task_share_registry_lookup_keeps_event_loop_responsive(monkeypatch):
    import asyncio
    import time
    from starlette.requests import Request
    from api.desktop_security import _remote_task_share_management
    from api.remote_project import remote_project_registry

    def slow_lookup(project_id):
        time.sleep(0.15)
        return {"id": project_id}

    monkeypatch.setattr(remote_project_registry, "get", slow_lookup)
    request = Request({"type": "http", "method": "POST",
                       "path": "/api/task-share/task-1/create",
                       "query_string": b"project_id=remote-1", "headers": []})
    started = time.monotonic()
    lookup = asyncio.create_task(_remote_task_share_management(request))
    await asyncio.sleep(0.01)
    assert time.monotonic() - started < 0.1
    assert not lookup.done()
    assert await lookup is True
