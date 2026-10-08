"""Channel source is current-turn context, independent of fixed system rules."""
import asyncio
import json
import threading
from types import SimpleNamespace

import pytest

from agent_assistants.coordinator import CoordinatorModule
from engines.core.acp_base import AcpEngineBase
from engines.core.events import InternalEvent
from engines.core.registry import ENGINE_REGISTRY
from models.message import Message
from models.task import Task
from services.channels.base import IncomingMessage
from services.channels.bots import _sender_actor
from services.project import ProjectManager
from services.remote_access import actor_context
from streaming.bus import EventBus


class SourceEngine(AcpEngineBase):
    ENGINE_ID = 'source_test'
    SYSTEM_PROMPT_MODE = 'system'
    calls = []
    async def _prepare_prompt_input(self, kwargs, system_prompt, *, each_turn=False):
        if self.SYSTEM_PROMPT_MODE == 'developer':
            from engines.codex_sdk import CodexSDKEngine
            return await CodexSDKEngine()._prepare_prompt_input(kwargs, system_prompt, each_turn=each_turn)
        return await super()._prepare_prompt_input(kwargs, system_prompt, each_turn=each_turn)
    @staticmethod
    def is_installed(): return True
    @staticmethod
    def get_version(): return 'test'
    @staticmethod
    def resolve_binary(): return 'test'
    @property
    def supports_resume(self): return True
    @property
    def supports_interactive(self): return False
    async def stop(self): pass
    async def inject_response(self,*args): pass
    async def spawn(self,prompt,cwd,model=None,session_id=None,**kwargs):
        type(self).calls.append({'prompt':prompt,'session_id':session_id,**kwargs})
        yield InternalEvent(type='session_started',data={'session_id':'source-session'})
        yield InternalEvent(type='agent_message_chunk',data={'content':{'text':json.dumps({'version':1,'reply':'ok','intent':'answer'})}})


@pytest.mark.parametrize('mode',['system','body','developer'])
async def test_channel_source_is_persisted_and_applied_to_current_turn_after_restart(tmp_path,monkeypatch,mode):
    monkeypatch.setitem(ENGINE_REGISTRY,'source_test',SourceEngine)
    monkeypatch.setattr(SourceEngine,'SYSTEM_PROMPT_MODE',mode)
    SourceEngine.calls = []
    if mode == 'developer':
        from engines.codex_sdk import CodexSDKEngine
        monkeypatch.setattr('engines.codex_sdk.config_store.get_codex_sdk_config', lambda: {'custom_config': ''})
        monkeypatch.setattr(CodexSDKEngine, '_saved_developer_instructions', staticmethod(
            lambda cwd, session_id: SourceEngine.calls[0].get('system_prompt') if SourceEngine.calls else None,
        ))
    projects = ProjectManager()
    project = projects.init_project(tmp_path/'project')
    await projects.run_db(project.id,lambda _project: Task.create(id='task',title='任务',cwd=str(project.path),coordinator_engine='source_test',created_at='2026-10-04',updated_at='2026-10-04'))
    bus = EventBus()
    module = CoordinatorModule(bus,projects,SimpleNamespace())
    monkeypatch.setattr(module,'_schedule_turn',lambda *args:None)
    accepted = []
    sources = []
    for index in [1,2]:
        message = IncomingMessage('bot',f'm{index}','group',f'group-{index}',f'user-{index}',f'问题{index}',sender_name=f'用户{index}',conversation_name=f'群{index}')
        source = {'platform':'wecom','bot_id':'bot','message_id':message.message_id,'conversation_type':'group',
                  'conversation_id':message.conversation_id,'conversation_name':message.conversation_name,
                  'sender_id':message.sender_id,'sender_name':message.sender_name,'secret':'must-not-reach-engine'}
        sources.append(source)
        with actor_context(_sender_actor(message,'wecom')):
            accepted.append(await module.submit_message(project.id,'task',message.text,f'request-{index}',channel_source=source))
    await module.shutdown()
    fresh = CoordinatorModule(bus,projects,SimpleNamespace())
    entered, release = threading.Event(), threading.Event()
    original_select = Message.select
    if mode == 'system':
        def slow_select(*args, **kwargs):
            if not release.is_set():
                entered.set()
                assert release.wait(3)
            return original_select(*args, **kwargs)
        monkeypatch.setattr(Message, 'select', slow_select)
    try:
        await fresh.start()
        if mode == 'system':
            import main
            from httpx import ASGITransport, AsyncClient
            assert await asyncio.to_thread(entered.wait, 1)
            async with AsyncClient(transport=ASGITransport(app=main.app),base_url='http://test') as client:
                assert (await asyncio.wait_for(client.get('/api/health'), .5)).status_code == 200
            release.set()
        async with asyncio.timeout(3):
            while len(SourceEngine.calls)<2 or fresh._active_tasks:
                await asyncio.sleep(.01)
        assert len(SourceEngine.calls)==2
        for index,call in enumerate(SourceEngine.calls,1):
            assert f'"conversation_id": "group-{index}"' in call['prompt']
            assert f'"sender_id": "user-{index}"' in call['prompt']
            assert 'must-not-reach-engine' not in call['prompt']
            assert 'Channel request background' not in (call.get('system_prompt') or '')
            assert call['prompt'].count('Your role is limited') == (1 if mode == 'body' and index == 1 else 0)
            if mode == 'developer':
                assert bool(call.get('system_prompt')) == (index == 1)
            def read(_project):
                user = Message.get_by_id(accepted[index-1].user_message_id)
                return user.content,json.loads(user.prompt_json)
            content,snapshot = await projects.run_db(project.id,read)
            assert content==f'问题{index}'
            assert snapshot['channel_source']['conversation_id']==f'group-{index}'
            assert 'secret' not in snapshot['channel_source']
        assert SourceEngine.calls[1]['session_id']=='source-session'
        from services.remote_access import ActorSnapshot
        with actor_context(ActorSnapshot(actor_id='web-user',user_name='网页用户',device_id='web',device_name='浏览器',source='local')):
            await fresh.submit_message(project.id,'task','来自网页的问题','web-request')
        async with asyncio.timeout(3):
            while len(SourceEngine.calls)<3 or fresh._active_tasks:
                await asyncio.sleep(.01)
        instruction = SourceEngine.calls[2]['prompt']
        assert '"origin": "workstep"' in instruction
        assert '"sender_id": "web-user"' in instruction
        assert 'group-2' not in instruction
        assert 'Your role is limited' not in instruction
        if mode == 'developer':
            assert not SourceEngine.calls[2].get('system_prompt')
    finally:
        release.set()
        await fresh.shutdown()
        await bus.close()
        projects.close_all()
