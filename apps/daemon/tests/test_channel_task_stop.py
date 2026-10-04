"""Channel stop targets one live stage engine with database work isolated."""
import asyncio
import threading
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from httpx import ASGITransport, AsyncClient

import main
from models.message import Message
from models.task import Task
from services.project import ProjectManager
from services.step_live_messages import StepLiveMessages
from services.workflow_runtime import WorkflowRuntime
from streaming.bus import EventBus


@pytest.mark.parametrize('channel', ['execution','review'])
async def test_message_stop_keeps_health_responsive_and_stops_only_current_engine(tmp_path,monkeypatch,channel):
    projects=ProjectManager()
    project=projects.init_project(tmp_path/'project')
    def seed(_project):
        Task.create(id='task',title='任务',cwd=str(project.path),created_at='2026-10-04',updated_at='2026-10-04')
        Message.create(id='message',task='task',step_key='build',channel=channel,role='assistant',run_status='running',position=0,created_at='2026-10-04')
    await projects.run_db(project.id,seed)
    bus=EventBus()
    runtime=WorkflowRuntime(bus,projects)
    live=StepLiveMessages(None,None,None,None)
    engine=SimpleNamespace(stop=AsyncMock())
    other=SimpleNamespace(stop=AsyncMock())
    live.set_engine('task:build',engine)
    live.set_engine('task:other',other)
    runtime._runners['task']=SimpleNamespace(_live=live,cancel_step=live.cancel_step)
    entered,release=threading.Event(),threading.Event()
    original=Message.get_or_none
    def slow(*args,**kwargs):
        entered.set()
        assert release.wait(2)
        return original(*args,**kwargs)
    monkeypatch.setattr(Message,'get_or_none',slow)
    pending=asyncio.create_task(runtime.cancel_message(project.id,'task','message'))
    try:
        assert await asyncio.to_thread(entered.wait,1)
        async with AsyncClient(transport=ASGITransport(app=main.app),base_url='http://test') as client:
            assert (await asyncio.wait_for(client.get('/api/health'),.5)).status_code==200
    finally:
        release.set()
    try:
        assert await pending is True
        engine.stop.assert_awaited_once()
        other.stop.assert_not_awaited()
        # An old card cannot stop the next engine, even while stale SQL is delayed.
        replacement=SimpleNamespace(stop=AsyncMock())
        live.set_engine('task:build',replacement)
        await projects.run_db(project.id,lambda _project:Message.update(run_status='completed').where(Message.id=='message').execute())
        assert await runtime.cancel_message(project.id,'task','message') is False
        replacement.stop.assert_not_awaited()
        assert await runtime.cancel_message(project.id,'task','missing') is False
    finally:
        runtime._runners.clear()
        await bus.close()
        projects.close_all()


async def test_engine_replacement_during_message_check_is_not_stopped(tmp_path,monkeypatch):
    projects=ProjectManager()
    project=projects.init_project(tmp_path/'project')
    def seed(_project):
        Task.create(id='task',title='任务',cwd=str(project.path),created_at='2026-10-04',updated_at='2026-10-04')
        Message.create(id='message',task='task',step_key='build',channel='execution',role='assistant',run_status='running',position=0,created_at='2026-10-04')
    await projects.run_db(project.id,seed)
    bus=EventBus()
    runtime=WorkflowRuntime(bus,projects)
    old,new=object(),object()
    live=SimpleNamespace(_running_engines={'task:build':old})
    runner=SimpleNamespace(_live=live,cancel_step=AsyncMock())
    runtime._runners['task']=runner
    original=runtime._run_db
    async def change(*args):
        result=await original(*args)
        live._running_engines['task:build']=new
        return result
    monkeypatch.setattr(runtime,'_run_db',change)
    try:
        assert await runtime.cancel_message(project.id,'task','message') is False
        runner.cancel_step.assert_not_awaited()
    finally:
        runtime._runners.clear()
        await bus.close()
        projects.close_all()
