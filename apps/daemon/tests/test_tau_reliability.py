import asyncio
import json
import unittest
from unittest.mock import patch
import httpx
import pytest
pytest.importorskip("tau_agent", reason="Tau SDK is installed manually")
from engines import tau as adapter

@pytest.fixture(autouse=True)
def isolated_tau_sessions(tmp_path, monkeypatch):
    monkeypatch.setattr(adapter, "CONFIG_DIR", tmp_path)

from tau_ai.env import OpenAICompatibleConfig
from tau_ai.openai_compatible import OpenAICompatibleProvider
from tau_agent.messages import UserMessage


def sse(*chunks):
    return ''.join('data: ' + (x if isinstance(x, str) else json.dumps(x)) + '\n\n' for x in chunks).encode()


class ReliabilityTests(unittest.IsolatedAsyncioTestCase):
    async def consume(self, body, content_type='text/event-stream'):
        from engines._tau_runtime import checked_provider_stream, guard_response
        async with httpx.AsyncClient(transport=httpx.MockTransport(
            lambda request: httpx.Response(200, content=body, headers={'content-type': content_type})),
            event_hooks={'response': [guard_response]}) as client:
            provider = OpenAICompatibleProvider(OpenAICompatibleConfig(api_key='fake'), client=client)
            events = []
            async for event in checked_provider_stream(provider, 1, model='test', system='',
                    messages=[UserMessage(content='test')], tools=[]):
                events.append(event)
            return events

    async def test_empty_response_rejected(self):
        with self.assertRaisesRegex(RuntimeError, 'empty|Empty'):
            await self.consume(sse({'choices': [{'delta': {}, 'finish_reason': 'stop'}]}, '[DONE]'))

    async def test_eof_after_partial_text_rejected(self):
        with self.assertRaisesRegex(RuntimeError, 'complet|terminat'):
            await self.consume(sse({'choices': [{'delta': {'content': 'partial'}}]}))

    async def test_inband_error_rejected(self):
        with self.assertRaisesRegex(RuntimeError, 'provider|Provider'):
            await self.consume(sse({'error': {'message': 'failure'}}))

    async def test_non_sse_rejected(self):
        with self.assertRaisesRegex(RuntimeError, 'event-stream'):
            await self.consume(b'{"error":"failure"}', 'application/json')

    async def test_valid_reply_and_tool_call(self):
        events = await self.consume(sse({'choices': [{'delta': {'content': 'hello'}}]},
            {'choices': [{'delta': {}, 'finish_reason': 'stop'}]}, '[DONE]'))
        self.assertEqual(events[-1].message.text, 'hello')
        events = await self.consume(sse({'choices': [{'delta': {'tool_calls': [{
            'index': 0, 'id': 'one', 'function': {'name': 'read', 'arguments': '{"path":"x"}'}}]},
            'finish_reason': 'tool_calls'}]}, '[DONE]'))
        self.assertEqual(events[-1].message.tool_calls[0].name, 'read')

    async def test_length_limit_is_not_success(self):
        with self.assertRaisesRegex(RuntimeError, 'limit|truncat'):
            await self.consume(sse({'choices': [{'delta': {'content': 'partial'}, 'finish_reason': 'length'}]}, '[DONE]'))

    async def test_total_timeout_closes_stream(self):
        from engines._tau_runtime import checked_provider_stream
        closed = asyncio.Event()
        class SlowProvider:
            async def stream_response(self, **kwargs):
                try:
                    await asyncio.sleep(10)
                    yield None
                finally:
                    closed.set()
        with self.assertRaisesRegex(TimeoutError, 'timed out'):
            async for _ in checked_provider_stream(SlowProvider(), .02):
                pass
        self.assertTrue(closed.is_set())

    async def test_cancellation_propagates_and_closes_stream(self):
        from engines._tau_runtime import checked_provider_stream
        started, closed = asyncio.Event(), asyncio.Event()
        class SlowProvider:
            async def stream_response(self, **kwargs):
                try:
                    started.set()
                    await asyncio.sleep(10)
                    yield None
                finally:
                    closed.set()
        async def run():
            async for _ in checked_provider_stream(SlowProvider(), 1):
                pass
        task = asyncio.create_task(run())
        await started.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertTrue(closed.is_set())


class FinalContentTests(unittest.TestCase):
    def test_missing_final_suffix_recovered_without_duplicates(self):
        engine = adapter.TauEngine()
        raw = {'type': 'message_update', 'assistantMessageEvent': {
            'type': 'text_delta', 'content_index': 0, 'delta': 'hel'}}
        first = engine.map_event(raw)
        final = {'type': 'message_end', 'message': {'role': 'assistant',
            'content': [{'type': 'text', 'text': 'hello'}], 'stopReason': 'stop'}}
        last = engine.map_event(final)
        text = ''.join(e.data['content']['text'] for e in first + last if e.type == 'agent_message_chunk')
        self.assertEqual(text, 'hello')

    def test_final_only_message_recovered(self):
        events = adapter.TauEngine().map_event({'type': 'message_end', 'message': {
            'role': 'assistant', 'content': [{'type': 'text', 'text': 'complete'}], 'stopReason': 'stop'}})
        self.assertEqual(events[0].data['content']['text'], 'complete')


class EngineFlowTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        import tempfile
        import os
        from engines.core.base import ProviderRuntimeConfig
        self.root = tempfile.TemporaryDirectory()
        self.addCleanup(self.root.cleanup)
        self.engine = adapter.TauEngine()
        self.config = ProviderRuntimeConfig(model='test', protocol='openai_chat_completions',
            env={'TAU_WORKSTEP_API_KEY': 'secret-test', 'TAU_WORKSTEP_BASE_URL': 'https://example.invalid/v1'})
        self.env = patch.dict(os.environ, {'WORKSTEP_CUSTOM_ENGINE_DIR': self.root.name + '/engine'})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.runtime = patch.object(self.engine, 'resolve_provider_runtime', return_value=self.config)
        self.runtime.start()
        self.addCleanup(self.runtime.stop)
        self.values = patch.object(self.engine, 'get_config_values', return_value={})
        self.values.start()
        self.addCleanup(self.values.stop)

    async def run_body(self, handler, *, coordinator=False, overrides=None, cancel_approval=False):
        clients = []
        def factory(**kwargs):
            client = httpx.AsyncClient(transport=httpx.MockTransport(handler), **kwargs)
            clients.append(client)
            return client
        function = self.engine.spawn_coordinator if coordinator else self.engine.spawn
        events = []
        with patch('tau_ai.http.create_async_client', factory):
            async for event in function('test', self.root.name, config_overrides=overrides or {}):
                events.append(event)
                if cancel_approval and event.type == 'interaction_request':
                    await self.engine.stop()
        self.assertTrue(all(c.is_closed for c in clients))
        return events

    @staticmethod
    def response(body):
        return httpx.Response(200, content=body, headers={'content-type': 'text/event-stream'})

    async def test_tool_result_then_reply_and_resume(self):
        payloads = []
        def handler(request):
            payloads.append(json.loads(request.content))
            if len(payloads) == 1:
                return self.response(sse({'choices': [{'delta': {'tool_calls': [{
                    'index': 0, 'id': 'one', 'function': {'name': 'bash', 'arguments': '{"command":"printf probe"}'}}]},
                    'finish_reason': 'tool_calls'}]}, '[DONE]'))
            return self.response(sse({'choices': [{'delta': {'content': 'complete'}, 'finish_reason': 'stop'}]}, '[DONE]'))
        events = await self.run_body(handler, overrides={'permission_mode': 'allow', 'tool_timeout': 1})
        self.assertTrue(any(e.type == 'agent_message_chunk' and e.data['content']['text'] == 'complete' for e in events))
        self.assertFalse(any(e.type == 'error' for e in events), events)
        self.assertTrue(any(m['role'] == 'tool' for m in payloads[1]['messages']))
        sid = next(e.data['session_id'] for e in events if e.type == 'session_started')
        self.assertTrue(await self.engine.resume_session(sid, self.root.name))

    async def test_empty_after_tool_is_failure(self):
        count = 0
        def handler(request):
            nonlocal count
            count += 1
            if count == 1:
                return self.response(sse({'choices': [{'delta': {'tool_calls': [{
                    'index': 0, 'id': 'one', 'function': {'name': 'bash', 'arguments': '{"command":"printf probe"}'}}]},
                    'finish_reason': 'tool_calls'}]}, '[DONE]'))
            return self.response(sse({'choices': [{'delta': {}, 'finish_reason': 'stop'}]}, '[DONE]'))
        events = await self.run_body(handler, overrides={'permission_mode': 'allow'})
        self.assertTrue(any(e.type == 'error' and 'empty' in e.data['message'] for e in events))
        self.assertFalse(any(e.type == 'status' and e.data['status'] == 'done' for e in events))

    async def test_request_timeout_failure_and_cleanup(self):
        async def handler(request):
            await asyncio.sleep(1)
            return self.response(b'')
        events = await self.run_body(handler, overrides={'request_timeout': .02})
        self.assertTrue(any(e.type == 'error' and 'timed out' in e.data['message'] for e in events))
        self.assertFalse(any(e.type == 'status' and e.data['status'] == 'done' for e in events))

    async def test_coordinator_does_not_send_tools(self):
        def handler(request):
            self.assertNotIn('tools', json.loads(request.content))
            return self.response(sse({'choices': [{'delta': {'content': 'okay'}, 'finish_reason': 'stop'}]}, '[DONE]'))
        events = await self.run_body(handler, coordinator=True)
        self.assertFalse(any(e.type in {'error', 'tool_call'} for e in events))

    async def test_max_turns_does_not_report_success(self):
        def handler(request):
            return self.response(sse({'choices': [{'delta': {'tool_calls': [{
                'index': 0, 'id': 'one', 'function': {'name': 'bash', 'arguments': '{"command":"printf probe"}'}}]},
                'finish_reason': 'tool_calls'}]}, '[DONE]'))
        events = await self.run_body(handler, overrides={'permission_mode': 'allow', 'max_turns': 1})
        self.assertTrue(any(e.type == 'error' and 'max_turns' in e.data['message'] for e in events))
        self.assertFalse(any(e.type == 'status' and e.data['status'] == 'done' for e in events))

    async def test_cancel_during_approval(self):
        def handler(request):
            return self.response(sse({'choices': [{'delta': {'tool_calls': [{
                'index': 0, 'id': 'one', 'function': {'name': 'bash', 'arguments': '{"command":"printf probe"}'}}]},
                'finish_reason': 'tool_calls'}]}, '[DONE]'))
        with self.assertRaises(asyncio.CancelledError):
            await self.run_body(handler, cancel_approval=True)
        self.assertFalse(self.engine._pending_approvals_dict())
        self.assertFalse(getattr(self.engine, '_pending_interaction_responses', {}))
        await self.engine.approve_tool_option('one', 'allow_once')

    async def test_slow_storage_does_not_block_and_cancellation_waits_for_write(self):
        import time
        finished = []
        class Storage:
            async def append(self, entry):
                time.sleep(.1)
                finished.append(entry)
        task = asyncio.create_task(self.engine.append_entry(Storage(), 'saved'))
        await asyncio.sleep(.02)
        self.assertFalse(task.done())
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(finished, ['saved'])


class StreamProtocolTests(unittest.IsolatedAsyncioTestCase):
    async def test_chunked_eof_preserves_partial_and_fails(self):
        from engines._tau_runtime import guard_response, checked_provider_stream
        closed = []
        class Bytes(httpx.AsyncByteStream):
            async def __aiter__(self):
                body = sse({'choices': [{'delta': {'content': 'partial'}}]})
                for byte in body:
                    yield bytes([byte])
            async def aclose(self):
                closed.append(True)
        transport = httpx.MockTransport(lambda r: httpx.Response(200, stream=Bytes(),
            headers={'content-type': 'text/event-stream'}))
        async with httpx.AsyncClient(transport=transport, event_hooks={'response': [guard_response]}) as client:
            provider = OpenAICompatibleProvider(OpenAICompatibleConfig(api_key='fake'), client=client)
            text = ''
            with self.assertRaisesRegex(RuntimeError, 'completion'):
                async for event in checked_provider_stream(provider, 1, model='test', system='',
                        messages=[UserMessage(content='test')], tools=[]):
                    if event.type == 'text_delta':
                        text += event.delta
            self.assertEqual(text, 'partial')
        self.assertTrue(closed)

    async def test_other_protocol_completion_markers(self):
        from engines._tau_runtime import SSECompletion
        for terminal in ({'type': 'response.completed'}, {'type': 'message_stop'}):
            check = SSECompletion()
            check.feed(sse(terminal))
            check.finish()
        for error in ({'type': 'response.incomplete'}, {'type': 'response.failed'},
                {'type': 'message_delta', 'delta': {'stop_reason': 'max_tokens'}}):
            with self.assertRaises(RuntimeError):
                SSECompletion().feed(sse(error))

    async def test_bash_timeout_terminates_owned_process(self):
        import tempfile
        from tau_coding.tools import create_coding_tools
        bash = next(t for t in create_coding_tools() if t.name == 'bash')
        # Official SDK must finish well before the sleeping process would.
        result = await asyncio.wait_for(bash.execute('timeout-probe',
            {'command': 'sleep 10', 'timeout': .05}, None), 2)
        self.assertIn('timed out', json.dumps(result.model_dump()).lower())


class VisionTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = EngineFlowTests.asyncSetUp
    response = staticmethod(EngineFlowTests.response)
    async def test_local_image_reaches_provider_and_persists(self):
        import base64
        from pathlib import Path
        from engines.core.schema import EngineImage
        fixture = Path(__file__).parent / 'fixtures/tau/vision.png'
        requests = []
        def handler(request):
            payload = json.loads(request.content)
            requests.append(payload)
            content = payload['messages'][-1]['content']
            self.assertEqual(content[0]['text'], 'image path kept: ' + str(fixture))
            self.assertEqual(base64.b64decode(content[1]['image_url']['url'].split(',', 1)[1]), fixture.read_bytes())
            return self.response(sse({'choices': [{'delta': {'content': 'red'}, 'finish_reason': 'stop'}]}, '[DONE]'))
        from engines._tau_runtime import guard_response
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler), event_hooks={'response': [guard_response]})
        with patch('tau_ai.http.create_async_client', return_value=client):
            events = [e async for e in self.engine.spawn('image path kept: ' + str(fixture), self.root.name,
                images=[EngineImage(path=str(fixture))])]
        self.assertTrue(requests)
        self.assertFalse(any(e.type == 'error' for e in events), events)
        self.assertTrue(client.is_closed)
        sid = next(e.data['session_id'] for e in events if e.type == 'session_started')
        from tau_agent.session import JsonlSessionStorage, SessionState
        state = await self.engine.read_state(JsonlSessionStorage(self.engine.session_path(sid)), SessionState)
        self.assertEqual(state.messages[0].content[1].type, 'image')

    async def test_data_url_image(self):
        from engines.core.schema import EngineImage
        from tau_agent.messages import ImageContent
        message = await self.engine.input_message('text', [EngineImage(url='data:image/png;base64,aGVsbG8=')])
        self.assertIsInstance(message.content[1], ImageContent)
        self.assertEqual(message.content[1].data, 'aGVsbG8=')

    async def test_invalid_attachment_does_not_silently_disappear(self):
        from engines.core.schema import EngineImage
        with self.assertRaises(ValueError):
            await self.engine.input_message('text', [EngineImage(url='data:text/plain;base64,aGVsbG8=')])
