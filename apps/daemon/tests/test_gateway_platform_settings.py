import asyncio
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient


@pytest.mark.asyncio
async def test_logout_keeps_gateway_address_and_mode_but_clears_login(monkeypatch):
    from unittest.mock import AsyncMock
    from services.gateway_client import browser_login as module
    stored = {'url': 'http://localhost:8700', 'enabled': True, 'authorized': True}
    monkeypatch.setattr(module.config_store, 'get', lambda *args: dict(stored))
    monkeypatch.setattr(module.config_store, 'set', lambda key, value: stored.update(value))
    import threading
    import time
    deleted = []
    entered = threading.Event()
    def slow_delete(origin):
        entered.set()
        time.sleep(.15)
        deleted.append(origin)
    monkeypatch.setattr(module.connection_credentials, 'delete', slow_delete)
    gateway = SimpleNamespace(close=AsyncMock(), authorization_required=False)
    service = module.GatewayBrowserLogin(gateway)
    service.desktop_local_session = 'old-session'
    service.pending = {'state': 'old-state'}
    task = asyncio.create_task(service.logout())
    while not entered.is_set():
        await asyncio.sleep(.001)
    assert not task.done()
    await asyncio.sleep(.01)
    assert not task.done(), 'slow credential I/O must not block the event loop'
    await task
    gateway.close.assert_awaited_once()
    assert stored['url'] == 'http://localhost:8700'
    assert stored['enabled'] is True
    assert stored['authorized'] is False
    assert deleted == ['http://localhost:8700']
    assert service.desktop_local_session is None
    assert service.pending is None
    assert gateway.authorization_required is True


@pytest.mark.asyncio
async def test_logout_api_clears_cookie_and_rejects_cross_origin(monkeypatch):
    from unittest.mock import AsyncMock
    from api.gateway_platform import router
    service = SimpleNamespace(logout=AsyncMock())
    app = FastAPI(); app.include_router(router)
    app.state.gateway_browser_login = service
    async with AsyncClient(transport=ASGITransport(app=app, client=('127.0.0.1', 123)), base_url='http://localhost:8765') as client:
        denied = await client.post('/api/gateway-platform/logout', headers={'Origin': 'https://evil.test'})
        assert denied.status_code == 403
        service.logout.assert_not_awaited()
        response = await client.post('/api/gateway-platform/logout', headers={'Origin': 'http://localhost:8765'})
    assert response.status_code == 200
    assert response.json()['login_url'] == '/gateway/login'
    assert 'Max-Age=0' in response.headers['set-cookie']
    service.logout.assert_awaited_once()


def test_gateway_origin_accepts_private_http_and_rejects_public_http_or_credentials():
    from services.gateway_client.browser_login import normalize_origin
    assert normalize_origin('http://localhost:8700/') == 'http://localhost:8700'
    assert normalize_origin('http://192.168.52.156:8700/') == 'http://192.168.52.156:8700'
    for value in ['http://8.8.8.8:8700', 'http://example.com', 'https://u:p@example.com', 'https://example.com/path']:
        with pytest.raises(ValueError): normalize_origin(value)


@pytest.mark.asyncio
async def test_settings_api_does_not_allow_cross_origin_changes(monkeypatch):
    from api.gateway_platform import router
    app = FastAPI(); app.include_router(router)
    app.state.gateway_browser_login = SimpleNamespace()
    async with AsyncClient(transport=ASGITransport(app=app, client=('127.0.0.1',123)), base_url='http://localhost:8765') as client:
        result = await client.post('/api/gateway-platform/login', headers={'Origin':'https://evil.test'}, json={'url':'http://localhost:8700'})
        assert result.status_code == 403


@pytest.mark.asyncio
async def test_expired_or_wrong_callback_state_never_contacts_gateway():
    from services.gateway_client.browser_login import GatewayBrowserLogin
    login = GatewayBrowserLogin(SimpleNamespace())
    with pytest.raises(ValueError): await login.complete('code', 'unknown-state')


@pytest.mark.asyncio
async def test_callback_reports_gateway_device_rejection_instead_of_network_failure(tmp_path, monkeypatch):
    import time
    from services.gateway_client import browser_login as module
    from api.gateway_platform import router
    monkeypatch.setattr(module.config_module, 'CONFIG_DIR', tmp_path)
    login = module.GatewayBrowserLogin(SimpleNamespace(), client_factory=lambda: httpx.AsyncClient(
        transport=httpx.MockTransport(lambda request: httpx.Response(403, json={
            'error': {'code': 'forbidden', 'message': 'Device unavailable'}}))))
    login.pending = {'url': 'http://localhost:8700', 'gateway_id': 'g1',
        'callback_origin': 'http://localhost:8765', 'state': 's'*32, 'nonce': 'n'*32,
        'verifier': 'v'*48, 'expires': time.monotonic()+300,
        'identity': module._identity('http://localhost:8700')}
    app = FastAPI(); app.include_router(router); app.state.gateway_browser_login = login
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://localhost:8765') as client:
        response = await client.get('/api/gateway-platform/callback', params={'code': 'c'*32, 'state': 's'*32})
    assert response.status_code == 403
    assert response.json()['detail'] == '此设备已被网关停用或撤销，请联系网关管理员处理设备授权。'
    assert login.pending is None

@pytest.mark.asyncio
@pytest.mark.parametrize('callback_origin', ['http://localhost:8765', 'http://192.168.1.10:8765', 'https://workstep.example.com'])
async def test_browser_login_pending_then_approved_reuses_device_and_signed_delegation(tmp_path, monkeypatch, callback_origin):
    import base64, hashlib, json, time
    from urllib.parse import urlsplit, parse_qs
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from services.gateway_client import browser_login as module
    key = Ed25519PrivateKey.generate()
    public = key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode()
    fingerprint = hashlib.sha256(key.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)).hexdigest()
    def enc(value): return base64.urlsafe_b64encode(value).decode().rstrip('=')
    class Store:
        data = {}
        def get(self, name, default=None): return self.data.get(name, default)
        def set(self, name, value): self.data[name]=value
    store=Store(); monkeypatch.setattr(module,'config_store',store); monkeypatch.setattr(module.config_module,'CONFIG_DIR',tmp_path)
    approved=False; device_keys=[]; tokens=[]
    def handler(request):
        if request.url.path.endswith('gateway-key'):
            return httpx.Response(200, json={'gateway_id':'g1','fingerprint':fingerprint,'public_key_pem':public})
        body=json.loads(request.content); device_keys.append(body['device_public_key'])
        if not approved: return httpx.Response(200,json={'device_authorization':None})
        claims={'gateway_id':'g1','iss':'g1','iat':int(time.time()),'exp':int(time.time())+900,'user_id':'u1','username':'alice','device_id':'d1','app_instance_id':body['app_instance_id'],'policy_revision':1,'device_public_key':body['device_public_key']}
        encoded=enc(json.dumps({'alg':'EdDSA','typ':'JWT'}).encode())+'.'+enc(json.dumps(claims).encode())
        signed=encoded+'.'+enc(key.sign(encoded.encode())); tokens.append(signed)
        return httpx.Response(200,json={'device_authorization':signed})
    class Gateway:
        managed_config = None
        control_client = None
        current_user_id = None
        async def close(self): pass
        async def start(self): assert store.data['gateway_platform']['authorized']
        async def bootstrap(self, authorization, proof, private, public, delegation):
            from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
            device=serialization.load_pem_public_key(device_keys[-1].encode())
            control=serialization.load_pem_public_key(public.encode())
            fp=hashlib.sha256(control.public_bytes(serialization.Encoding.DER,serialization.PublicFormat.SubjectPublicKeyInfo)).hexdigest()
            device.verify(base64.urlsafe_b64decode(delegation+'==='),f'workstep-control-delegate-v1:{authorization}:{fp}'.encode())
            assert serialization.load_pem_private_key(private.encode(),password=None).public_key().public_bytes(serialization.Encoding.PEM,serialization.PublicFormat.SubjectPublicKeyInfo).decode()==public
            return 'local-session',SimpleNamespace(user_id='u1')
    login=module.GatewayBrowserLogin(Gateway(),client_factory=lambda:httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    await login.save_settings('http://localhost:8700', True)
    url=await login.begin('http://localhost:8700',callback_origin)
    params=parse_qs(urlsplit(url).query)
    assert params['redirect_uri']==[callback_origin+'/api/gateway-platform/callback']
    assert await login.complete('c'*32,params['state'][0]) is None
    assert store.data['gateway_platform']['pending_device']
    approved=True
    url=await login.begin('http://localhost:8700',callback_origin,desktop=True)
    assert 'redirect_uri' not in parse_qs(urlsplit(url).query)
    with pytest.raises(ValueError, match='origin mismatch'):
        await login.complete('c'*32, parse_qs(urlsplit(url).query)['state'][0], callback_origin='https://other.example.com')
    result=await login.complete('c'*32,parse_qs(urlsplit(url).query)['state'][0], callback_origin=callback_origin)
    assert result[0]=='local-session'
    assert result[2] is True
    assert device_keys[0]==device_keys[1]
    with pytest.raises(ValueError): await login.complete('c'*32,parse_qs(urlsplit(url).query)['state'][0])


@pytest.mark.asyncio
async def test_slow_identity_file_does_not_block_real_api_health(tmp_path,monkeypatch):
    import threading,time,hashlib
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from services.gateway_client import browser_login as module
    from api.gateway_platform import router
    key=Ed25519PrivateKey.generate().public_key(); pem=key.public_bytes(serialization.Encoding.PEM,serialization.PublicFormat.SubjectPublicKeyInfo).decode()
    fp=hashlib.sha256(key.public_bytes(serialization.Encoding.DER,serialization.PublicFormat.SubjectPublicKeyInfo)).hexdigest()
    class Store:
        data = {}
        def get(self, key, default=None): return self.data.get(key, default)
        def set(self, key, value): self.data[key] = value
    monkeypatch.setattr(module,'config_store',Store());monkeypatch.setattr(module.config_module,'CONFIG_DIR',tmp_path)
    entered=threading.Event();original=module._identity
    def slow(origin): entered.set();time.sleep(.5);return original(origin)
    monkeypatch.setattr(module,'_identity',slow)
    login=module.GatewayBrowserLogin(SimpleNamespace(managed_config=None,control_client=None,current_user_id=None),client_factory=lambda:httpx.AsyncClient(transport=httpx.MockTransport(lambda request:httpx.Response(200,json={'gateway_id':'g1','fingerprint':fp,'public_key_pem':pem}))))
    app=FastAPI();app.include_router(router);app.state.gateway_browser_login=login
    @app.get('/api/health')
    async def health(): return {'status':'ok'}
    async with AsyncClient(transport=ASGITransport(app=app,client=('127.0.0.1',1)),base_url='http://localhost:8765') as client:
        await client.put('/api/gateway-platform/settings',headers={'Origin':'http://localhost:8765'},json={'url':'http://localhost:8700','enabled':True})
        pending=asyncio.create_task(client.post('/api/gateway-platform/login',headers={'Origin':'http://localhost:8765'},json={'url':'http://localhost:8700'}))
        assert await asyncio.to_thread(entered.wait,2)
        started=time.monotonic(); assert (await client.get('/api/health')).status_code==200
        assert time.monotonic()-started < .2
        assert (await pending).status_code==200


@pytest.mark.asyncio
async def test_callback_sets_local_session_cookie_and_survives_desktop_browser_handoff(monkeypatch):
    from api.gateway_platform import router
    from api.desktop_security import DesktopSecurityMiddleware
    from services.gateway_client.browser_login import COOKIE
    monkeypatch.setenv('WORKSTEP_DESKTOP_RUNTIME', '1')
    monkeypatch.setenv('WORKSTEP_DESKTOP_TOKEN', 'runtime-secret')
    calls=[]
    class Login:
        async def begin(self, url, callback_origin, *, desktop=False):
            assert desktop is True
            return url+'/desktop/login?state='+'s'*32
        async def complete(self, code, state, *, callback_origin=None):
            calls.append((code,state));return ('test-local-session',SimpleNamespace(),True)
    app=FastAPI();app.include_router(router);app.add_middleware(DesktopSecurityMiddleware)
    app.state.gateway_browser_login=Login()
    async with AsyncClient(transport=ASGITransport(app=app,client=('127.0.0.1',1)),base_url='http://localhost:8765') as client:
        login=await client.post('/api/gateway-platform/login',headers={'Origin':'http://localhost:8765', 'X-WorkStep-Desktop-Token': 'runtime-secret'},json={'url':'http://localhost:8700'})
        assert login.status_code==200
        # The external browser callback does not possess Electron's runtime token.
        response=await client.get('/api/gateway-platform/callback',params={'code':'c'*32,'state':'s'*32})
        assert response.status_code==303
        assert response.headers['location']=='workstep://open'
        assert response.cookies[COOKIE]=='test-local-session'
        assert 'HttpOnly' in response.headers['set-cookie'] and 'SameSite=strict' in response.headers['set-cookie']
        assert calls==[('c'*32,'s'*32)]


@pytest.mark.asyncio
@pytest.mark.parametrize('browser_origin', ['http://localhost:8765', 'http://192.168.1.10:8765', 'https://workstep.example.com'])
async def test_address_save_does_not_enable_gateway_or_redirect_and_disable_cancels_login(monkeypatch, browser_origin):
    from services.gateway_client import browser_login as module
    from api.gateway_platform import router
    class Store:
        data = {}
        def get(self, key, default=None): return self.data.get(key, default)
        def set(self, key, value): self.data[key] = value
    store = Store(); monkeypatch.setattr(module, 'config_store', store)
    monkeypatch.delenv('WORKSTEP_MANAGED_BUNDLE_DIR', raising=False)
    class Gateway:
        control_client = None
        current_user_id = None
        managed_config = None
        closed = 0
        async def close(self): self.closed += 1; self.current_user_id = None
    gateway = Gateway()
    def no_network(): raise AssertionError('Saving an address or disabled login must not contact the gateway')
    login = module.GatewayBrowserLogin(gateway, client_factory=no_network)
    app = FastAPI(); app.include_router(router); app.state.gateway_browser_login = login
    async with AsyncClient(transport=ASGITransport(app=app, client=('192.168.1.20', 1)), base_url=browser_origin) as client:
        headers = {'Origin': browser_origin}
        saved = await client.put('/api/gateway-platform/settings', headers=headers, json={'url':'https://gateway.example.com', 'enabled':False})
        assert saved.status_code == 200
        assert saved.json()['url'] == 'https://gateway.example.com'
        assert saved.json()['enabled'] is False
        assert module.configured_payload() is None
        assert (await client.get('/gateway/login')).headers['location'] == '/'
        assert (await client.post('/api/gateway-platform/login', headers=headers, json={'url':'https://gateway.example.com'})).status_code == 400
        enabled = await client.put('/api/gateway-platform/settings', headers=headers, json={'url':'https://gateway.example.com', 'enabled':True})
        assert enabled.json()['enabled'] is True
        login.pending = {'state':'s'*32, 'expires':float('inf')}
        gateway.managed_config = object(); gateway.current_user_id = 'u1'
        login.desktop_local_session = 'session'
        disabled = await client.put('/api/gateway-platform/settings', headers=headers, json={'url':'https://gateway.example.com', 'enabled':False})
        assert disabled.json()['authenticated'] is False
        assert login.pending is None and login.desktop_local_session is None
        assert gateway.managed_config is None and gateway.closed == 1
        with pytest.raises(ValueError): await login.complete('c'*32, 's'*32)


@pytest.mark.asyncio
async def test_save_settings_is_same_origin_only(monkeypatch):
    from api.gateway_platform import router
    app = FastAPI(); app.include_router(router)
    async with AsyncClient(transport=ASGITransport(app=app, client=('10.0.0.1',1)), base_url='http://192.168.1.10:8765') as client:
        assert (await client.put('/api/gateway-platform/settings', json={'url':'https://gateway.example.com','enabled':True})).status_code == 403
    async with AsyncClient(transport=ASGITransport(app=app, client=('127.0.0.1',1)), base_url='http://localhost:8765') as client:
        assert (await client.put('/api/gateway-platform/settings', headers={'Origin':'https://evil.test'}, json={'url':'https://gateway.example.com','enabled':True})).status_code == 403


def test_disabled_gateway_never_restores_managed_payload(monkeypatch):
    from services.gateway_client import browser_login as module
    monkeypatch.setattr(module, 'config_store', SimpleNamespace(get=lambda *args: {
        'url':'https://gateway.example.com', 'enabled':False, 'authorized':True,
        'gateway_id':'g1', 'fingerprint':'abc'}))
    assert module.configured_payload() is None


@pytest.mark.asyncio
async def test_slow_settings_save_keeps_health_responsive(monkeypatch):
    import threading, time
    from services.gateway_client import browser_login as module
    from api.gateway_platform import router
    entered = threading.Event()
    class Store:
        data = {}
        def get(self, key, default=None): return self.data.get(key, default)
        def set(self, key, value):
            entered.set(); time.sleep(.5); self.data[key] = value
    monkeypatch.setattr(module, 'config_store', Store())
    monkeypatch.delenv('WORKSTEP_MANAGED_BUNDLE_DIR', raising=False)
    app = FastAPI(); app.include_router(router)
    app.state.gateway_browser_login = module.GatewayBrowserLogin(SimpleNamespace(
        managed_config=None, control_client=None, current_user_id=None))
    @app.get('/api/health')
    async def health(): return {'status':'ok'}
    async with AsyncClient(transport=ASGITransport(app=app, client=('127.0.0.1',1)), base_url='http://localhost:8765') as client:
        pending = asyncio.create_task(client.put('/api/gateway-platform/settings',
            headers={'Origin':'http://localhost:8765'}, json={'url':'https://gateway.example.com','enabled':False}))
        assert await asyncio.to_thread(entered.wait, 2)
        started = time.monotonic()
        assert (await client.get('/api/health')).status_code == 200
        assert time.monotonic() - started < .2
        assert (await pending).status_code == 200


@pytest.mark.asyncio
async def test_mobile_configuration_uses_existing_access_guard_and_returns_to_mobile_origin(monkeypatch):
    from api.gateway_platform import router
    from api.desktop_security import DesktopSecurityMiddleware
    from api.remote_access_guard import RemoteAccessGuardMiddleware
    from services.gateway_client.browser_login import COOKIE
    monkeypatch.delenv('WORKSTEP_DESKTOP_RUNTIME', raising=False)
    class Login:
        async def settings(self): return {'url':'https://gateway.example.com','enabled':True}
        async def save_settings(self, url, enabled): return {'url':url,'enabled':enabled}
        async def begin(self, url, callback_origin, *, desktop=False):
            assert callback_origin == 'http://192.168.1.10:8765'
            assert desktop is False
            return url+'/desktop/login?state='+'s'*32
        async def complete(self, code, state, *, callback_origin):
            assert callback_origin == 'http://192.168.1.10:8765'
            return ('mobile-session', SimpleNamespace())
    guard = SimpleNamespace(access_password_required=lambda:True, verify_access_token=lambda token:token=='access-key')
    app=FastAPI();app.include_router(router);app.state.gateway_browser_login=Login()
    app.add_middleware(DesktopSecurityMiddleware)
    app.add_middleware(RemoteAccessGuardMiddleware,access_service=guard)
    async with AsyncClient(transport=ASGITransport(app=app,client=('192.168.1.20',1)),base_url='http://192.168.1.10:8765') as client:
        assert (await client.get('/api/gateway-platform/settings')).status_code==401
        client.headers.update({'x-workstep-access':'access-key','Origin':'http://192.168.1.10:8765'})
        assert (await client.get('/api/gateway-platform/settings')).status_code==200
        assert (await client.put('/api/gateway-platform/settings',json={'url':'https://gateway.example.com','enabled':True})).status_code==200
        assert (await client.post('/api/gateway-platform/login',json={'url':'https://gateway.example.com'})).status_code==200
        del client.headers['x-workstep-access']
        callback=await client.get('/api/gateway-platform/callback',params={'code':'c'*32,'state':'s'*32})
        assert callback.status_code==303
        assert callback.headers['location']=='/?gateway_auth=complete'
        assert callback.cookies[COOKIE]=='mobile-session'


@pytest.mark.asyncio
async def test_mobile_cannot_change_managed_gateway_without_device_owner_session():
    from api.gateway_platform import router
    class Login:
        async def save_settings(self, url, enabled): return {'url':url,'enabled':enabled}
    owner = SimpleNamespace(user_id='owner')
    gateway = SimpleNamespace(managed_config=object(),current_user_id='owner',
        local_sessions=SimpleNamespace(resolve=lambda token: owner if token=='owner-session' else None))
    app=FastAPI();app.include_router(router);app.state.gateway_browser_login=Login();app.state.gateway_client=gateway
    async with AsyncClient(transport=ASGITransport(app=app,client=('192.168.1.20',1)),base_url='http://192.168.1.10:8765') as client:
        headers={'Origin':'http://192.168.1.10:8765'}
        payload={'url':'https://gateway.example.com','enabled':False}
        assert (await client.put('/api/gateway-platform/settings',headers=headers,json=payload)).status_code==403
        headers['x-workstep-local-session']='owner-session'
        assert (await client.put('/api/gateway-platform/settings',headers=headers,json=payload)).status_code==200


@pytest.mark.asyncio
async def test_gateway_project_visitor_cannot_read_or_change_host_settings():
    from api.gateway_platform import router
    app=FastAPI();app.include_router(router)
    @app.middleware('http')
    async def attach_project_actor(request, call_next):
        request.scope['gateway_remote_actor']=SimpleNamespace(project_id='shared-project')
        return await call_next(request)
    async with AsyncClient(transport=ASGITransport(app=app,client=('127.0.0.1',1)),base_url='http://127.0.0.1') as client:
        assert (await client.get('/api/gateway-platform/settings')).status_code==403
        assert (await client.put('/api/gateway-platform/settings',headers={'Origin':'http://127.0.0.1'},json={'url':'https://gateway.example.com','enabled':False})).status_code==403


@pytest.mark.asyncio
@pytest.mark.parametrize('origin', ['http://127.0.0.1:8767', 'http://192.168.52.156:8767', 'https://workstep.example.com'])
async def test_browser_callback_cookie_allows_cross_site_top_level_return(origin):
    from http.cookies import SimpleCookie
    from api.gateway_platform import router
    from services.gateway_client.browser_login import COOKIE

    class Login:
        async def complete(self, code, state, *, callback_origin):
            assert callback_origin == origin
            return ('browser-session', SimpleNamespace(), False)

    app = FastAPI()
    app.include_router(router)
    app.state.gateway_browser_login = Login()
    async with AsyncClient(transport=ASGITransport(app=app), base_url=origin) as client:
        response = await client.get('/api/gateway-platform/callback',
            params={'code': 'c'*32, 'state': 's'*32})
    assert response.status_code == 303
    assert response.headers['location'] == '/?gateway_auth=complete'
    cookie = SimpleCookie(response.headers['set-cookie'])[COOKIE]
    # Strict suppresses the cookie on the redirected homepage when the
    # authorization navigation started on a different site (LAN -> loopback).
    assert cookie['samesite'] == 'lax'
    assert cookie['httponly']
    assert bool(cookie['secure']) == origin.startswith('https:')
    assert cookie['path'] == '/'
