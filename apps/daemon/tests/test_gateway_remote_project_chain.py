"""Gateway data bridge -> device remote client -> host RPC and reverse event feed."""
import asyncio
import base64
import json
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, WebSocket
from httpx import ASGITransport, AsyncClient
from starlette.websockets import WebSocketDisconnect
from workstep_gateway_protocol import FrameType, ProxyFrame, WebSocketMessageAssembler, websocket_payloads

from api.desktop_security import DesktopSecurityMiddleware
from api.remote_project_proxy import RemoteProjectProxyMiddleware
from services.gateway_client.bridge import ManagedHttpBridge, ManagedWebSocketBridge
from services.remote_project import ActorSnapshot, RemoteAccessService, RemoteProjectClientManager, RemoteProjectRegistry, get_current_actor
from streaming.bus import EventBus
from services.messages import current_actor_message_fields
from streaming.remote_host import RemoteRouteDispatcher, serve_remote_project_socket
from tests.test_remote_project import MemoryConfig
import streaming.ws as ws_module


@pytest.mark.asyncio
@pytest.mark.parametrize('chunk_bytes', [1024 * 1024, 8])
async def test_gateway_device_forwards_remote_reads_writes_and_stream_without_scope_escape(monkeypatch, chunk_bytes):
    import services.remote_project as remote_client_module
    monkeypatch.setattr(remote_client_module, 'REMOTE_REQUEST_CHUNK_BYTES', chunk_bytes)
    host = FastAPI()
    slow = False
    writes = []
    authors = []
    message_authors = []
    entered, release = asyncio.Event(), asyncio.Event()
    @host.get('/api/chain')
    async def read(project_id: str):
        return {'project_id': project_id, 'source': 'host-b'}
    @host.post('/api/chain')
    async def write(project_id: str, body: dict):
        writes.append((project_id, body['value']))
        authors.append(get_current_actor())
        message_authors.append(current_actor_message_fields())
        if slow:
            entered.set()
            await release.wait()
        return {'project_id': project_id, 'saved': body['value']}

    host_bus, device_bus = EventBus(), EventBus()
    access = RemoteAccessService(MemoryConfig())
    access.update_settings(enabled=True, internal_base_url='http://host-b:8765', external_base_url='')
    shared = access.create_share(project_id='host-b-project', project_name='Host B', access='internal')
    registry = RemoteProjectRegistry(MemoryConfig())
    remote = registry.add_from_share(shared['share_string'])
    incoming, outgoing = asyncio.Queue(), asyncio.Queue()
    subscribed = asyncio.Event()

    class HostSocket:
        async def accept(self): pass
        async def receive_json(self):
            value = await incoming.get()
            if value is None: raise WebSocketDisconnect(1000)
            if value.get('type') == 'subscribe': subscribed.set()
            return value
        async def send_json(self, value): await outgoing.put(json.dumps(value))
        async def close(self, **kwargs): await outgoing.put(None)

    class ClientSocket:
        async def send(self, value): await incoming.put(json.loads(value))
        async def recv(self):
            value = await outgoing.get()
            if value is None: raise ConnectionError('closed')
            return value
        async def close(self): await incoming.put(None)

    dispatcher = RemoteRouteDispatcher(host)
    host_task = asyncio.create_task(serve_remote_project_socket(HostSocket(), dispatcher=dispatcher,
        access_service=access, event_bus=host_bus, project_summary=lambda p: {'id': p, 'name': 'Host B'}))
    async def connect(endpoint, **kwargs):
        assert endpoint == 'ws://host-b:8765/ws/remote-project'
        return ClientSocket()
    manager = RemoteProjectClientManager(registry=registry,
        actor_provider=lambda: ActorSnapshot('a', 'Device A user', 'device-a', 'Device A', 'local'),
        event_sink=device_bus.publish, connect_factory=connect)
    device = FastAPI()
    device.state.gateway_client = SimpleNamespace(managed_config=object())
    device.add_middleware(RemoteProjectProxyMiddleware, registry=registry, client_manager=manager)
    device.add_middleware(DesktopSecurityMiddleware)
    @device.get('/api/health')
    async def health(): return {'status': 'ok'}
    monkeypatch.setattr(ws_module, '_main', lambda: SimpleNamespace(event_bus=device_bus,
        remote_project_registry=registry, remote_project_client=manager))
    @device.websocket('/ws')
    async def feed(ws: WebSocket):
        assert await ws_module.desktop_websocket_allowed(ws)
        await ws.accept()
        queue = device_bus.subscribe()
        try:
            await ws_module._handle_client_message(await ws.receive_text(), ws_module.WsSubscription(), queue)
            while True:
                event = await queue.get()
                if event.get('task_id') == 'task-b':
                    await ws.send_json(event)
                    return
        finally: device_bus.unsubscribe(queue)

    async def request(method, *, scope=None, username='Gateway user'):
        frames = []
        async def capture(frame): frames.append(frame)
        bridge = ManagedHttpBridge(device, 'http-chain', {'method': method, 'path': '/api/chain',
            'query': 'project_id=' + remote['id'], 'headers': [['content-type', 'application/json']],
            'user_id': username, 'username': username,
            **({'project_id': scope, 'access_level': 'edit'} if scope else {})}, capture, 'device-a')
        bridge.start_task()
        await bridge.feed(ProxyFrame(stream_id='http-chain', type=FrameType.http_request,
            payload={'phase': 'body', 'data': base64.b64encode(b'{"value":"edited via gateway"}').decode()}))
        await bridge.feed(ProxyFrame(stream_id='http-chain', type=FrameType.http_request, payload={'phase': 'end'}))
        await asyncio.wait_for(bridge._task, 2)
        body = b''.join(base64.b64decode(f.payload['data']) for f in frames if f.payload.get('phase') == 'body')
        return frames[0].payload['status'], json.loads(body)

    try:
        assert await request('GET') == (200, {'project_id': 'host-b-project', 'source': 'host-b'})
        assert await request('POST') == (200, {'project_id': 'host-b-project', 'saved': 'edited via gateway'})
        assert authors[-1].user_name == 'Gateway user'
        assert authors[-1].username == 'Gateway user'
        assert message_authors[-1]['author_name'] == 'Gateway user'
        assert message_authors[-1]['author_username'] == 'Gateway user'
        assert (await request('POST', username='Second gateway user'))[0] == 200
        assert authors[-1].user_name == 'Second gateway user'
        assert authors[-1].actor_id == 'Second gateway user'
        assert authors[-1].device_id == 'device-a'
        assert message_authors[-1]['author_name'] == 'Second gateway user'
        slow = True
        pending = asyncio.create_task(request('POST'))
        await asyncio.wait_for(entered.wait(), 1)
        async with AsyncClient(transport=ASGITransport(app=device), base_url='http://device-a') as client:
            assert (await asyncio.wait_for(client.get('/api/health'), .3)).status_code == 200
        release.set()
        assert (await pending)[0] == 200
        slow = False
        writes_before_denial = len(writes)
        assert (await request('POST', scope='local-a-project'))[0] == 403
        assert len(writes) == writes_before_denial
        frames = []
        async def capture(frame): frames.append(frame)
        ws_bridge = ManagedWebSocketBridge(device, 'ws-chain', {'path': '/ws', 'query': '', 'headers': [],
            'user_id': 'gateway-user', 'username': 'Gateway user'}, capture, 'device-a')
        ws_bridge.start_task()
        for payload in websocket_payloads('text', json.dumps({'type': 'subscribe', 'project_id': remote['id'], 'task_ids': ['task-b']}).encode()):
            await ws_bridge.feed(ProxyFrame(stream_id='ws-chain', type=FrameType.websocket_data, payload=payload))
        await asyncio.wait_for(subscribed.wait(), 2)
        await host_bus.publish({'type': 'TEXT_MESSAGE_CONTENT', 'task_id': 'task-b', 'project_id': 'host-b-project',
                          'channel': 'execution', 'delta': 'reply from B'})
        await asyncio.wait_for(ws_bridge._task, 2)
        assembler = WebSocketMessageAssembler()
        messages = [assembler.add(f.payload) for f in frames if f.type == FrameType.websocket_data]
        event = json.loads(next(m[1] for m in messages if m))
        assert event['project_id'] == remote['id']
        assert event['delta'] == 'reply from B'
        # A Gateway session must not bypass B's own revocation checks, even
        # when A still has an authenticated, persistent connection to B.
        assert access.revoke_device('host-b-project', 'device-a') is True
        assert (await request('POST'))[0] == 403
        assert len(writes) == writes_before_denial
    finally:
        await manager.close()
        await incoming.put(None)
        await asyncio.wait_for(host_task, 2)
        await dispatcher.aclose()
