import asyncio
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient


def test_gateway_origin_rejects_remote_http_and_credentials():
    from services.gateway_client.browser_login import normalize_origin
    assert normalize_origin('http://localhost:8700/') == 'http://localhost:8700'
    for value in ['http://example.com', 'https://u:p@example.com', 'https://example.com/path']:
        with pytest.raises(ValueError): normalize_origin(value)


@pytest.mark.asyncio
async def test_settings_api_does_not_allow_nonlocal_or_cross_origin_changes(monkeypatch):
    from api.gateway_platform import router
    app = FastAPI(); app.include_router(router)
    app.state.gateway_browser_login = SimpleNamespace()
    async with AsyncClient(transport=ASGITransport(app=app, client=('127.0.0.1',123)), base_url='http://localhost:8765') as client:
        result = await client.post('/api/gateway-platform/login', headers={'Origin':'https://evil.test'}, json={'url':'http://localhost:8700'})
        assert result.status_code == 403
    async with AsyncClient(transport=ASGITransport(app=app, client=('10.0.0.1',123)), base_url='http://localhost:8765') as client:
        assert (await client.get('/api/gateway-platform/settings')).status_code == 403


@pytest.mark.asyncio
async def test_expired_or_wrong_callback_state_never_contacts_gateway():
    from services.gateway_client.browser_login import GatewayBrowserLogin
    login = GatewayBrowserLogin(SimpleNamespace())
    with pytest.raises(ValueError): await login.complete('code', 'unknown-state')

@pytest.mark.asyncio
async def test_browser_login_pending_then_approved_reuses_device_and_signed_delegation(tmp_path, monkeypatch):
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
    url=await login.begin('http://localhost:8700','http://localhost:8765')
    params=parse_qs(urlsplit(url).query)
    assert params['redirect_uri']==['http://localhost:8765/api/gateway-platform/callback']
    assert await login.complete('c'*32,params['state'][0]) is None
    assert store.data['gateway_platform']['pending_device']
    approved=True
    url=await login.begin('http://localhost:8700','http://localhost:8765')
    result=await login.complete('c'*32,parse_qs(urlsplit(url).query)['state'][0])
    assert result[0]=='local-session'
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
        def get(self,*args): return {}
        def set(self,*args): pass
    monkeypatch.setattr(module,'config_store',Store());monkeypatch.setattr(module.config_module,'CONFIG_DIR',tmp_path)
    entered=threading.Event();original=module._identity
    def slow(origin): entered.set();time.sleep(.5);return original(origin)
    monkeypatch.setattr(module,'_identity',slow)
    login=module.GatewayBrowserLogin(SimpleNamespace(),client_factory=lambda:httpx.AsyncClient(transport=httpx.MockTransport(lambda request:httpx.Response(200,json={'gateway_id':'g1','fingerprint':fp,'public_key_pem':pem}))))
    app=FastAPI();app.include_router(router);app.state.gateway_browser_login=login
    @app.get('/api/health')
    async def health(): return {'status':'ok'}
    async with AsyncClient(transport=ASGITransport(app=app,client=('127.0.0.1',1)),base_url='http://localhost:8765') as client:
        pending=asyncio.create_task(client.post('/api/gateway-platform/login',headers={'Origin':'http://localhost:8765'},json={'url':'http://localhost:8700'}))
        assert await asyncio.to_thread(entered.wait,2)
        started=time.monotonic(); assert (await client.get('/api/health')).status_code==200
        assert time.monotonic()-started < .2
        assert (await pending).status_code==200


@pytest.mark.asyncio
async def test_callback_sets_local_session_cookie_and_survives_desktop_browser_handoff(monkeypatch):
    from api.gateway_platform import router
    from services.desktop_security import DesktopSecurityMiddleware
    from services.gateway_client.browser_login import COOKIE
    monkeypatch.setenv('WORKSTEP_DESKTOP_RUNTIME', '1')
    monkeypatch.setenv('WORKSTEP_DESKTOP_TOKEN', 'runtime-secret')
    calls=[]
    class Login:
        async def complete(self, code, state):
            calls.append((code,state));return ('test-local-session',SimpleNamespace())
    app=FastAPI();app.include_router(router);app.add_middleware(DesktopSecurityMiddleware)
    app.state.gateway_browser_login=Login()
    async with AsyncClient(transport=ASGITransport(app=app,client=('127.0.0.1',1)),base_url='http://localhost:8765') as client:
        # The external browser callback does not possess Electron's runtime token.
        response=await client.get('/api/gateway-platform/callback',params={'code':'c'*32,'state':'s'*32})
        assert response.status_code==303
        assert response.headers['location']=='/?gateway_auth=complete'
        assert response.cookies[COOKIE]=='test-local-session'
        assert 'HttpOnly' in response.headers['set-cookie'] and 'SameSite=strict' in response.headers['set-cookie']
        assert calls==[('c'*32,'s'*32)]
