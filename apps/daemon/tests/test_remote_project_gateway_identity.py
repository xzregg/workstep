"""Remote project connections use Gateway identity without a local user name."""
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

import main
import api.remote_project as remote_api
from services.remote_access import ActorSnapshot, RemotePrincipal, actor_context, get_current_actor
from services.remote_protocol import RemoteHttpRequest
from streaming.remote_host import RemoteRouteDispatcher


@pytest.mark.asyncio
@pytest.mark.parametrize('display_name', ['网关用户', ''])
async def test_gateway_identity_allows_adding_remote_project_without_local_name(monkeypatch, display_name):
    monkeypatch.setattr(remote_api.config_store, 'get_user_name', lambda: '')
    monkeypatch.setattr(main.config_store, 'get_device_identity', lambda: {
        'device_id': 'device-a', 'device_name': 'Device A'})
    actor = SimpleNamespace(user_id='gateway-user', username='assigned-user', display_name=display_name)
    monkeypatch.setattr(main, 'gateway_client', SimpleNamespace(managed_config=object(), current_actor=actor))

    class Manager:
        async def add_share(self, value):
            identity = main._local_actor()
            assert identity.user_name == (display_name or 'assigned-user')
            assert identity.actor_id == 'gateway-user'
            assert identity.device_id == 'device-a'
            return {'id': 'remote-b'}

    monkeypatch.setattr(remote_api, 'client_manager', Manager())
    app = FastAPI()
    app.state.gateway_client = main.gateway_client
    app.include_router(remote_api.router)
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
        response = await client.post('/api/remote-project/add', json={'share_string': 'test-share'})
    assert response.status_code == 200


def test_gateway_request_identity_takes_precedence_over_device_account(monkeypatch):
    monkeypatch.setattr(main.config_store, 'get_user_name', lambda: '旧本地姓名')
    monkeypatch.setattr(main.config_store, 'get_device_identity', lambda: {
        'device_id': 'device-a', 'device_name': 'Device A'})
    with actor_context(ActorSnapshot('visiting-user', '访问用户', 'device-a', 'Device A', 'managed')):
        assert main._local_actor().user_name == '访问用户'


def test_local_remote_project_still_requires_local_name(monkeypatch):
    monkeypatch.setattr(main.config_store, 'get_user_name', lambda: '')
    monkeypatch.setattr(main.config_store, 'get_device_identity', lambda: {
        'device_id': 'device-a', 'device_name': 'Device A'})
    monkeypatch.setattr(main, 'gateway_client', SimpleNamespace(managed_config=None, current_actor=None))
    with pytest.raises(ValueError, match='使用者名称'):
        main._local_actor()


@pytest.mark.asyncio
async def test_request_attribution_cannot_replace_remote_device_or_project_permissions():
    app = FastAPI()

    @app.get('/api/identity')
    async def identity(project_id: str):
        actor = get_current_actor()
        return {'name': actor.user_name, 'project_id': project_id,
                'device_id': actor.device_id, 'access_level': actor.access_level,
                'source': actor.source}

    principal = RemotePrincipal('host-project', ActorSnapshot(
        'device-user', '设备用户', 'device-a', 'Device A', 'remote',
        project_id='host-project', access_level='read'))
    dispatcher = RemoteRouteDispatcher(app)
    try:
        delegated = await dispatcher.dispatch(RemoteHttpRequest('one', 'GET', '/api/identity', actor={
            'actor_id': 'gateway-user', 'user_name': 'test', 'username': 'test',
            'device_id': 'fake-device', 'access_level': 'edit', 'source': 'managed',
            'project_id': 'other-project',
        }), principal)
        assert delegated.json() == {'name': 'test', 'project_id': 'host-project',
                                    'device_id': 'device-a', 'access_level': 'read', 'source': 'remote'}
        legacy = await dispatcher.dispatch(RemoteHttpRequest('two', 'GET', '/api/identity'), principal)
        assert legacy.json()['name'] == '设备用户'
        with pytest.raises(ValueError, match='actor identity'):
            await dispatcher.dispatch(RemoteHttpRequest('bad', 'GET', '/api/identity', actor={
                'actor_id': 'gateway-user', 'user_name': '', 'username': 'test',
            }), principal)
    finally:
        await dispatcher.aclose()
