from types import SimpleNamespace

import pytest


@pytest.mark.parametrize('transport', ['cli', 'sdk'])
@pytest.mark.parametrize('actual_model', [None, 'actual-model'])
def test_claude_usage_preserves_only_native_response_model(transport, actual_model):
    from engines.claude_code_events import ClaudeCodeEventMapper
    from engines.claude_agent_sdk_events import ClaudeAgentSDKEventMapper
    message = {'content': [], 'usage': {'input_tokens': 2, 'output_tokens': 1}}
    if actual_model:
        message['model'] = actual_model
    if transport == 'cli':
        events = ClaudeCodeEventMapper()._map_events({'type': 'assistant', 'message': message}, {})
    else:
        events = ClaudeAgentSDKEventMapper()._map_message(SimpleNamespace(type='assistant', **message), {})
    event, = [event for event in events if event.type == 'usage_update']
    assert event.data.get('model') == actual_model
