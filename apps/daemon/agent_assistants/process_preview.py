"""Project the last two process rows; never return tool bodies or text history."""
from collections import deque
from collections.abc import Iterable

from agent_assistants.history import _event_time_ms


def process_preview(events: Iterable[dict]) -> list[dict]:
    rows: deque[dict] = deque(maxlen=2)
    adjacent = None
    seen_tools: set[str] = set()
    for event in events:
        kind = event.get('type')
        timestamp = event.get('timestamp', event.get('created_at'))
        if kind in {'REASONING_MESSAGE_CHUNK', 'TEXT_MESSAGE_CHUNK', 'TEXT_MESSAGE_CONTENT'}:
            if kind != 'REASONING_MESSAGE_CHUNK' and event.get('phase') != 'commentary':
                adjacent = None  # final-answer blocks separate process groups
                continue
            key = ('thinking',) if kind == 'REASONING_MESSAGE_CHUNK' else ('commentary', event.get('source_item_id'))
            text = str(event.get('delta') or event.get('content') or '')
            if not text:
                continue
            if rows and adjacent == key:
                row = rows[-1]
                row['event']['delta'] = (text if kind == 'TEXT_MESSAGE_CONTENT' else row['event']['delta'] + text)[-160:]
            else:
                row = {'event': {key: event[key] for key in ('type', 'phase', 'source_item_id', 'sequence', 'timestamp', 'created_at') if key in event}}
                row['event'].update(type='REASONING_MESSAGE_CHUNK' if key[0] == 'thinking' else 'TEXT_MESSAGE_CHUNK', delta=text[-160:])
                rows.append(row)
            adjacent = key
        elif kind in {'TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_CHUNK', 'TOOL_CALL_RESULT'}:
            tool_id = str(event.get('toolCallId') or '')
            if not tool_id:
                continue
            row = next((row for row in rows if tool_id in row.get('tools', {})), None)
            if row is None:
                if tool_id in seen_tools:
                    continue  # An update to an older row must not reorder the preview.
                seen_tools.add(tool_id)
                if rows and adjacent == ('tools',):
                    row = rows[-1]
                else:
                    row = {'tools': {}, 'event': {'type': 'TOOL_CALL_START', 'toolCallId': tool_id,
                           'toolCallName': str(event.get('toolCallName') or event.get('name') or 'tool')[:256]}}
                    rows.append(row)
                row['tools'][tool_id] = {'done': False, 'failed': False, 'args': {}}
                adjacent = ('tools',)
            tool = row['tools'][tool_id]
            if kind == 'TOOL_CALL_START':
                if len(row['tools']) == 1:
                    row['event'].update(toolCallName=str(event.get('toolCallName') or event.get('name') or 'tool')[:256])
                    if event.get('kind'):
                        row['event']['kind'] = event['kind']
                if timestamp is not None:
                    start = _event_time_ms(timestamp)
                    previous = _event_time_ms(row['event'].get('timestamp'))
                    if start is not None and (previous is None or start < previous):
                        row['event']['timestamp'] = timestamp
            elif kind == 'TOOL_CALL_RESULT':
                tool.update(done=True, failed=bool(event.get('isError')))
                end = _event_time_ms(timestamp)
                if end is not None:
                    row['event']['previewEndedAt'] = max(row['event'].get('previewEndedAt', end), end)
            elif kind == 'TOOL_CALL_ARGS' and len(row['tools']) == 1 and isinstance(event.get('args'), dict):
                # Only short file targets help a collapsed row. Commands, patches
                # and nested outputs are unnecessary for the preview.
                tool['args'] = {key: value[:256] for key, value in event['args'].items()
                                if key in {'path', 'file_path', 'filePath', 'filename', 'pattern', 'query'} and isinstance(value, str)}
        elif kind == 'CUSTOM' and event.get('name') == 'workstep.subagent':
            value = event.get('value') or {}
            task_id = str(value.get('task_id') or value.get('id') or '')
            row = next((row for row in rows if row.get('task_id') == task_id), None)
            if row is None:
                row = {'task_id': task_id, 'event': {'type': 'CUSTOM', 'name': 'workstep.subagent', 'value': {}}}
                rows.append(row)
                adjacent = None
            row['event']['value'].update({key: value[key][:256] for key in ('task_id', 'id', 'description', 'status', 'started_at', 'ended_at')
                                         if isinstance(value.get(key), str)})
    result = []
    for row in rows:
        event = {**row['event'], 'previewOnly': True}
        tools = row.get('tools')
        if tools:
            event.update(previewCount=len(tools), previewHasResult=all(tool['done'] for tool in tools.values()),
                         previewIsError=any(tool['failed'] for tool in tools.values()))
            if not event['previewHasResult']:
                event.pop('previewEndedAt', None)
        result.append(event)
        if tools and len(tools) == 1 and (args := next(iter(tools.values()))['args']):
            result.append({'type': 'TOOL_CALL_ARGS', 'toolCallId': event['toolCallId'], 'args': args, 'previewOnly': True})
    return result


def preview_agui_events(events: Iterable[dict], **context):
    """Keep the canonical replay translator, excluding bodies the preview cannot use."""
    from agent_assistants.event_replay import _detail_agui_events
    for index, event in enumerate(events, start=1):
        event = {**event, 'seq': event.get('seq') or event.get('sequence') or index}
        kind = event.get('type', '')
        if kind == 'agent_message_chunk' and (event.get('data') or {}).get('phase') != 'commentary':
            yield {'type': 'TEXT_MESSAGE_CHUNK'}
            continue
        if kind in {'tool_call', 'tool_call_update'}:
            data = event.get('data') or {}
            event = {**event, 'data': {key: data[key] for key in ('tool_call_id', 'title', 'name', 'kind', 'status') if key in data}}
            if isinstance(data.get('raw_input'), dict):
                event['data']['raw_input'] = {key: value[:256] for key, value in data['raw_input'].items()
                    if key in {'path', 'file_path', 'filePath', 'filename', 'pattern', 'query'} and isinstance(value, str)}
        elif kind == 'subagent':
            data = event.get('data') or {}
            event = {**event, 'data': {key: data[key] for key in ('task_id', 'id', 'description', 'status', 'started_at', 'ended_at') if key in data}}
        elif kind not in {'agent_message_chunk', 'agent_thought_chunk', 'TEXT_MESSAGE_CHUNK', 'TEXT_MESSAGE_CONTENT',
                          'REASONING_MESSAGE_CHUNK', 'TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_CHUNK', 'TOOL_CALL_RESULT', 'CUSTOM'}:
            continue
        yield from _detail_agui_events([event], **context)
