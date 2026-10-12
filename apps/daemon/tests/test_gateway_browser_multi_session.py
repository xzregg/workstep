"""Separate browser origins must not replace each other's device login."""

import base64
import hashlib
import json
import time
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit
from unittest.mock import AsyncMock

import httpx
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi import FastAPI, Request

from api.desktop_security import DesktopSecurityMiddleware
from api.gateway_platform import router
from services.gateway_client import GatewayClientService, browser_login
from services.gateway_client.identity import ManagedAuthorizationVerifier


@pytest.mark.asyncio
@pytest.mark.parametrize('second_login', ['same_account', 'reauthorize', 'other_account', 'other_device'])
async def test_browser_authorization_keeps_independent_origin_sessions(tmp_path, monkeypatch, second_login):
    monkeypatch.delenv('WORKSTEP_DESKTOP_RUNTIME', raising=False)
    monkeypatch.delenv('WORKSTEP_MANAGED_BUNDLE_DIR', raising=False)
    monkeypatch.setattr(browser_login.config_module, 'CONFIG_DIR', tmp_path)
    stored = {'url': 'https://gateway.test', 'enabled': True}
    monkeypatch.setattr(browser_login.config_store, 'get', lambda key, default=None: dict(stored) if key == 'gateway_platform' else default)
    monkeypatch.setattr(browser_login.config_store, 'set', lambda key, value: stored.update(value))
    monkeypatch.setattr(browser_login.config_store, 'set_managed_gateway_id', lambda *args, **kwargs: None)
    monkeypatch.setattr(browser_login.connection_credentials, 'save', lambda *args: None)
    monkeypatch.setattr(browser_login.connection_credentials, 'delete', lambda *args: None)
    key = Ed25519PrivateKey.generate()
    public = key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode()
    fingerprint = hashlib.sha256(key.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)).hexdigest()
    user_id = 'alice'
    device_id = 'd1'
    invalid_signature = False

    def encode(value):
        return base64.urlsafe_b64encode(value).decode().rstrip('=')

    def handler(request):
        if request.url.path.endswith('gateway-key'):
            return httpx.Response(200, json={'gateway_id': 'g1', 'fingerprint': fingerprint, 'public_key_pem': public})
        body = json.loads(request.content)
        claims = {'gateway_id': 'g1', 'iss': 'g1', 'iat': int(time.time()), 'exp': int(time.time()) + 900,
                  'user_id': user_id, 'username': user_id, 'device_id': device_id,
                  'app_instance_id': body['app_instance_id'], 'policy_revision': 1,
                  'device_public_key': body['device_public_key']}
        unsigned = encode(json.dumps({'alg': 'EdDSA', 'typ': 'JWT'}).encode()) + '.' + encode(json.dumps(claims).encode())
        signature = b'x' * 64 if invalid_signature else key.sign(unsigned.encode())
        return httpx.Response(200, json={'device_authorization': unsigned + '.' + encode(signature)})

    factory = lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler))
    controls = []

    class Control:
        def __init__(self, *args, **kwargs):
            self.online = True
            self.authorization_required = False
            self.stop = AsyncMock()
            controls.append(self)

        def start(self, *args, **kwargs):
            pass

    gateway = GatewayClientService(control_client_factory=Control)

    async def start():
        gateway.managed_config = SimpleNamespace(gateway_origin=stored['url'], gateway_id='g1', gateway_public_key_fingerprint=fingerprint)
        gateway.verifier = ManagedAuthorizationVerifier('g1', stored['url'], fingerprint, client_factory=factory)

    monkeypatch.setattr(gateway, 'start', start)
    login = browser_login.GatewayBrowserLogin(gateway, client_factory=factory)
    app = FastAPI()
    app.add_middleware(DesktopSecurityMiddleware)
    app.include_router(router)
    app.state.gateway_client = gateway
    app.state.gateway_browser_login = login

    @app.get('/api/private')
    async def private(request: Request):
        return {'user_id': request.state.managed_actor.user_id}

    async def authorize(client):
        response = await client.post('/api/gateway-platform/login', json={'url': stored['url']}, headers={'Origin': str(client.base_url).rstrip('/')})
        assert response.status_code == 200, response.text
        state = parse_qs(urlsplit(response.json()['authorization_url']).query)['state'][0]
        response = await client.get('/api/gateway-platform/callback', params={'code': 'c' * 32, 'state': state})
        assert response.status_code == 303, response.text
        assert (await client.get('/api/private')).json() == {'user_id': user_id}

    transport = httpx.ASGITransport(app=app, client=('127.0.0.1', 123))
    async with httpx.AsyncClient(transport=transport, base_url='http://localhost:5173') as local, httpx.AsyncClient(transport=transport, base_url='https://public.test') as public_client:
        await authorize(local)
        login.desktop_local_session = local.cookies.get(login.cookie_name)
        desktop_session = login.desktop_local_session
        first_control = controls[0]
        if second_login == 'other_account':
            user_id = 'bob'
        elif second_login == 'reauthorize':
            first_control.authorization_required = True
        elif second_login == 'other_device':
            device_id = 'd2'
        await authorize(public_client)
        previous = await local.get('/api/private')
        changed_identity = second_login in ('other_account', 'other_device')
        assert previous.status_code == (401 if changed_identity else 200)
        assert login.desktop_local_session == (None if changed_identity else desktop_session)
        if second_login == 'same_account':
            assert len(controls) == 1, 'Another browser login must not restart the device connection'
            first_control.stop.assert_not_awaited()
            await authorize(local)
            assert (await public_client.get('/api/private')).status_code == 200
            invalid_signature = True
            response = await local.post('/api/gateway-platform/login', json={'url': stored['url']}, headers={'Origin': 'http://localhost:5173'})
            state = parse_qs(urlsplit(response.json()['authorization_url']).query)['state'][0]
            response = await local.get('/api/gateway-platform/callback', params={'code': 'c' * 32, 'state': state})
            assert response.status_code == 400
            assert (await local.get('/api/private')).status_code == 200
            assert (await public_client.get('/api/private')).status_code == 200
            assert len(controls) == 1
        else:
            first_control.stop.assert_awaited_once()
        response = await public_client.post('/api/gateway-platform/logout', headers={'Origin': 'https://public.test'})
        assert response.status_code == 200
        assert (await local.get('/api/private')).status_code == 401
        assert (await public_client.get('/api/private')).status_code == 401
