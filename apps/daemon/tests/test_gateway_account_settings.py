from types import SimpleNamespace
import pytest

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.system_settings import router
from api.desktop_security import DesktopSecurityMiddleware
from services.gateway_client.identity import ManagedActor, ManagedLocalSessions


def test_enabled_gateway_before_authorization_never_requires_a_local_profile(tmp_path, monkeypatch):
    import services.config as config_module
    import api.system_settings as module
    from services.config import ConfigStore
    monkeypatch.setattr(config_module, 'CONFIG_FILE', tmp_path/'config.json')
    store = ConfigStore(); store.set('gateway_platform', {'url':'http://localhost:8700', 'enabled':True, 'authorized':False})
    monkeypatch.setattr(module, 'config_store', store)
    app = FastAPI(); app.include_router(router)
    app.state.gateway_client = SimpleNamespace(managed_config=None)
    with TestClient(app, base_url='http://localhost', client=('127.0.0.1', 1234)) as client:
        data = client.get('/api/system-settings').json()
        assert data['identity_source'] == 'gateway'
        assert data['user_name'] == ''
        assert client.put('/api/system-settings', json={'user_name':'123'}).status_code == 403


def test_gateway_account_is_readonly_and_used_after_desktop_session_expires(monkeypatch):
    monkeypatch.setenv('WORKSTEP_DESKTOP_RUNTIME', '1')
    monkeypatch.setenv('WORKSTEP_DESKTOP_TOKEN', 'desktop-secret')
    app = FastAPI(); app.include_router(router); app.add_middleware(DesktopSecurityMiddleware)
    actor = ManagedActor('gateway-user', 'alice', 'device', 'instance', 1, display_name='网关用户')
    app.state.gateway_client = SimpleNamespace(managed_config=object(), local_sessions=ManagedLocalSessions(), current_actor=actor)
    with TestClient(app) as client:
        headers = {'X-WorkStep-Desktop-Token': 'desktop-secret'}
        data = client.get('/api/system-settings', headers=headers).json()
        assert data['user_name'] == '网关用户'
        assert data['identity_source'] == 'gateway'
        assert data['gateway_username'] == 'alice'
        assert client.put('/api/system-settings', headers=headers, json={'user_name':'fake'}).status_code == 403


def test_lan_browser_with_native_access_keeps_its_own_profile(tmp_path, monkeypatch):
    import services.config as config_module
    import api.system_settings as module
    from services.config import ConfigStore
    monkeypatch.setattr(config_module, 'CONFIG_FILE', tmp_path / 'config.json')
    store = ConfigStore()
    store.set('gateway_platform', {'enabled': True, 'authorized': True})
    store.set_user_name('宿主名称')
    monkeypatch.setattr(module, 'config_store', store)
    app = FastAPI()
    app.include_router(router)
    app.state.gateway_client = SimpleNamespace(managed_config=object())
    with TestClient(app, client=('192.168.1.20', 1234)) as client:
        data = client.get('/api/system-settings').json()
        assert data['identity_source'] == 'local'
        assert data['gateway_username'] == ''


@pytest.mark.parametrize('packaged', [False, True])
def test_reconnecting_host_never_creates_work_under_stale_browser_identity(monkeypatch, packaged):
    from api.remote_access_guard import BrowserActorMiddleware
    from api.task import router as task_router
    monkeypatch.delenv('WORKSTEP_DESKTOP_TOKEN', raising=False)
    if packaged:
        monkeypatch.setenv('WORKSTEP_MANAGED_BUNDLE_DIR', '/isolated-test-bundle')
        monkeypatch.setenv('WORKSTEP_DESKTOP_RUNTIME', '1')
        monkeypatch.setenv('WORKSTEP_DESKTOP_TOKEN', 'desktop-secret')
    app = FastAPI()
    app.include_router(task_router)
    app.add_middleware(DesktopSecurityMiddleware)
    app.add_middleware(BrowserActorMiddleware)
    app.state.gateway_browser_login = SimpleNamespace(local_workspace_token='workspace')
    app.state.gateway_client = SimpleNamespace(managed_config=object(),
        local_sessions=ManagedLocalSessions(), current_actor=None)

    with TestClient(app, base_url='http://localhost', client=('127.0.0.1', 1234)) as client:
        if not packaged:
            from services.gateway_client.browser_login import local_session_cookie_name
            client.cookies.set(local_session_cookie_name(app) + '_workspace', 'workspace')
        result = client.post('/api/task/create?project_id=project', json={'title':'test'}, headers={
            'Origin': 'http://localhost',
            **({'X-WorkStep-Desktop-Token':'desktop-secret'} if packaged else {}),
            'X-WorkStep-Actor-Id':'old-browser', 'X-WorkStep-Actor-Name':'old-name',
            'X-WorkStep-Actor-Device-Id':'browser', 'X-WorkStep-Actor-Device-Name':'Chrome'})
        assert result.status_code == 401
        assert result.headers['X-WorkStep-Gateway-Login'] == '/gateway/login'


def test_gateway_name_survives_offline_and_disconnect_then_becomes_editable(tmp_path, monkeypatch):
    import services.config as config_module
    import api.system_settings as module
    from services.config import ConfigStore
    monkeypatch.setattr(config_module, 'CONFIG_FILE', tmp_path / 'config.json')
    store = ConfigStore()
    store.set_user_name('旧本地名称')
    store.sync_gateway_user(name='网关用户', username='alice', gateway_id='gateway', origin='https://gateway.test')
    store.set('gateway_platform', {'enabled': True, 'url': 'https://gateway.test'})
    monkeypatch.setattr(module, 'config_store', store)
    app = FastAPI(); app.include_router(router)
    app.state.gateway_client = SimpleNamespace(managed_config=None)
    with TestClient(app, base_url='http://localhost', client=('127.0.0.1', 1234)) as client:
        settings = client.get('/api/system-settings').json()
        assert settings['identity_source'] == 'gateway'
        assert settings['user_name'] == '网关用户'
        assert client.put('/api/system-settings', json={'user_name':'改名'}).status_code == 403
        store.set('gateway_platform', {'enabled': False})
        settings = client.get('/api/system-settings').json()
        assert settings['identity_source'] == 'local'
        assert settings['user_name'] == '网关用户'
        assert client.put('/api/system-settings', json={'user_name':'新本地名称'}).status_code == 200
        assert ConfigStore().get_user_name() == '新本地名称'


def test_pending_gateway_identity_preserves_native_stop_and_resource_access(monkeypatch):
    from api.remote_access_guard import BrowserActorMiddleware
    monkeypatch.setenv('WORKSTEP_DESKTOP_RUNTIME', '1')
    monkeypatch.setenv('WORKSTEP_DESKTOP_TOKEN', 'desktop-secret')
    app = FastAPI()
    app.add_middleware(DesktopSecurityMiddleware)
    app.add_middleware(BrowserActorMiddleware)
    app.state.gateway_client = SimpleNamespace(managed_config=object(),
        local_sessions=ManagedLocalSessions(), current_actor=None)

    @app.post('/api/task/cancel')
    @app.post('/api/chat-sessions/session/stop')
    @app.post('/api/digital-person/browser/install')
    async def host_action():
        return {'ok':True}

    with TestClient(app) as client:
        headers = {'X-WorkStep-Desktop-Token':'desktop-secret'}
        for path in ('/api/task/cancel', '/api/chat-sessions/session/stop',
                     '/api/digital-person/browser/install'):
            assert client.post(path, headers=headers).status_code == 200
