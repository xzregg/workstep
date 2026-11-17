import json

from agent_assistants.process_preview import process_preview


def test_preview_aggregates_only_latest_two_rows_without_tool_payloads():
    def events():
        yield {'type': 'REASONING_MESSAGE_CHUNK', 'delta': 'old thought'}
        for index in range(1000):
            yield {'type': 'TOOL_CALL_START', 'toolCallId': str(index), 'toolCallName': 'exec', 'timestamp': index + 1}
            yield {'type': 'TOOL_CALL_RESULT', 'toolCallId': str(index), 'output': 'secret output' * 1000,
                   'timestamp': index + 2, 'isError': index == 0}
        for _ in range(1000):
            yield {'type': 'TEXT_MESSAGE_CHUNK', 'phase': 'commentary', 'delta': 'progress'}
    preview = process_preview(events())
    assert len(preview) == 2
    assert preview[0]['type'] == 'TOOL_CALL_START'
    assert preview[0]['previewCount'] == 1000
    assert preview[0]['previewHasResult'] is True
    assert preview[0]['previewIsError'] is True
    assert preview[1]['delta'] == ('progress' * 1000)[-160:]
    assert 'output' not in json.dumps(preview)
    assert 'old thought' not in json.dumps(preview)
    assert len(json.dumps(preview)) < 1500


def test_preview_updates_recent_tool_groups_without_moving_them_to_the_tail():
    preview = process_preview(iter([
        {'type': 'TOOL_CALL_START', 'toolCallId': 'a', 'toolCallName': 'read', 'kind': 'read', 'timestamp': 100},
        {'type': 'TOOL_CALL_ARGS', 'toolCallId': 'a', 'args': {'path': 'a.py', 'huge': 'x' * 100000}},
        {'type': 'REASONING_MESSAGE_CHUNK', 'delta': 'think'},
        {'type': 'TOOL_CALL_RESULT', 'toolCallId': 'a', 'output': 'x' * 100000, 'timestamp': 200},
    ]))
    assert len(preview) == 3  # start + small path args form one process row
    assert preview[0]['previewHasResult'] is True
    assert preview[1]['args'] == {'path': 'a.py'}
    assert preview[2]['delta'] == 'think'
    assert len(json.dumps(preview)) < 1500


def test_preview_final_answer_separates_process_blocks_without_sending_body():
    preview = process_preview(iter([
        {'type': 'REASONING_MESSAGE_CHUNK', 'delta': 'first'},
        {'type': 'TEXT_MESSAGE_CHUNK', 'delta': 'answer' * 10000},
        {'type': 'REASONING_MESSAGE_CHUNK', 'delta': 'second'},
        {'type': 'REASONING_MESSAGE_CHUNK', 'delta': ' tail'},
    ]))
    assert [event['delta'] for event in preview] == ['first', 'second tail']
    assert all(event['previewOnly'] for event in preview)


def test_preview_ignores_late_updates_to_rows_older_than_its_two_visible_rows():
    preview = process_preview(iter([
        {'type': 'TOOL_CALL_START', 'toolCallId': 'old'},
        {'type': 'TEXT_MESSAGE_CHUNK', 'phase': 'commentary', 'delta': 'progress'},
        {'type': 'TOOL_CALL_START', 'toolCallId': 'new'},
        {'type': 'TOOL_CALL_RESULT', 'toolCallId': 'old', 'output': 'old result'},
    ]))
    assert len(preview) == 2
    assert preview[0]['delta'] == 'progress'
    assert preview[1]['toolCallId'] == 'new'


def test_unfinished_tool_group_keeps_a_live_duration_instead_of_its_last_completed_time():
    preview = process_preview(iter([
        {'type': 'TOOL_CALL_START', 'toolCallId': 'a', 'timestamp': 100},
        {'type': 'TOOL_CALL_START', 'toolCallId': 'b', 'timestamp': 101},
        {'type': 'TOOL_CALL_RESULT', 'toolCallId': 'a', 'timestamp': 102},
    ]))
    assert preview[0]['previewCount'] == 2
    assert preview[0]['previewHasResult'] is False
    assert 'previewEndedAt' not in preview[0]
