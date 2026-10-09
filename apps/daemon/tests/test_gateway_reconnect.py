import asyncio
import threading
import time
from types import SimpleNamespace

import pytest

from services.gateway_client import service as module
from services.gateway_client.identity import ManagedActor


@pytest.mark.asyncio
async def test_restart_restores_control_credentials_and_signed_account(tmp_path, monkeypatch):
    monkeypatch.setattr(module.config_module, 'CONFIG_DIR', tmp_path)
    starts = []

    class Control:
        online = False
        authorization_required = False
        def __init__(self, origin, **kwargs):
            self.persist = kwargs['on_reconnect_token']
        def start(self, *args, reconnect_token=None):
            starts.append((args, reconnect_token))
        async def stop(self): pass

    actor = ManagedActor('u1', 'alice', 'd1', 'i1', 1, display_name='网关用户')
    class Verifier:
        async def verify(self, *args, **kwargs):
            return actor

    config = SimpleNamespace(gateway_id='g1', gateway_origin='https://gateway.test', gateway_public_key_fingerprint='pin')
    first = module.GatewayClientService(Control)
    first.managed_config = config; first.verifier = Verifier()
    await first.bootstrap('authorization', 'proof', 'private', 'public', 'delegation')
    await first.control_client.persist('renewed-token')
    await first.close()
    second = module.GatewayClientService(Control)
    second.managed_config = config; second.verifier = Verifier()
    await second.restore_connection()
    assert starts[-1][1] == 'renewed-token'
    assert second.current_actor.display_name == '网关用户'
    assert second.policy_cache.current is None  # Reconnect does not restore old permissions.
    assert (tmp_path / 'gateway-connections').stat().st_mode & 0o777 == 0o700
    assert next((tmp_path / 'gateway-connections').glob('*.json')).stat().st_mode & 0o777 == 0o600
    await second.close()


@pytest.mark.asyncio
async def test_slow_credential_disk_does_not_block_event_loop(tmp_path, monkeypatch):
    monkeypatch.setattr(module.config_module, 'CONFIG_DIR', tmp_path)
    from services.gateway_client import connection_credentials
    entered = threading.Event()
    def slow(*args):
        entered.set(); time.sleep(.4); return None
    monkeypatch.setattr(connection_credentials, 'load', slow)
    service = module.GatewayClientService()
    service.managed_config = SimpleNamespace(gateway_origin='https://gateway.test')
    pending = asyncio.create_task(service.restore_connection())
    assert await asyncio.to_thread(entered.wait, 1)
    from fastapi import FastAPI
    import httpx
    app = FastAPI()
    @app.get('/api/health')
    async def health(): return {'status':'ok'}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://localhost') as client:
        assert (await asyncio.wait_for(client.get('/api/health'), timeout=.1)).json() == {'status':'ok'}
    await pending


@pytest.mark.asyncio
async def test_expired_authorization_requires_pinned_signed_reconnect_bound_to_control_key():
    import base64, hashlib, json
    import httpx
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from services.gateway_client.identity import ManagedAuthorizationVerifier
    gateway = Ed25519PrivateKey.generate(); device = Ed25519PrivateKey.generate(); control = Ed25519PrivateKey.generate()
    def enc(value): return base64.urlsafe_b64encode(value).rstrip(b'=').decode()
    def pem(key): return key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode()
    def fingerprint(key): return hashlib.sha256(key.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)).hexdigest()
    now = int(time.time())
    claims = dict(gateway_id='g1', iss='g1', user_id='u1', username='alice', display_name='网关用户', device_id='d1',
        app_instance_id='i1', policy_revision=1, device_public_key=pem(device), iat=now-1000, exp=now-100)
    payload = enc(json.dumps({'alg':'EdDSA','typ':'JWT'}).encode()) + '.' + enc(json.dumps(claims).encode())
    authorization = payload + '.' + enc(gateway.sign(payload.encode()))
    proof = enc(device.sign(authorization.encode()))
    reconnect_claims = dict(kind='control.reconnect', gateway_id='g1', authorization_hash=hashlib.sha256(authorization.encode()).hexdigest(),
        control_key_hash=fingerprint(control), iat=now, exp=now+3600)
    def sign_reconnect(value):
        payload = enc(json.dumps(value).encode()); return payload + '.' + enc(gateway.sign(payload.encode()))
    verifier = ManagedAuthorizationVerifier('g1', 'https://gateway.test', fingerprint(gateway), client_factory=lambda:
        httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, json=dict(gateway_id='g1', fingerprint=fingerprint(gateway), public_key_pem=pem(gateway))))))
    with pytest.raises(ValueError): await verifier.verify(authorization, proof)
    actor = await verifier.verify(authorization, proof, reconnect_token=sign_reconnect(reconnect_claims), control_public_key_pem=pem(control))
    assert actor.display_name == '网关用户'
    for change in [dict(exp=now-1), dict(authorization_hash='wrong'), dict(control_key_hash='wrong'), dict(gateway_id='wrong')]:
        with pytest.raises(ValueError):
            await verifier.verify(authorization, proof, reconnect_token=sign_reconnect({**reconnect_claims, **change}), control_public_key_pem=pem(control))
