import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import pytest
pytest.importorskip("tau_agent", reason="Tau SDK is installed manually")
from engines import tau as adapter

@pytest.fixture(autouse=True)
def isolated_tau_sessions(tmp_path, monkeypatch):
    monkeypatch.setattr(adapter, "CONFIG_DIR", tmp_path)


class MappingTests(unittest.TestCase):
    def setUp(self):
        self.engine = adapter.TauEngine()

    def test_text_and_thought(self):
        for native, expected in [('text_delta','agent_message_chunk'),('thinking_delta','agent_thought_chunk')]:
            events = self.engine.map_event({'type':'message_update','assistantMessageEvent':{'type':native,'delta':'你好'}})
            self.assertEqual(events[0].type, expected)
            self.assertEqual(events[0].data['content']['text'], '你好')

    def test_tool_lifecycle(self):
        start = self.engine.map_event({'type':'tool_execution_start','toolCallId':'call-1','toolName':'bash','args':{'command':'ls'}})
        self.assertEqual(start[0].data['tool_call_id'], 'call-1')
        self.assertEqual(start[0].data['raw_input'], {'command':'ls'})
        self.assertEqual(start[1].data['status'], 'in_progress')
        for failed in [False, True]:
            end = self.engine.map_event({'type':'tool_execution_end','toolCallId':'call-1','toolName':'bash','isError':failed,'result':{'content':[{'type':'text','text':'output'}]}})
            self.assertEqual(end[0].data['status'], 'failed' if failed else 'completed')
            self.assertIn('output', json.dumps(end[0].data['raw_output']))

    def test_usage_omits_default_and_cost(self):
        self.assertEqual(self.engine.map_event({'type':'message_end','message':{'role':'assistant','usage':{'input':0,'output':0}}}), [])
        event = self.engine.map_event({'type':'message_end','message':{'role':'assistant','usage':{'input':3,'output':2,'totalTokens':5,'cost':{'total':0}}}})[0]
        self.assertEqual(event.data['total_tokens'], 5)
        self.assertNotIn('cost', event.data)

    def test_error_redaction(self):
        self.engine._secrets = ['test-secret']
        event = self.engine.map_event({'type':'message_end','message':{'role':'assistant','stopReason':'error','errorMessage':'key=test-secret'}})[0]
        self.assertNotIn('test-secret', event.data['message'])

    def test_session_path_rejects_traversal(self):
        with self.assertRaises(ValueError):
            self.engine.session_path('../escape')

class LifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_idle_stop(self):
        engine = adapter.TauEngine()
        await engine.stop()
        await engine.stop()

    async def test_native_jsonl_large_delayed_read(self):
        from tau_agent.session import JsonlSessionStorage, MessageEntry, SessionState
        from tau_agent.messages import UserMessage
        with tempfile.TemporaryDirectory() as root:
            storage = JsonlSessionStorage(Path(root)/'session.jsonl')
            text = '中文' * 100000
            await storage.append(MessageEntry(message=UserMessage(content=text)))
            await asyncio.sleep(.01)
            state = SessionState.from_entries(await storage.read_all())
            self.assertEqual(state.messages[0].text, text)

    async def test_denied_tool_is_not_executed(self):
        from tau_agent.harness import AgentHarness, AgentHarnessConfig
        from tau_agent.messages import AssistantMessage, ToolCall
        from tau_agent.provider_events import AssistantDoneEvent
        from tau_coding.tools import create_coding_tools
        class Provider:
            count = 0
            async def stream_response(self, **kwargs):
                self.count += 1
                message = AssistantMessage(content=[ToolCall(id='deny',name='write',arguments={'path':'blocked.txt','content':'bad'})]) if self.count == 1 else AssistantMessage(content='denied')
                yield AssistantDoneEvent(reason='toolUse' if self.count == 1 else 'stop',message=message)
        async def deny(call):
            return True, 'Denied'
        with tempfile.TemporaryDirectory() as root:
            harness = AgentHarness(AgentHarnessConfig(provider=Provider(),model='test',system='',tools=create_coding_tools(cwd=root),before_tool_call=deny))
            events = [event async for event in harness.prompt('write')]
            self.assertFalse((Path(root)/'blocked.txt').exists())
            self.assertTrue(any(getattr(event,'is_error',False) for event in events))

    async def test_adapter_cancel_and_resume(self):
        import os
        from tau_agent.messages import AssistantMessage
        from tau_agent.provider_events import TextDeltaEvent, AssistantDoneEvent
        from engines.core.base import ProviderRuntimeConfig
        started = asyncio.Event()
        class Provider:
            mode = 'reply'
            seen = []
            def __init__(self, config, **kwargs):
                pass
            async def stream_response(self, **kwargs):
                Provider.seen = kwargs['messages']
                started.set()
                if Provider.mode == 'wait':
                    await asyncio.sleep(60)
                message = AssistantMessage(content='ok')
                yield TextDeltaEvent(content_index=0,delta='ok',partial=message)
                yield AssistantDoneEvent(reason='stop',message=message)
            async def aclose(self):
                pass
        runtime = ProviderRuntimeConfig(model='test',protocol='openai_chat_completions',env={'TAU_WORKSTEP_API_KEY':'fake','TAU_WORKSTEP_BASE_URL':'https://example.invalid/v1'})
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {'WORKSTEP_CUSTOM_ENGINE_DIR':str(Path(root)/'engine')}), patch('tau_ai.openai_compatible.OpenAICompatibleProvider',Provider):
            engine = adapter.TauEngine()
            with patch.object(engine,'resolve_provider_runtime',return_value=runtime):
                events = [e async for e in engine.spawn('Remember first',root)]
                sid = next(e.data['session_id'] for e in events if e.type=='session_started')
                self.assertTrue(await engine.resume_session(sid,root))
                self.assertFalse(await engine.resume_session(sid,root + '/other'))
                self.assertFalse(await engine.resume_session('missing',root))
                events = [e async for e in engine.spawn('second',root,session_id=sid)]
                self.assertTrue(any(getattr(m,'text','')=='Remember first' for m in Provider.seen))
                Provider.mode='wait'
                started.clear()
                events = []
                async def consume():
                    async for event in engine.spawn('wait',root):
                        events.append(event)
                task = asyncio.create_task(consume())
                await asyncio.wait_for(started.wait(),2)
                await asyncio.wait_for(engine.stop(),2)
                with self.assertRaises(asyncio.CancelledError):
                    await asyncio.wait_for(task,2)
                self.assertTrue(any(e.data.get('status')=='cancelled' for e in events))
                self.assertFalse(any(e.data.get('status')=='done' for e in events))
                await engine.stop()

    async def test_workstep_approval_bridge(self):
        engine = adapter.TauEngine()
        queue = asyncio.Queue()
        task = asyncio.create_task(engine.handle_tool_permission(queue.put,tool_name='write',tool_input={'path':'blocked.txt'},tool_use_id='reject-1',session_id='session'))
        event = await asyncio.wait_for(queue.get(),2)
        self.assertEqual(event.type,'interaction_request')
        await engine.approve_tool_option('reject-1','reject_once')
        approved, _ = await asyncio.wait_for(task,2)
        self.assertFalse(approved)
