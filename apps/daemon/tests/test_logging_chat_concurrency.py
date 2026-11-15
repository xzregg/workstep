"""Real chat persistence/API with controlled engines and a shared log sink."""
import asyncio
import json
import logging
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from httpx import ASGITransport, AsyncClient
import pytest

from tests.test_chat_session import chat_module, _wait_turn
from engines.core.events import InternalEvent
from services.runtime_logging import BoundedLog, LogPolicy, RuntimeLogging


@pytest.mark.anyio
@pytest.mark.parametrize('fault', ['slow', 'unavailable'])
async def test_sixteen_conversations_keep_history_isolated_under_log_pressure(chat_module, tmp_path, monkeypatch, fault):
    import main
    from services.concurrency import concurrency_gate
    module, bus, manager, project, config = chat_module
    monkeypatch.setattr(main, 'project_manager', manager)
    monkeypatch.setattr(main, 'chat_session_module', module)
    monkeypatch.setattr(concurrency_gate, '_global', {'max_tasks':0, 'max_chats':0, 'schedule_exempt':False})
    runtime = RuntimeLogging(BoundedLog(tmp_path/'diagnostics/daemon.log', LogPolicy()), queue_size=16)
    original_emit = runtime.file_handler.emit
    def slow(record):
        time.sleep(.01)
        original_emit(record)
    if fault == 'slow': monkeypatch.setattr(runtime.file_handler, 'emit', slow)
    else:
        def fail(): raise OSError('injected diagnostic write failure')
        monkeypatch.setattr(runtime.file_handler, '_open', fail)
    logger = logging.Logger('concurrent-chat-fixture', level=logging.INFO)
    logger.addHandler(runtime.handler)
    started, release = asyncio.Event(), asyncio.Event()
    active = 0
    peak = 0
    async def invoke(engine_id, model, cwd, prompt, session_id, on_event=None, **kwargs):
        nonlocal active, peak
        index = int(re.search(r'token-(\d+)', prompt)[1])
        active += 1
        peak = max(peak, active)
        if active == 16: started.set()
        try:
            await release.wait()
            for part in range(3):
                logger.info('conversation %s chunk %s', index, part)
                if on_event is not None:
                    await on_event(InternalEvent(type='agent_message_chunk', data={'content':{'text':f'answer-{index}.'}}))
                await asyncio.sleep(.001)
            return f'answer-{index}.'*3, [], f'engine-{index}'
        finally:
            active -= 1
    monkeypatch.setattr(module, '_invoke', invoke)
    sessions = await manager.run_db(project.id, lambda p:[module.create_session(p.id, title=f'concurrent-{i}') for i in range(16)])
    stop = threading.Event()
    def background_logs():
        while not stop.wait(.002):
            for _ in range(20): logger.info('background diagnostic')
    with ThreadPoolExecutor(max_workers=4) as producers:
        futures = [producers.submit(background_logs) for _ in range(4)]
        try:
            async with AsyncClient(transport=ASGITransport(app=main.app), base_url='http://test') as client:
                replies = await asyncio.gather(*[client.post(f"/api/chat-sessions/{session['id']}/chat",
                    json={'project_id':project.id, 'content':f'token-{i}'},
                    headers={'Idempotency-Key':f'concurrent-{i}'}) for i,session in enumerate(sessions)])
                assert all(response.status_code == 200 for response in replies), [response.text for response in replies]
                await asyncio.wait_for(started.wait(), 10)
                health_timings = []
                for _ in range(10):
                    before = time.monotonic()
                    response = await asyncio.wait_for(client.get('/api/health'), .5)
                    health_timings.append(time.monotonic()-before)
                    assert response.status_code == 200
                release.set()
                statuses = await asyncio.gather(*[_wait_turn(module, response.json()['turn_id'], timeout=15) for response in replies])
                assert statuses == ['completed']*16
            histories = await manager.run_db(project.id, lambda p:[module.get_session(p.id,s['id']) for s in sessions])
            for index, history in enumerate(histories):
                messages = history['messages']
                assert len(messages) == 2
                assert messages[0]['content'] == f'token-{index}'
                assert messages[1]['content'] == f'answer-{index}.'*3
            assert peak == 16
            (tmp_path/'chat-concurrency-metrics.json').write_text(json.dumps({
                'fault':fault,'peak_running':peak,'completed':len(statuses),
                'health_max_ms':max(health_timings)*1000,'background_log_threads':4},indent=2))
        finally:
            release.set()
            stop.set()
            for future in futures: future.result(timeout=3)
            await asyncio.to_thread(runtime.close)


def test_many_log_producers_and_concurrent_close_are_bounded(tmp_path):
    runtime = RuntimeLogging(BoundedLog(tmp_path/'daemon.log', LogPolicy()), queue_size=8)
    logger = logging.Logger('thread-pressure', level=logging.INFO)
    logger.addHandler(runtime.handler)
    stop = threading.Event()
    def produce():
        while not stop.is_set(): logger.info('concurrent producer')
    with ThreadPoolExecutor(max_workers=12) as pool:
        producers = [pool.submit(produce) for _ in range(8)]
        try:
            time.sleep(.03)
            closing = [pool.submit(runtime.close) for _ in range(4)]
            assert all(future.result(timeout=2) is True for future in closing)
        finally:
            stop.set()
            for future in producers: future.result(timeout=2)
            runtime.close()
    assert runtime.listener._thread is None
