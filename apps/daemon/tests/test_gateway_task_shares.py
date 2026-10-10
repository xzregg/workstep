import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock
import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from api.gateway_task_shares import router
from api.desktop_security import DesktopSecurityMiddleware
from services.gateway_client.identity import ManagedActor, ManagedLocalSessions
from services.gateway_client.control import GatewayControlClient
from services.gateway_client.policy import ManagedPolicyCache


@pytest.mark.asyncio
async def test_native_gateway_task_share_uses_validated_owner_and_same_origin(monkeypatch):
    monkeypatch.setenv('WORKSTEP_DESKTOP_RUNTIME','1')
    monkeypatch.setenv('WORKSTEP_DESKTOP_TOKEN','desktop-secret')
    app=FastAPI();app.include_router(router);app.add_middleware(DesktopSecurityMiddleware)
    sessions=ManagedLocalSessions();token=sessions.create(ManagedActor('owner','Owner','device-1','app',1))
    control=SimpleNamespace(manage_task_share=AsyncMock(return_value={'shares':[]}))
    app.state.gateway_client=SimpleNamespace(managed_config=object(),control_client=control,
        local_sessions=sessions,device_id='device-1',current_user_id='owner')
    async with AsyncClient(transport=ASGITransport(app=app),base_url='http://localhost:8767') as client:
        client.cookies.set('workstep_platform_local_session',token)
        result=await client.get('/api/gateway-task-shares?project_id=host-1&task_id=task-1')
        assert result.status_code==200
        control.manage_task_share.assert_awaited_once_with('device-1','host-1','list',{'task_id':'task-1'})
        denied=await client.post('/api/gateway-task-shares',json={'project_id':'host-1','task_id':'task-1'},headers={'Origin':'https://evil.test'})
        assert denied.status_code==403
        control.manage_task_share.reset_mock()
        response=await client.post('/api/gateway-task-shares',json={'project_id':'host-1','task_id':'task-1'},headers={'Origin':'http://localhost:8767'})
        assert response.status_code==200
        assert control.manage_task_share.await_args.args[2]=='create'
        control.manage_task_share.reset_mock()
        guest=sessions.create(ManagedActor('guest','Guest','device-1','app',1))
        client.cookies.set('workstep_platform_local_session',guest)
        denied=await client.get('/api/gateway-task-shares?project_id=host-1&task_id=task-1')
        assert denied.status_code==403
        control.manage_task_share.assert_not_awaited()


@pytest.mark.asyncio
async def test_gateway_control_task_share_correlates_reply_and_recovers_after_denial():
    control=GatewayControlClient('https://gateway.test',gateway_id='gateway-test',public_key_fingerprint='f',
        user_id='owner',policy_cache=ManagedPolicyCache())
    queue=asyncio.Queue();control._task_share_ack_messages=queue;control.online=True
    replies=[{'ok':False,'error':'分享权限不足'}, {'ok':True,'result':{'url':'https://gateway.test/share/token'}}]
    async def send(value):
        request=json.loads(value)
        await queue.put({'kind':'task_share_ack','request_id':'stale','ok':True,'result':{}})
        await queue.put({'kind':'task_share_ack','version':1,'device_id':'device-1',
            'request_id':request['request_id'],**replies.pop(0)})
    control._active_socket=SimpleNamespace(send=send)
    with pytest.raises(PermissionError,match='分享权限不足'):
        await control.manage_task_share('device-1','host-1','create',{'task_id':'task-1'})
    result=await control.manage_task_share('device-1','host-1','create',{'task_id':'task-1'})
    assert result['url']=='https://gateway.test/share/token'


@pytest.mark.asyncio
async def test_slow_gateway_share_reply_keeps_local_health_responsive(monkeypatch):
    monkeypatch.setenv('WORKSTEP_DESKTOP_RUNTIME','1');monkeypatch.setenv('WORKSTEP_DESKTOP_TOKEN','desktop-secret')
    app=FastAPI();app.include_router(router);app.add_middleware(DesktopSecurityMiddleware)
    entered=asyncio.Event();release=asyncio.Event()
    async def slow_share(*args):
        entered.set();await release.wait();return {'shares':[]}
    app.state.gateway_client=SimpleNamespace(managed_config=object(),local_sessions=ManagedLocalSessions(),
        control_client=SimpleNamespace(manage_task_share=slow_share),device_id='device-1',current_user_id='owner')
    @app.get('/api/health')
    async def health():return {'ok':True}
    async with AsyncClient(transport=ASGITransport(app=app),base_url='http://localhost:8767',headers={'X-WorkStep-Desktop-Token':'desktop-secret'}) as client:
        pending=asyncio.create_task(client.get('/api/gateway-task-shares?project_id=host-1&task_id=task-1'))
        await asyncio.wait_for(entered.wait(),1)
        try:
            assert (await asyncio.wait_for(client.get('/api/health'),.1)).status_code==200
            assert not pending.done()
        finally:release.set()
        assert (await pending).status_code==200
