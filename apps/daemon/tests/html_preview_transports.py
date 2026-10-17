"""Real remote dispatcher and Gateway login/data proxy for browser fixtures."""
from contextlib import AsyncExitStack, asynccontextmanager
from types import SimpleNamespace
import base64

from fastapi import FastAPI
from httpx import AsyncClient, ASGITransport


@asynccontextmanager
async def browser_transport(host, mode, origin, tmp_path, monkeypatch):
    async with AsyncExitStack() as stack:
        project_id = 'project-1'
        upstream = host
        if 'remote' in mode:
            from api.remote_project_proxy import RemoteProjectProxyMiddleware
            from api.desktop_security import DesktopSecurityMiddleware
            from services.remote_access import RemotePrincipal, ActorSnapshot
            from services.remote_registry import RemoteProjectRegistry
            from streaming.remote_host import RemoteRouteDispatcher
            from tests.test_remote_project import MemoryConfig
            dispatcher = RemoteRouteDispatcher(host)
            stack.push_async_callback(dispatcher.aclose)
            principal = RemotePrincipal(project_id='project-1', actor=ActorSnapshot('device', 'Browser tester', 'device', 'Fixture', 'remote'))
            class Manager:
                async def request(self, project_id, request):
                    assert project_id == 'remote:abc'
                    return await dispatcher.dispatch(request, principal)
            config = MemoryConfig()
            config.set('remote_projects', [{'id': 'remote:abc', 'name': 'Fixture'}])
            upstream = FastAPI()
            upstream.add_middleware(RemoteProjectProxyMiddleware, registry=RemoteProjectRegistry(config), client_manager=Manager())
            upstream.add_middleware(DesktopSecurityMiddleware)
            upstream.mount('/', host)
            project_id = 'remote:abc'
        app, prefix = upstream, ''
        if 'gateway' in mode:
            from gateway.app import create_app
            from gateway.config import GatewaySettings
            from gateway.models import Device
            from gateway.services.control_connection import DataConnection
            from workstep_gateway_protocol import FrameType, ProxyFrame
            app = create_app(GatewaySettings(data_dir=tmp_path / 'gateway', gateway_id='browser-gateway', public_origin=origin))
            await stack.enter_async_context(app.router.lifespan_context(app))
            upstream_client = await stack.enter_async_context(AsyncClient(transport=ASGITransport(app=upstream), base_url='http://host.internal'))
            class Socket:
                def __init__(self): self.requests = {}
                async def send_json(self, message):
                    frame = ProxyFrame.model_validate(message)
                    if frame.type != FrameType.http_request: return
                    payload = frame.payload
                    if payload['phase'] == 'start':
                        self.requests[frame.stream_id] = (payload, bytearray())
                    elif payload['phase'] == 'body':
                        self.requests[frame.stream_id][1].extend(base64.b64decode(payload['data']))
                    elif payload['phase'] == 'end':
                        start, body = self.requests.pop(frame.stream_id)
                        # The actual signed bridge is independently covered by
                        # test_gateway_workspace_bridge; this fixture transports
                        # real HTTP through DataConnection without a live device.
                        headers = dict(start['headers'])
                        headers['x-workstep-desktop-token'] = 'test-desktop-token'
                        response = await upstream_client.request(start['method'], start['path'] + ('?' + start['query'] if start['query'] else ''), headers=headers, content=bytes(body))
                        for part in ({'phase': 'start', 'status': response.status_code, 'headers': [list(pair) for pair in response.headers.multi_items()]},
                                     {'phase': 'body', 'data': base64.b64encode(response.content).decode()}, {'phase': 'end'}):
                            await connection.deliver(ProxyFrame(stream_id=frame.stream_id, type=FrameType.http_response, payload=part))
            connection = DataConnection('device-1', Socket())
            async def data(_device_id): return connection
            monkeypatch.setattr(app.state.control_connections, 'request_data', data)
            monkeypatch.setattr(app.state.control_connections, 'is_online', lambda _: True)
            prefix = '/workspace/device-1'
        client = await stack.enter_async_context(AsyncClient(transport=ASGITransport(app=app), base_url=origin))
        if prefix:
            setup = await client.post('/api/platform/setup', json={
                'username': 'owner', 'display_name': 'Owner', 'password': 'OwnerPassphrase-2026!',
                'recovery_username': 'recovery', 'recovery_password': 'RecoveryPassphrase-2026!', 'registration_mode': 'open',
            })
            assert setup.status_code == 201, setup.text
            async with app.state.database.session() as session:
                async with session.begin():
                    session.add(Device(id='device-1', name='Fixture PC', public_key='fixture', status='active', owner_user_id=setup.json()['user']['id']))
            access = await client.get('/api/devices/device-1/access')
            assert access.status_code == 200, access.text
            redeemed = await client.post(prefix + '/api/remote/redeem', data={'ticket': access.json()['ticket']})
            assert redeemed.status_code == 303, redeemed.text
        cookies = [{'name': cookie.name, 'value': cookie.value, 'domain': cookie.domain,
                    'path': cookie.path, 'secure': cookie.secure, 'httpOnly': True, 'sameSite': 'Lax'} for cookie in client.cookies.jar]
        async def revoke():
            from gateway.services.identity import IdentityService
            token = next(cookie['value'] for cookie in cookies if cookie['path'].startswith(prefix + '/'))
            await IdentityService(app.state.database).logout(token)
        yield SimpleNamespace(app=app, client=client, project_id=project_id, prefix=prefix, cookies=cookies,
                              revoke=revoke if prefix else None)
