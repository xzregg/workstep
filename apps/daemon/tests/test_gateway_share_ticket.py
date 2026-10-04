import pytest

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization

from services.gateway_client.share_ticket import verify_share_ticket


def _ticket(*, device_id="device-1", mode="read_only", task_id="task-1",
            host_project_id="host-1", provider_scope=None):
    import base64
    import json
    import time
    import hashlib

    key = Ed25519PrivateKey.generate()
    pem = key.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode()
    der = key.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    fingerprint = hashlib.sha256(der).hexdigest()
    encode = lambda value: base64.urlsafe_b64encode(json.dumps(value).encode()).rstrip(b"=").decode()
    now = int(time.time())
    header = encode({"alg": "EdDSA", "typ": "JWT"})
    claims = {
        "iss": "gateway-1", "gateway_id": "gateway-1", "kind": "platform.share",
        "aud": "device-1", "device_id": device_id, "share_id": "share-1",
        "project_id": "project-1", "host_project_id": host_project_id,
        "task_id": task_id, "mode": mode, "jti": "a" * 24,
        "iat": now, "exp": now + 60,
    }
    if provider_scope is not None:
        claims.update(provider_scope)
    payload = encode(claims)
    signing_input = f"{header}.{payload}"
    ticket = f"{signing_input}.{base64.urlsafe_b64encode(key.sign(signing_input.encode())).rstrip(b'=').decode()}"
    return ticket, pem, fingerprint


def test_share_ticket_requires_pinned_key_device_and_exact_scope():
    ticket, pem, fingerprint = _ticket()
    scope = verify_share_ticket(ticket, pem, fingerprint, "gateway-1", "device-1")
    assert scope == {
        "share_id": "share-1", "project_id": "project-1", "host_project_id": "host-1",
        "task_id": "task-1", "mode": "read_only",
    }
    for kwargs in ({"expected_fingerprint": "0" * 64}, {"device_id": "device-2"},
                   {"gateway_id": "gateway-2"}):
        params = {"expected_fingerprint": fingerprint, "device_id": "device-1",
                  "gateway_id": "gateway-1"} | kwargs
        with pytest.raises(ValueError):
            verify_share_ticket(ticket, pem, **params)
    with pytest.raises(ValueError):
        verify_share_ticket(ticket + "x", pem, fingerprint, "gateway-1", "device-1")
    for bad in ({"mode": "admin"}, {"task_id": "../task"}):
        malformed, key, pin = _ticket(**bad)
        with pytest.raises(ValueError):
            verify_share_ticket(malformed, key, pin, "gateway-1", "device-1")


def test_share_provider_grants_are_signed_bounded_and_do_not_change_visitor_identity():
    import time
    expiry = int(time.time()) + 300
    ticket, pem, pin = _ticket(mode='interactive', provider_scope={
        'provider_ids': ['supplier'], 'provider_grant_expires_at': expiry,
    })
    scope = verify_share_ticket(ticket, pem, pin, 'gateway-1', 'device-1')
    assert scope['provider_ids'] == ['supplier']
    assert scope['provider_grant_expires_at'] == expiry
    assert 'user_id' not in scope
    for bad in ({'provider_ids': 'supplier', 'provider_grant_expires_at': expiry},
                {'provider_ids': ['supplier'], 'provider_grant_expires_at': expiry + 3600},
                {'provider_ids': ['supplier'], 'provider_grant_expires_at': True}):
        token, key, fingerprint = _ticket(mode='interactive', provider_scope=bad)
        with pytest.raises(ValueError):
            verify_share_ticket(token, key, fingerprint, 'gateway-1', 'device-1')

@pytest.mark.anyio
async def test_share_bridge_applies_only_signed_supplier_scope_and_keeps_visitor_actor():
    import asyncio
    import base64
    import json
    import time
    from types import SimpleNamespace
    from fastapi import FastAPI
    from services.config import ConfigStore
    from services.desktop_security import DesktopSecurityMiddleware
    from services.remote_access import get_current_actor
    from services.gateway_client.bridge import ManagedHttpBridge
    from workstep_gateway_protocol import FrameType, ProxyFrame
    app = FastAPI()
    app.state.gateway_client = SimpleNamespace(managed_config=object())
    app.add_middleware(DesktopSecurityMiddleware)
    @app.get('/api/platform-share/task')
    async def task():
        def check():
            actor = get_current_actor()
            store = SimpleNamespace(get=lambda *args: {'user_id': 'owner'})
            return {'actor': actor.actor_id,
                    'allowed': ConfigStore._provider_allowed_for_actor(store, 'supplier'),
                    'owner_only': ConfigStore._provider_allowed_for_actor(store, 'owner-supplier')}
        return await asyncio.to_thread(check)
    ticket, key, pin = _ticket(mode='interactive', provider_scope={
        'provider_ids': ['supplier'], 'provider_grant_expires_at': int(time.time()) + 300})
    async def request(extra):
        frames = []
        async def capture(frame): frames.append(frame)
        bridge = ManagedHttpBridge(app, 'share-provider', {
            'method': 'GET', 'path': '/api/platform-share/task', 'query': '', 'headers': [],
            'share_ticket': ticket, **extra}, capture, 'device-1', gateway_key=key,
            gateway_fingerprint=pin, gateway_id='gateway-1')
        bridge.start_task()
        await bridge.feed(ProxyFrame(stream_id='share-provider', type=FrameType.http_request, payload={'phase': 'end'}))
        await asyncio.wait_for(bridge._task, 3)
        body = b''.join(base64.b64decode(frame.payload['data']) for frame in frames if frame.payload.get('phase') == 'body')
        return frames[0].payload['status'], json.loads(body) if body else None
    assert await request({}) == (200, {'actor': 'share:share-1', 'allowed': True, 'owner_only': False})
    assert (await request({'provider_ids': ['owner-supplier']}))[0] == 502
