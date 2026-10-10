import asyncio
import base64
from types import SimpleNamespace
from urllib.parse import urlsplit

import pytest
from fastapi import Request
from workstep_gateway_protocol import FrameType, ProxyFrame

from gateway.api.adapters import gateway_call
from gateway.services.control_connection import DataConnection


@pytest.mark.asyncio
async def test_hook_proxy_is_anonymous_and_preserves_body_parameters():
    starts, bodies = [], []
    class Socket:
        async def send_json(self, message):
            frame = ProxyFrame.model_validate(message)
            if frame.type != FrameType.http_request:
                return
            if frame.payload['phase'] == 'start':
                starts.append(frame.payload)
            if frame.payload['phase'] == 'body':
                bodies.append(base64.b64decode(frame.payload['data']))
            if frame.payload['phase'] == 'end':
                for payload in [dict(phase='start', status=201, headers=[]), dict(phase='body', data=base64.b64encode(b'{"task_id":"created"}').decode()), dict(phase='end')]:
                    await connection.deliver(ProxyFrame(stream_id=frame.stream_id, type=FrameType.http_response, payload=payload))
    connection = DataConnection('gateway-device', Socket())
    async def receive():
        return {'type': 'http.request', 'body': b'{"raw":"body"}', 'more_body': False}
    request = Request({'type':'http','method':'POST','scheme':'https','path':'/api/hook/local-device/hook-1','query_string':b'token=secret&step_key=test&title=title&creator=creator','headers':[(b'host',b'gateway.example'),(b'content-type',b'application/json')],'server':('gateway.example',443)}, receive)
    result = await connection.proxy_http(gateway_call(request), hook_request=True)
    assert result.status == 201
    assert b'created' in b''.join([chunk async for chunk in result.chunks])
    assert starts[0]['hook_request'] is True
    assert 'user_id' not in starts[0] and 'share_ticket' not in starts[0]
    assert starts[0]['query'] == request.url.query
    assert b''.join(bodies) == b'{"raw":"body"}'
    call = gateway_call(request)
    call.target = urlsplit('https://gateway.example/api/task/create')
    with pytest.raises(ValueError):
        await connection.proxy_http(call, hook_request=True)


@pytest.mark.asyncio
async def test_public_gateway_hook_routes_to_device_without_login(tmp_path):
    import httpx
    from fastapi import FastAPI
    from gateway.config import GatewaySettings
    from gateway.database import GatewayDatabase
    from gateway.models import Device
    from gateway.api.workflow_hooks import router
    from gateway.api.errors import gateway_error_response
    from gateway.services.errors import GatewayError
    from gateway.contracts import StreamPayload
    database = GatewayDatabase(GatewaySettings(data_dir=tmp_path))
    await database.start()
    try:
        async with database.session() as session:
            async with session.begin():
                session.add(Device(id='platform-device', name='设备', public_key='test', hook_device_id='local-device', status='active'))
        forwarded = []
        async def proxy_http(call, **kwargs):
            forwarded.append((call.target.path, call.target.query, kwargs, b''.join([c async for c in call.payload()])))
            async def body(): yield b'{"task_id":"task"}'
            return StreamPayload(body(), status=201)
        async def request_data(device_id):
            assert device_id == 'platform-device'
            return SimpleNamespace(proxy_http=proxy_http)
        app = FastAPI()
        app.state.database = database
        app.state.settings = database.settings
        app.state.control_connections = SimpleNamespace(is_online=lambda _: True, request_data=request_data)
        app.add_exception_handler(GatewayError, gateway_error_response)
        app.include_router(router)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='https://gateway.example') as client:
            response = await client.post('/api/hook/local-device/hook-1?token=secret&step_key=test', content='完整正文', headers={'content-type':'text/plain'})
            assert response.status_code == 201 and response.json()['task_id'] == 'task'
            assert forwarded[0][0] == '/api/hook/local-device/hook-1'
            assert forwarded[0][2]['hook_request'] is True
            assert forwarded[0][3].decode() == '完整正文'
            assert (await client.post('/api/hook/unknown/hook-1?token=secret')).status_code == 404
            app.state.control_connections.is_online = lambda _: False
            assert (await client.post('/api/hook/local-device/hook-1?token=secret')).status_code == 503
    finally:
        await database.close()


@pytest.mark.asyncio
async def test_hook_device_identity_survives_reconnect_and_rejects_rebinding(tmp_path):
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives import serialization
    from gateway.config import GatewaySettings
    from gateway.database import GatewayDatabase
    from gateway.models import Device
    from gateway.services.workflow_hooks import bind_hook_identity
    database = GatewayDatabase(GatewaySettings(data_dir=tmp_path))
    await database.start()
    key = Ed25519PrivateKey.generate()
    try:
        async with database.session() as session:
            async with session.begin():
                session.add_all([Device(id=id, name=id, public_key='test', status='active') for id in ['one', 'two']])
        def hello(local_id):
            return {'hook_device_id':local_id,'authorization':'auth','control_public_key_pem':key.public_key().public_bytes(serialization.Encoding.PEM,serialization.PublicFormat.SubjectPublicKeyInfo).decode(),'hook_device_proof':base64.urlsafe_b64encode(key.sign(f'workstep-hook-device-v1:nonce:auth:{local_id}'.encode())).decode()}
        ws = SimpleNamespace(database=database)
        await bind_hook_identity(ws, 'one', hello('stable'), 'nonce')
        await bind_hook_identity(ws, 'one', hello('stable'), 'nonce')
        with pytest.raises(ValueError, match='immutable'):
            await bind_hook_identity(ws, 'one', hello('changed'), 'nonce')
        with pytest.raises(ValueError, match='another device'):
            await bind_hook_identity(ws, 'two', hello('stable'), 'nonce')
        with pytest.raises(ValueError, match='proof'):
            await bind_hook_identity(ws, 'one', {**hello('stable'), 'hook_device_proof':'bad'}, 'nonce')

        # A locked SQLite database must not stall unrelated HTTP requests.
        import sqlite3
        import threading
        import httpx
        from fastapi import FastAPI
        from sqlalchemy.engine import make_url
        acquired, release = threading.Event(), threading.Event()
        def lock_database():
            connection = sqlite3.connect(make_url(database.settings.effective_database_url).database)
            try:
                connection.execute('BEGIN EXCLUSIVE')
                acquired.set()
                release.wait(5)
            finally:
                connection.rollback()
                connection.close()
        locker = asyncio.create_task(asyncio.to_thread(lock_database))
        pending = None
        try:
            assert await asyncio.to_thread(acquired.wait, 2)
            pending = asyncio.create_task(bind_hook_identity(ws, 'one', hello('stable'), 'nonce'))
            await asyncio.sleep(0.05)
            assert not pending.done()
            app = FastAPI()
            @app.get('/health')
            async def health():
                return {'ok': True}
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
                response = await asyncio.wait_for(client.get('/health'), timeout=0.2)
                assert response.status_code == 200
        finally:
            release.set()
            await locker
            if pending is not None:
                await pending
    finally:
        await database.close()
