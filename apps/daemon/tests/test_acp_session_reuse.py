import asyncio
import json
from pathlib import Path
import sys

import pytest

from engines.hermes import HermesEngine
from engines.opencode import OpencodeEngine
from engines.antigravity import AntigravityEngine
from engines.core.base import ProviderRuntimeConfig
from engines.core.session_pool import close_session_pools, get_session_pool


@pytest.fixture(params=[HermesEngine, OpencodeEngine, AntigravityEngine], ids=['hermes', 'opencode', 'antigravity'])
async def engine_config(request, monkeypatch, tmp_path):
    cls = request.param
    peer = Path(__file__).parent / 'fixtures/acp_session_stub.py'
    monkeypatch.setattr(cls, 'get_command', lambda self: [sys.executable, str(peer), str(tmp_path)])
    monkeypatch.setattr(cls, 'project_skill_env', lambda *args: {})
    monkeypatch.setattr(cls, 'get_permission_mode', lambda *args: 'ask')
    monkeypatch.setattr(cls, 'resolve_provider_runtime', lambda *args, **kwargs: ProviderRuntimeConfig())
    errors = []
    loop = asyncio.get_running_loop()
    previous = loop.get_exception_handler()
    loop.set_exception_handler(lambda loop, context: errors.append(context))
    try:
        yield cls, tmp_path
    finally:
        await close_session_pools()
        await asyncio.sleep(0)
        loop.set_exception_handler(previous)
        assert not errors, errors


async def collect(config, prompt, sid=None, **kwargs):
    cls, root = config
    return [e async for e in cls().spawn(prompt, str(root), session_id=sid, **kwargs)]


@pytest.mark.anyio
async def test_native_restore_drops_history_but_preserves_new_identical_text(engine_config):
    cls, root = engine_config
    if cls is OpencodeEngine:
        pytest.skip('This adapter owns a separate restore implementation')
    first = await collect(engine_config, 'hello')
    session = sid(first)
    pool = get_session_pool(cls.ENGINE_ID)
    await pool.discard(pool._entries[(str(root), session)])
    (root / 'replay-history').touch()
    restored = await collect(engine_config, 'hello', session)
    assert text(restored) == 'hello'
    assert not any(e.type in {'user_message_chunk', 'agent_thought_chunk', 'tool_call'} for e in restored)
    assert any(e.type == 'config_option_update' for e in restored)
    assert text(await collect(engine_config, 'hello', session)) == 'hello'


@pytest.mark.anyio
@pytest.mark.parametrize('native_mode', ['default', 'auto', 'accept-edits', 'plan'])
async def test_antigravity_full_access_approves_native_request_and_downgrades(engine_config, native_mode):
    cls, root = engine_config
    if cls is not AntigravityEngine:
        pytest.skip('Antigravity-specific native permission contract')
    from engines.core.permissions import encode_permission_selection
    engine = cls()
    await engine.set_permission_mode(encode_permission_selection('antigravity', {'permission_mode':'bypassPermissions'}))
    events = [e async for e in engine.spawn('approve', str(root))]
    assert text(events) == 'accepted'
    assert not any(e.type == 'interaction_request' for e in events)
    session = sid(events)
    pending = asyncio.Queue()
    async def downgraded():
        async for event in engine.spawn('approve', str(root), session_id=session, config_overrides={'permission_mode':native_mode}):
            if event.type == 'interaction_request':
                await pending.put(event)
    task = asyncio.create_task(downgraded())
    try:
        event = await asyncio.wait_for(pending.get(), 5)
        await engine.approve_tool_option(event.data['tool_call']['tool_call_id'], 'deny')
        await asyncio.wait_for(task, 5)
    finally:
        await engine.stop()
        await asyncio.gather(task, return_exceptions=True)


def sid(events):
    return next(e.data['session_id'] for e in events if e.type == 'session_started')


def text(events):
    return ''.join(e.data['content']['text'] for e in events if e.type == 'agent_message_chunk')


@pytest.mark.anyio
async def test_acp_real_transport_reuses_session_and_long_output(engine_config):
    cls, root = engine_config
    first = await asyncio.wait_for(collect(engine_config, 'hello'), 5)
    assert text(first) == 'hello', [e.to_dict() for e in first]
    session = sid(first)
    pool = get_session_pool(cls.ENGINE_ID)
    entry = pool._entries[(str(root), session)]
    second = await asyncio.wait_for(collect(engine_config, 'large', session), 5)
    assert text(second) == 'x' * 100_000
    assert pool._entries[(str(root), session)] is entry
    lines = [json.loads(line) for line in (root / 'wire.jsonl').read_text().splitlines()]
    assert sum(row.get('method') == 'initialize' for row in lines) == 1
    assert not any(row.get('method') in {'session/load', 'session/resume'} for row in lines)


@pytest.mark.anyio
async def test_acp_real_transport_expiry_crash_and_resume(engine_config):
    cls, root = engine_config
    pool = get_session_pool(cls.ENGINE_ID)
    pool.idle_seconds = 0.01
    first = await collect(engine_config, 'hello')
    session = sid(first)
    original = pool._entries[(str(root), session)].client.value.process
    await asyncio.sleep(0.1)
    assert original.returncode is not None
    pool.idle_seconds = 600
    assert text(await collect(engine_config, 'resumed', session)) == 'resumed'
    crashed = await asyncio.wait_for(collect(engine_config, 'crash', session), 5)
    assert any(e.type == 'error' for e in crashed)
    assert text(await collect(engine_config, 'recovered', session)) == 'recovered'


@pytest.mark.anyio
@pytest.mark.parametrize('decision', ['allow', 'deny', 'stop'])
async def test_acp_parallel_approval_and_stop_isolation(engine_config, decision):
    cls, root = engine_config
    engine = cls()
    await engine.set_permission_mode('ask')
    ready = asyncio.Queue()
    output = []
    async def run():
        async for event in engine.spawn('approve', str(root)):
            output.append(event)
            if event.type == 'interaction_request':
                await ready.put(event)
    task = asyncio.create_task(run())
    try:
        event = await asyncio.wait_for(ready.get(), 5)
        other = await collect(engine_config, 'other')
        if decision == 'stop':
            await asyncio.wait_for(engine.stop(), 3)
        else:
            await engine.approve_tool_option(event.data['tool_call']['tool_call_id'], decision)
        await asyncio.wait_for(task, 5)
        if decision != 'stop':
            assert text(output) == ('accepted' if decision == 'allow' else 'denied')
        assert text(await collect(engine_config, 'survived', sid(other))) == 'survived'
    finally:
        if not task.done():
            await engine.stop()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.anyio
async def test_acp_cancel_and_early_close_release_prompt_tasks(engine_config):
    cls, root = engine_config
    first = await collect(engine_config, 'seed')
    session = sid(first)
    pool = get_session_pool(cls.ENGINE_ID)
    entry = pool._entries[(str(root), session)]
    stream = cls().spawn('unused', str(root), session_id=session)
    try:
        for _ in range(10):
            if (await anext(stream)).type == 'session_started':
                break
    finally:
        await stream.aclose()
    assert entry.client.value.process.returncode is not None
    engine = cls()
    task = asyncio.create_task(collect(engine_config, 'wait', session))
    # Wait until the native prompt is received, then cancel its consumer.
    for _ in range(100):
        lines = (root / 'wire.jsonl').read_text().splitlines()
        if any('wait' in line and 'session/prompt' in line for line in lines):
            break
        await asyncio.sleep(.01)
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    assert not pool._entries


@pytest.mark.anyio
async def test_antigravity_plan_toggle_resets_native_mode_on_reused_and_restored_session(engine_config):
    cls, root = engine_config
    if cls is not AntigravityEngine:
        pytest.skip('Antigravity native modes')
    config = {'permission_mode': 'accept-edits'}
    first = await collect(engine_config, 'first', config_overrides=config, plan_mode=False)
    session = sid(first)
    await collect(engine_config, 'planning', session, config_overrides=config, plan_mode=True)
    await collect(engine_config, 'execute', session, config_overrides=config, plan_mode=False)
    pool = get_session_pool(cls.ENGINE_ID)
    await pool.discard(pool._entries[(str(root), session)])
    await collect(engine_config, 'restored', session, config_overrides={'permission_mode':'auto'}, plan_mode=False)
    rows = [json.loads(line) for line in (root / 'wire.jsonl').read_text().splitlines()]
    assert [r['params']['value'] for r in rows if r.get('method') == 'session/set_config_option' and r['params']['configId']=='mode'] == ['accept-edits','plan','accept-edits','auto']
    assert sum(r.get('method') == 'initialize' for r in rows) == 2
    methods = [r.get('method') for r in rows]
    assert methods.count('session/load') == 1
    for index, row in enumerate(rows):
        if row.get('method') == 'session/prompt':
            assert rows[index-1].get('method') == 'session/set_config_option'


@pytest.mark.anyio
async def test_antigravity_rejected_mode_never_sends_prompt(engine_config):
    cls, root = engine_config
    if cls is not AntigravityEngine:
        pytest.skip('Antigravity native modes')
    (root / 'reject-mode').touch()
    events = await collect(engine_config, 'must not run', config_overrides={'permission_mode':'auto'})
    assert any(e.type == 'error' for e in events)
    rows = [json.loads(line) for line in (root / 'wire.jsonl').read_text().splitlines()]
    assert not any(r.get('method') == 'session/prompt' for r in rows)


@pytest.mark.anyio
async def test_antigravity_mid_run_live_message_interrupts_and_delivers(engine_config):
    cls, root = engine_config
    if cls is not AntigravityEngine:
        pytest.skip('Antigravity mid-run live message interrupt')
    queue: asyncio.Queue = asyncio.Queue()
    events = []

    async def run():
        async for event in cls().spawn('wait', str(root), live_message_queue=queue):
            events.append(event)

    task = asyncio.create_task(run())
    for _ in range(100):
        wire = root / 'wire.jsonl'
        if wire.exists() and any('session/prompt' in line for line in wire.read_text().splitlines()):
            break
        await asyncio.sleep(0.01)
    queue.put_nowait(('live-1', 'follow-up'))
    await asyncio.wait_for(task, 5)
    delivered_index = next(
        i for i, e in enumerate(events)
        if e.type == 'live_message' and e.data.get('message_id') == 'live-1' and e.data.get('status') == 'delivered'
    )
    chunk_index = next(
        i for i, e in enumerate(events)
        if e.type == 'agent_message_chunk' and e.data.get('content', {}).get('text') == 'follow-up'
    )
    assert delivered_index < chunk_index
    assert any(e.type == 'status' and e.data.get('status') == 'done' for e in events)
    rows = [json.loads(line) for line in (root / 'wire.jsonl').read_text().splitlines()]
    assert any(r.get('method') == 'session/cancel' for r in rows)


@pytest.mark.anyio
async def test_acp_real_transport_handles_form_elicitation_and_returns_answers(engine_config):
    cls, root = engine_config
    engine = cls()
    ready = asyncio.Queue()
    output = []

    async def run():
        async for event in engine.spawn('ask_question', str(root)):
            output.append(event)
            if event.type == 'interaction_request':
                await ready.put(event)

    task = asyncio.create_task(run())
    try:
        event = await asyncio.wait_for(ready.get(), 5)
        assert event.data['method'] == 'elicitation/create'
        assert event.data['message'] == '请选择部署形态'
        props = event.data['requested_schema']['properties']
        assert props['q1']['oneOf'] == [
            {'const': 'standalone', 'title': '独立极简服务'},
            {'const': 'gateway', 'title': '集成到 Gateway'},
        ]
        assert props['q2']['items']['anyOf'] == [
            {'const': 'stun', 'title': 'STUN'},
            {'const': 'turn', 'title': 'TURN'},
        ]
        delivered = await engine.respond_interaction(event.data, {
            'action': 'accept',
            'content': {'q1': 'standalone', 'q2': ['stun', 'turn']},
        })
        assert delivered is True
        await asyncio.wait_for(task, 5)
    finally:
        if not task.done():
            await engine.stop()
        await asyncio.gather(task, return_exceptions=True)

    assert json.loads(text(output)) == {
        'action': 'accept',
        'content': {'q1': 'standalone', 'q2': ['stun', 'turn']},
    }
    assert any(e.type == 'elicitation_completed' for e in output)
    # Session remains healthy and reusable after an elicitation turn.
    assert text(await collect(engine_config, 'follow-up', sid(output))) == 'follow-up'


@pytest.mark.anyio
async def test_antigravity_bypass_permissions_still_surfaces_ask_question_elicitation(engine_config):
    cls, root = engine_config
    if cls is not AntigravityEngine:
        pytest.skip('Antigravity bypassPermissions elicitation contract')
    from engines.core.permissions import encode_permission_selection

    engine = cls()
    await engine.set_permission_mode(encode_permission_selection('antigravity', {'permission_mode': 'bypassPermissions'}))
    ready = asyncio.Queue()
    output = []

    async def run():
        async for event in engine.spawn('ask_question', str(root)):
            output.append(event)
            if event.type == 'interaction_request':
                await ready.put(event)

    task = asyncio.create_task(run())
    try:
        event = await asyncio.wait_for(ready.get(), 5)
        assert event.data['method'] == 'elicitation/create'
        delivered = await engine.respond_interaction(event.data, {'action': 'cancel'})
        assert delivered is True
        await asyncio.wait_for(task, 5)
    finally:
        if not task.done():
            await engine.stop()
        await asyncio.gather(task, return_exceptions=True)

    assert json.loads(text(output)) == {'action': 'cancel'}


@pytest.mark.anyio
async def test_antigravity_inline_quota_warning_ends_turn_with_error_not_body(engine_config):
    cls, root = engine_config
    if cls is not AntigravityEngine:
        pytest.skip('Antigravity inline quota warning contract')
    events = [e async for e in cls().spawn_with_retry(prompt='quota_after_body', cwd=str(root))]
    assert text(events) == '已完成代码修改。'
    errors = [e for e in events if e.type == 'error']
    assert len(errors) == 1
    assert errors[0].data['message'] == (
        'Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 3h4m13s.'
    )
    assert not any(e.type == 'status' and e.data.get('status') in {'done', 'retrying'} for e in events)
    pool = get_session_pool(cls.ENGINE_ID)
    assert not pool._entries
    rows = [json.loads(line) for line in (root / 'wire.jsonl').read_text().splitlines()]
    assert sum(r.get('method') == 'session/prompt' for r in rows) == 1
