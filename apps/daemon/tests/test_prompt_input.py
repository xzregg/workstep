"""Prompt inspection displays every captured content item, not just the body."""

import pytest

from agent_assistants.prompt_input import format_prompt_input


@pytest.mark.parametrize("transport", ["system", "developer"])
def test_prompt_view_keeps_all_content_without_duplicate_record(transport):
    data = {
        "engine": "test", "attempt": 1, "session_id": "thread",
        "instruction_transport": transport,
        "system_prompt": "全局规则\n\n渠道背景：群 ID=room；发送者=小王",
        "prompt": "用户原文\n附加计划指令\n补充上下文",
        "message_history": [
            {"role": "user", "content": "之前的问题"},
            {"role": "assistant", "content": "之前的回答"},
        ],
        "images": [".workstep/uploads/image.png"],
    }
    display = format_prompt_input(data)
    assert "调用尝试" not in display
    assert "本次调用由 WorkStep" not in display
    assert f"### 独立指令（{transport}）" in display
    assert data["system_prompt"] in display  # Real newlines, not JSON escapes only.
    assert "### 正文（user）" in display
    assert data["prompt"] in display
    assert "### 显式传入的历史消息" in display
    assert "之前的问题" in display and "之前的回答" in display
    assert "### 图片输入" in display and data["images"][0] in display
    assert "原始调用记录" not in display
    assert '"system_prompt":' not in display and '"prompt":' not in display
    assert display.count("全局规则") == 1
    assert display.count("用户原文") == 1


def test_body_fallback_does_not_invent_a_system_message():
    display = format_prompt_input({
        "attempt": 2, "instruction_transport": "body",
        "system_prompt": None, "system_prompt_in_body": True, "prompt": "固定规则\n\n用户消息",
        "message_history": None, "images": [],
    })
    assert "### 正文（user，包含指令正文降级）" in display
    assert "固定规则\n\n用户消息" in display
    assert "### 独立指令（system）" not in display
    assert "本轮未传入" not in display
    assert "## 重试 2" in display


def test_expanded_content_cannot_close_its_markdown_fence():
    display = format_prompt_input({
        "instruction_transport": "system", "system_prompt": "规则\n```\n假标题",
        "prompt": "原文\n````\n更多原文",
    })
    assert "````text\n规则\n```\n假标题\n````" in display
    assert "`````text\n原文\n````\n更多原文\n`````" in display


def test_prompt_view_preserves_tool_history_metadata():
    data = {"prompt": "继续", "message_history": [{
        "role": "assistant", "content": "",
        "tool_calls": [{"id": "call", "function": {"name": "read", "arguments": "file.py"}}],
    }, {"role": "tool", "tool_call_id": "call", "content": "文件正文"}]}
    display = format_prompt_input(data)
    assert '"tool_calls"' in display
    assert "file.py" in display
    assert '"tool_call_id": "call"' in display
    assert "文件正文" in display


def test_plain_input_has_only_one_section():
    display = format_prompt_input({"prompt": "在企业微信发一条消息。", "system_prompt": None, "attempt": 1})
    assert display == "### 正文（user）\n\n```text\n在企业微信发一条消息。\n```"


def test_native_instruction_restore_sentinel_is_not_a_new_injection():
    display = format_prompt_input({
        "instruction_transport": "developer", "system_prompt": "", "prompt": "继续",
    })
    assert "独立指令" not in display
    assert display == "### 正文（user）\n\n```text\n继续\n```"


def test_assistant_config_separates_instruction_transport():
    from agent_assistants.base import AssistantConfig, AssistantRuntime
    from agent_assistants.session_state import AssistantSession
    config = AssistantConfig(name="test", channel="test", system_prompt="固定规则", system_prompt_transport=True)
    runtime = AssistantRuntime(config, None, None)
    session = AssistantSession(scope="ephemeral", session_id="test", project_id="p", engine="codex", model=None, fast_model=None, cwd=".")
    session.messages = [{"id":"u", "role":"user", "content":"实际问题"}]
    assert runtime._engine_system_prompt(session) == "固定规则"
    assert "固定规则" not in runtime._build_prompt(session)
    assert "实际问题" in runtime._build_prompt(session)
    assert runtime._display_prompt(session, "实际问题") == ""
    assert runtime._capture_prompt_input()
    assert "固定规则" not in runtime._build_rebuild_prompt(session)



def test_transient_prompt_views_are_isolated_by_project():
    from agent_assistants.prompt_input import append_prompt_view, get_prompt_view
    append_prompt_view("project-a", "same-id", {"prompt":"A"})
    append_prompt_view("project-b", "same-id", {"prompt":"B"})
    assert "A" in get_prompt_view("project-a", "same-id")
    assert "B" not in get_prompt_view("project-a", "same-id")
    assert "B" in get_prompt_view("project-b", "same-id")
    assert get_prompt_view("project-c", "same-id") is None



def test_restored_workflow_messages_do_not_reuse_old_synthetic_prompt():
    from agent_assistants.persistence import _restore_messages
    messages = _restore_messages('[{"id":"old", "role":"assistant", "content":"回答", "prompt":"旧合成提示词"}]', persist_prompt=False)
    assert messages == [{"id":"old", "role":"assistant", "content":"回答"}]
