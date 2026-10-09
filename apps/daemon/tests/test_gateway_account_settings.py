from types import SimpleNamespace

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
    with TestClient(app) as client:
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
