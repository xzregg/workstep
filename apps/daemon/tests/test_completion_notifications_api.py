from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from api.completion_notifications import router
from services.remote_access import ActorSnapshot, RemotePrincipal, actor_context
from services.remote_protocol import RemoteHttpRequest
from streaming.remote_host import RemoteRouteDispatcher
import json


PAYLOAD = {'subscription': {'endpoint': 'https://fcm.googleapis.com/example',
    'keys': {'p256dh': 'public', 'auth': 'secret'}}, 'project_id':'p1',
    'project_name':'示例项目', 'task_ids':['t1']}


def app_with_push():
    app = FastAPI()
    app.include_router(router)
    app.state.completion_push = SimpleNamespace(register=AsyncMock(), remove=AsyncMock())
    return app


@pytest.mark.parametrize('origin,expected', [
    ('https://workstep.base.packertec.com', 200),
    ('https://evil.test', 403),
    ('https://workstep.base.packertec.com:444', 403),
    (None, 403),
])
@pytest.mark.asyncio
async def test_notification_subscription_uses_same_host_through_tls_proxy(origin, expected):
    app = app_with_push()
    headers = {'Origin':origin} if origin else {}
    async with AsyncClient(transport=ASGITransport(app=app),base_url='http://workstep.base.packertec.com') as client:
        with actor_context(ActorSnapshot('owner','所有者','desktop','设备','managed')):
            response = await client.post('/api/completion-notifications/subscriptions',json=PAYLOAD,headers=headers)
        assert response.status_code == expected
        if expected == 200:
            app.state.completion_push.register.assert_awaited_once()
        else:
            app.state.completion_push.register.assert_not_awaited()


@pytest.mark.asyncio
async def test_remote_notification_subscription_uses_bound_share_project_without_origin_header():
    app = app_with_push()
    dispatcher = RemoteRouteDispatcher(app)
    principal = RemotePrincipal('owner-project',ActorSnapshot('guest','访客','device','浏览器','remote',project_id='owner-project'))
    try:
        response = await dispatcher.dispatch(RemoteHttpRequest(
            request_id='notification',method='POST',path='/api/completion-notifications/subscriptions',
            headers={'content-type':'application/json'},body=json.dumps(PAYLOAD).encode()),principal)
        assert response.status == 200
        assert app.state.completion_push.register.await_args.args[1] == 'owner-project'
    finally:
        await dispatcher.aclose()


@pytest.mark.asyncio
async def test_project_scoped_notification_identity_cannot_subscribe_other_project():
    app = app_with_push()
    async with AsyncClient(transport=ASGITransport(app=app),base_url='https://workstep.example') as client:
        with actor_context(ActorSnapshot('guest','访客','device','设备','managed',project_id='allowed-project')):
            response = await client.post('/api/completion-notifications/subscriptions',json=PAYLOAD,
                headers={'Origin':'https://workstep.example'})
        assert response.status_code == 403
        assert response.json()['detail'] == '不能订阅其他项目'
        app.state.completion_push.register.assert_not_awaited()
