"""Tests for P4: intervention, history replay, artifact versioning."""

import asyncio
import json
import time
import uuid
import pytest
from pathlib import Path

from services.intervention import InterventionManager
from services.history import get_task_history, get_step_history, replay_events
from models import init_db, Task, TaskStep, Message


# --- InterventionManager ---

def test_intervention_deliver_response():
    """deliver_response resolves a pending request."""
    mgr = InterventionManager()

    async def _test():
        # Start a request in the background
        task = asyncio.create_task(
            mgr.request_response("int-1", "task-1", "step-1", {"q": "approve?"})
        )
        # Give it a moment to register
        await asyncio.sleep(0.01)
        assert mgr.pending_count == 1
        assert "int-1" in mgr.list_pending()

        # Deliver response
        assert mgr.deliver_response("int-1", {"answer": "yes"})

        # Request should complete
        result = await task
        assert result == {"answer": "yes"}
        assert mgr.pending_count == 0

    asyncio.run(_test())


def test_intervention_unknown_returns_false():
    mgr = InterventionManager()
    assert mgr.deliver_response("nonexistent", {}) is False


def test_intervention_pending_projection_is_task_scoped_and_cleared():
    mgr = InterventionManager()

    async def run():
        visible = asyncio.create_task(mgr.request_response(
            "visible", "task-1", "build", {"method": "elicitation/create", "message": "Question"},
        ))
        private = asyncio.create_task(mgr.request_response(
            "private", "task-2", "build", {"method": "elicitation/create", "message": "Secret"},
        ))
        await asyncio.sleep(0)
        assert mgr.list_pending_for_task("task-1") == [{
            "interaction_id": "visible", "step_key": "build",
            "request": {"method": "elicitation/create", "message": "Question"},
        }]
        mgr.deliver_response("visible", {"action": "cancel"}, "task-1")
        await visible
        assert mgr.list_pending_for_task("task-1") == []
        mgr.cancel("private")
        await private

    asyncio.run(run())


def test_intervention_cancel():
    mgr = InterventionManager()

    async def _test():
        task = asyncio.create_task(
            mgr.request_response("int-2", "t", "s", {"q": "?"})
        )
        await asyncio.sleep(0.01)
        assert mgr.cancel("int-2")
        result = await task
        assert result["error"] == "cancelled"

    asyncio.run(_test())


def test_intervention_cancel_for_task_step_is_scoped():
    """Stopping one step releases only that step's pending interactions."""
    mgr = InterventionManager()

    async def _test():
        matching = asyncio.create_task(
            mgr.request_response("int-step-a", "task-1", "step-a", {"q": "?"})
        )
        other_step = asyncio.create_task(
            mgr.request_response("int-step-b", "task-1", "step-b", {"q": "?"})
        )
        other_task = asyncio.create_task(
            mgr.request_response("int-task-2", "task-2", "step-a", {"q": "?"})
        )
        await asyncio.sleep(0.01)

        assert mgr.cancel_for_task_step("task-1", "step-a") == 1
        assert await matching == {"error": "cancelled"}
        assert not other_step.done()
        assert not other_task.done()

        assert mgr.cancel_for_task("task-1") == 1
        assert await other_step == {"error": "cancelled"}
        assert not other_task.done()

        assert mgr.cancel("int-task-2")
        assert await other_task == {"error": "cancelled"}

    asyncio.run(_test())


def test_intervention_waits_indefinitely():
    """request_response waits indefinitely until a response arrives (no timeout)."""
    mgr = InterventionManager()

    async def _test():
        task = asyncio.create_task(
            mgr.request_response("int-3", "t", "s", {"q": "?"})
        )
        await asyncio.sleep(0.05)
        # Still pending after a wait — no safety timeout fires.
        assert mgr.pending_count == 1
        assert "int-3" in mgr.list_pending()
        assert not task.done()

        assert mgr.deliver_response("int-3", {"answer": "yes"})
        result = await task
        assert result == {"answer": "yes"}
        assert mgr.pending_count == 0

    asyncio.run(_test())


def test_seal_unanswered_interactions_appends_cancelled():
    """seal_unanswered_interactions 为未决交互补 cancelled 终态，已配对的不动。"""
    from services.intervention import seal_unanswered_interactions

    events = [
        {"type": "interaction_request", "data": {
            "interaction_id": "a",
            "method": "session/request_permission",
        }, "timestamp": 1},
        {"type": "interaction_request", "data": {
            "interaction_id": "b",
            "method": "elicitation/create",
        }, "timestamp": 2},
        {"type": "interaction_response", "data": {
            "interaction_id": "b",
            "method": "elicitation/create",
            "response": {"action": "accept"},
        }, "timestamp": 3},
    ]
    sealed = json.loads(
        seal_unanswered_interactions(json.dumps(events, ensure_ascii=False))
    )
    responses = [e for e in sealed if e["type"] == "interaction_response"]
    assert [e["data"]["interaction_id"] for e in responses] == ["b", "a"]
    assert responses[1]["data"]["response"] == {"outcome": {"outcome": "cancelled"}}
    assert responses[1]["data"]["method"] == "session/request_permission"
    assert sealed[:3] == events


def test_seal_unanswered_interactions_noop_when_answered():
    """所有交互均已响应时 events_json 原样返回。"""
    from services.intervention import seal_unanswered_interactions

    events = [
        {"type": "interaction_request", "data": {"interaction_id": "a"}, "timestamp": 1},
        {"type": "interaction_response", "data": {
            "interaction_id": "a",
            "response": {"outcome": {"outcome": "cancelled"}},
        }, "timestamp": 2},
    ]
    raw = json.dumps(events, ensure_ascii=False)
    assert seal_unanswered_interactions(raw) == raw


def test_seal_unanswered_interactions_handles_invalid_input():
    """空值/非法 JSON 原样返回，不抛错。"""
    from services.intervention import seal_unanswered_interactions

    assert seal_unanswered_interactions(None) is None
    assert seal_unanswered_interactions("not-json") == "not-json"


def test_intervention_double_deliver():
    """Second deliver_response returns False."""
    mgr = InterventionManager()

    async def _test():
        task = asyncio.create_task(
            mgr.request_response("int-4", "t", "s", {"q": "?"})
        )
        await asyncio.sleep(0.01)
        assert mgr.deliver_response("int-4", {"a": 1})
        assert not mgr.deliver_response("int-4", {"a": 2})  # already resolved
        await task

    asyncio.run(_test())


def test_intervention_deliver_response_can_be_scoped_to_task():
    """A scoped response only resolves an intervention for the same task."""
    mgr = InterventionManager()

    async def _test():
        task = asyncio.create_task(
            mgr.request_response("int-5", "task-a", "s", {"q": "?"})
        )
        await asyncio.sleep(0.01)
        assert mgr.deliver_response("int-5", {"a": 1}, task_id="task-b") is False
        assert mgr.pending_count == 1
        assert mgr.deliver_response("int-5", {"a": 1}, task_id="task-a") is True
        assert await task == {"a": 1}

    asyncio.run(_test())


# --- History replay ---

@pytest.fixture
def db_with_history(tmp_path):
    """Create a DB with task, steps, and messages for history tests."""
    db = init_db(str(tmp_path / "test.db"))
    now = int(time.time())
    task_id = str(uuid.uuid4())

    task = Task.create(
        id=task_id, title="History test", cwd=str(tmp_path),
        created_at=now, updated_at=now,
    )
    TaskStep.create(task=task, step_key="req", status="passed")
    TaskStep.create(task=task, step_key="ui", status="passed")

    # Messages with events
    events_req = [
        {"type": "text_delta", "data": {"delta": "PRD "}, "timestamp": now * 1000},
        {"type": "text_delta", "data": {"delta": "content"}, "timestamp": now * 1000 + 1},
        {"type": "usage", "data": {"input_tokens": 50, "output_tokens": 20}},
    ]
    Message.create(
        id=str(uuid.uuid4()), task=task, step_key="req", role="assistant",
        content="PRD content", run_status="succeeded",
        events_json=json.dumps(events_req),
        position=1, created_at=now, ended_at=now,
    )

    events_ui = [
        {"type": "text_delta", "data": {"delta": "UI spec"}, "timestamp": now * 1000},
    ]
    Message.create(
        id=str(uuid.uuid4()), task=task, step_key="ui", role="assistant",
        content="UI spec", run_status="succeeded",
        events_json=json.dumps(events_ui),
        position=1, created_at=now, ended_at=now,
    )

    yield db, task_id
    db.close()


def test_get_task_history(db_with_history):
    _, task_id = db_with_history
    history = get_task_history(task_id)
    assert len(history) == 2
    assert history[0]["step_key"] == "req"
    assert history[0]["content"] == "PRD content"
    assert len(history[0]["events"]) == 3
    assert history[1]["step_key"] == "ui"
    assert history[1]["content"] == "UI spec"


def test_get_task_history_converts_legacy_visualize_markers(db_with_history):
    """任务消息历史读取时把旧 visualize 标记转成 Markdown 文件链接。"""
    _, task_id = db_with_history
    path = (
        "/Users/example/workstep/.workstep/visualizations/"
        "stage-progress-card-prototypes.html"
    )
    marker = '\ue200visualize{"path":"<path>","mode":"wide"}\ue201'.replace(
        "<path>", path
    )
    msg = Message.select().where(Message.step_key == "ui").get()
    Message.update(content=f"UI spec\n\n{marker}").where(
        Message.id == msg.id
    ).execute()

    history = get_task_history(task_id)
    content = [item for item in history if item["step_key"] == "ui"][0]["content"]
    assert content == (
        "UI spec\n\n"
        "[stage-progress-card-prototypes.html]"
        f"(file://{path})"
    )
    assert "\ue200" not in content


def test_get_task_history_converts_bare_visualize_marker_in_events(db_with_history):
    """任务历史 events 里的正文 chunk 也要转换，保证前端交织渲染一致。"""
    _, task_id = db_with_history
    path = (
        "/Users/example/workstep/.workstep/visualizations/"
        "stage-progress-card-prototypes.html"
    )
    bare = f'visualize{{"path":"{path}","mode":"wide"}}'
    msg = Message.select().where(Message.step_key == "ui").get()
    Message.update(
        engine="codex_sdk",
        events_json=json.dumps([{
            "type": "agent_message_chunk",
            "data": {"content": {"text": f"UI spec\n\n{bare}"}},
        }], ensure_ascii=False),
    ).where(Message.id == msg.id).execute()

    history = get_task_history(task_id)
    entry = [item for item in history if item["step_key"] == "ui"][0]
    delta = entry["events"][0]["delta"]
    assert delta == (
        "UI spec\n\n"
        "[stage-progress-card-prototypes.html]"
        f"(file://{path})"
    )
    assert bare not in delta


def test_session_id_is_projected_from_each_message_events():
    from services.history import session_id_from_events

    assert session_id_from_events([
        {"type": "session_started", "data": {"session_id": "codex-session"}},
    ]) == "codex-session"
    assert session_id_from_events([]) is None


def test_get_step_history(db_with_history):
    _, task_id = db_with_history
    history = get_step_history(task_id, "req")
    assert len(history) == 1
    assert history[0]["events"][0]["type"] == "TEXT_MESSAGE_CHUNK"


def test_replay_events(db_with_history):
    _, task_id = db_with_history
    history = get_task_history(task_id)
    all_events = []
    for msg in history:
        for event in replay_events(msg["events"]):
            all_events.append(event)
    assert len(all_events) == 4  # 3 from req + 1 from ui


def test_history_empty_task(tmp_path):
    """History for a task with no messages returns empty list."""
    db = init_db(str(tmp_path / "test.db"))
    task_id = str(uuid.uuid4())
    Task.create(
        id=task_id, title="Empty", cwd=str(tmp_path),
        created_at=int(time.time()), updated_at=int(time.time()),
    )
    assert get_task_history(task_id) == []
    db.close()
