"""event_truncation — 下发出口的工具载荷截断。"""

import json

from agent_assistants.event_truncation import (
    LARGE_PAYLOAD_LIMIT,
    truncate_large_tool_payloads,
)


def test_small_payload_returns_same_reference():
    event = {"type": "tool_call_update", "data": {"raw_output": "ok"}}
    assert truncate_large_tool_payloads(event) is event


def test_huge_raw_output_truncated_with_marker():
    huge = "x" * (LARGE_PAYLOAD_LIMIT + 1000)
    event = {
        "type": "tool_call_update",
        "data": {"tool_call_id": "t1", "raw_output": huge},
    }
    out = truncate_large_tool_payloads(event)
    assert out is not event
    # copy-on-write：原事件不被就地修改（日志/会话状态共享同一引用）
    assert event["data"]["raw_output"] == huge
    text = out["data"]["raw_output"]
    assert len(text) < len(huge)
    assert "已截断" in text
    assert str(len(huge)) in text
    # 其余字段原样保留
    assert out["data"]["tool_call_id"] == "t1"
    assert out["type"] == "tool_call_update"


def test_nested_structures_and_lists():
    # 用 2×LIMIT：截断标记本身占 ~23 字符，略超上限的输入截断后总长可能反而变长
    huge = "y" * (LARGE_PAYLOAD_LIMIT * 2)
    event = {
        "data": {"event": {"data": {"raw_output": huge}}},
        "output": huge,
        "siblings": [{"raw_input": huge}, {"raw_input": "small"}],
    }
    out = truncate_large_tool_payloads(event)
    assert len(out["data"]["event"]["data"]["raw_output"]) < len(huge)
    assert len(out["output"]) < len(huge)
    assert len(out["siblings"][0]["raw_input"]) < len(huge)
    assert out["siblings"][1] is event["siblings"][1]


def test_message_content_never_truncated():
    huge = "z" * (LARGE_PAYLOAD_LIMIT * 2)
    event = {"type": "TEXT_MESSAGE_END", "content": huge, "data": {"content": huge}}
    # content 不在截断字段内 → 整体原引用返回
    assert truncate_large_tool_payloads(event) is event


def test_non_string_payload_untouched():
    event = {"data": {"raw_output": {"nested": ["a", "b"]}}}
    assert truncate_large_tool_payloads(event) is event


def test_task_history_translate_events_truncates_payloads():
    """任务历史回放（translate_events 统一读路径）同样不得漏出巨串。

    任务历史整包随 HTTP 下发，前端 taskStore/历史消息直接常驻内存；
    数十 MB 的 raw_output 一旦进入翻译输出，渲染进程内存会被打爆。
    """
    from services.history import translate_events

    huge = "x" * (LARGE_PAYLOAD_LIMIT * 2)
    events = [{
        "type": "tool_call_update",
        "seq": 1,
        "data": {"tool_call_id": "t1", "raw_output": huge},
    }]
    out = translate_events(events, task_id="task-1", message_id="m-1")
    serialized = json.dumps(out, ensure_ascii=False, default=str)
    assert out
    assert len(serialized) < len(huge)
