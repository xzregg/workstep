"""Live SDK deltas must not wait for a missing optional phase."""

from types import SimpleNamespace as N

import pytest

from engines.codex_sdk import CodexSDKEngine


@pytest.mark.parametrize('phase', [None, 'final_answer', 'commentary'])
@pytest.mark.parametrize('early_delta', [False, True])
def test_started_item_streams_before_completion_without_guessing_phase(phase, early_delta):
    engine = CodexSDKEngine()
    state = {'emitted_text': False, 'tool_emitted': set()}

    def notify(method, **payload):
        return engine._map_notification(N(method=method, payload=N(**payload)), state)

    chunks = []
    if early_delta:
        assert notify('item/agentMessage/delta', item_id='answer', delta='部分') == []
    chunks += notify('item/started', item=N(root=N(type='agentMessage', id='answer', phase=phase)))
    if not early_delta:
        chunks += notify('item/agentMessage/delta', item_id='answer', delta='部分')
    assert [e.data['content']['text'] for e in chunks] == ['部分']
    assert chunks[0].data.get('phase') == phase
    more = notify('item/agentMessage/delta', item_id='answer', delta='正文')
    assert [e.data['content']['text'] for e in more] == ['正文']
    assert more[0].data.get('phase') == phase

    # Completion can supply the missing phase, but must not repeat live text.
    assert notify('item/completed', item=N(root=N(
        type='agentMessage', id='answer', phase=phase or 'final_answer', text='部分正文',
    ))) == []
    terminal = notify('turn/completed', turn=N(status=N(value='completed'), error=None))
    assert [e.type for e in terminal] == ['status']
    assert notify('item/agentMessage/delta', item_id='answer', delta='重复') == []


def test_unphased_stream_does_not_reclassify_previous_delta_as_commentary():
    engine = CodexSDKEngine()
    state = {'emitted_text': False, 'tool_emitted': set()}
    engine._map_notification(N(method='item/started', payload=N(
        item=N(root=N(type='agentMessage', id='answer')),
    )), state)
    first = engine._map_notification(N(method='item/agentMessage/delta', payload=N(
        item_id='answer', delta='第一段',
    )), state)
    second = engine._map_notification(N(method='item/agentMessage/delta', payload=N(
        item_id='answer', delta='第二段',
    )), state)
    assert len(first) == len(second) == 1
    assert first[0].data.get('phase') is None
    assert second[0].data.get('phase') is None


def test_unphased_completion_sends_only_missing_tail_and_preserves_visualize_marker():
    engine = CodexSDKEngine()
    state = {'emitted_text': False, 'tool_emitted': set()}

    def notify(method, **payload):
        return engine._map_notification(N(method=method, payload=N(**payload)), state)

    notify('item/started', item=N(root=N(type='agentMessage', id='answer')))
    marker = '\ue200visualize{"path":"/tmp/report.html"}\ue201'
    first = notify('item/agentMessage/delta', item_id='answer', delta='正文\n' + marker[:10])
    assert [e.data['content']['text'] for e in first] == ['正文\n']
    second = notify('item/agentMessage/delta', item_id='answer', delta=marker[10:])
    completed = notify('item/completed', item=N(root=N(
        type='agentMessage', id='answer', text='正文\n' + marker + '\n尾部',
    )))
    assert [e.data['content']['text'] for e in completed] == ['\n尾部']
    assert ''.join(e.data['content']['text'] for e in first + second + completed) == (
        '正文\n[report.html](file:///tmp/report.html)\n尾部'
    )
    assert all(e.data.get('phase') is None for e in first + second + completed)
