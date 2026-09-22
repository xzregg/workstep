import json

from agent_assistants.context_handoff import (
    append_handoff_log,
    compile_handoff,
    render_handoff,
)


MESSAGES = [
    {"role": "user", "content": "实现登录功能", "events": [{"type": "agent_thought_chunk", "data": {"text": "秘密推理"}}]},
    {"role": "assistant", "content": "决定使用 OAuth，并修改 auth.py"},
    {"role": "user", "content": "下一步补测试"},
]


def test_smart_handoff_is_structured_and_excludes_hidden_events():
    package = compile_handoff(MESSAGES, "smart", source_session_id="source-1")
    rendered = render_handoff(package)

    assert "实现登录功能" in rendered
    assert "下一步补测试" in rendered
    assert "auth.py" in rendered
    assert package["decisions"] == ["决定使用 OAuth，并修改 auth.py"]
    assert "source-1" in rendered
    assert "秘密推理" not in rendered


def test_full_handoff_preserves_every_visible_turn():
    package = compile_handoff(MESSAGES, "full", source_session_id="source-1")

    assert package["message_count"] == 3
    assert [item["role"] for item in package["messages"]] == ["user", "assistant", "user"]


def test_none_handoff_contains_no_messages():
    package = compile_handoff(MESSAGES, "none", source_session_id="source-1")

    assert package["message_count"] == 0
    assert package["messages"] == []


def test_none_handoff_log_records_boundary_without_history(tmp_path):
    messages = [
        {"id": "hidden-history", "role": "user", "content": "不要交接这段"},
    ]

    metadata = append_handoff_log(
        tmp_path,
        "session-none",
        messages,
        source_engine="claude",
        target_engine="codex",
        mode="none",
    )
    records = [
        json.loads(line)
        for line in (tmp_path / metadata["relative_path"])
        .read_text(encoding="utf-8")
        .splitlines()
    ]

    assert [record["type"] for record in records] == ["handoff_start", "handoff_end"]
    assert "不要交接这段" not in json.dumps(records, ensure_ascii=False)


def test_full_handoff_rejects_silently_truncated_history():
    oversized = [{"role": "user", "content": "x" * 120_001}]

    try:
        compile_handoff(oversized, "full", source_session_id="source-1")
    except ValueError as exc:
        assert "智能交接" in str(exc)
    else:
        raise AssertionError("oversized full history must be rejected")
