import asyncio
from types import SimpleNamespace as NS

import pytest

from engines.codex_sdk import CodexSDKEngine
from engines.core.agui import AGUIContext, to_agui_events

SubAgentActivityThreadItem = pytest.importorskip(
    "openai_codex.generated.v2_all",
).SubAgentActivityThreadItem


def activity(kind, method="item/completed", child="child-1"):
    item = SubAgentActivityThreadItem.model_validate({
        "type": "subAgentActivity", "id": f"activity-{child}-{kind}",
        "agentPath": f"/root/{child}", "agentThreadId": child, "kind": kind,
    })
    return NS(method=method, payload=NS(item=NS(root=item)))


@pytest.mark.parametrize("kind,status", [
    ("started", "running"), ("interacted", "running"),
    ("interrupted", "stopped"), ("completed", "completed"),
])
def test_native_activity_maps_once_by_child_identity(kind, status):
    engine = CodexSDKEngine()
    state = {"tool_emitted": set()}
    events = engine._map_notification(activity(kind, "item/started"), state)
    events += engine._map_notification(activity(kind), state)
    assert len(events) == 1
    event = events[0]
    assert event.type == "subagent"
    assert event.data["task_id"] == "child-1"
    assert event.data["description"] == "/root/child-1"
    assert event.data["status"] == status
    outward = to_agui_events(event, AGUIContext(message_id="parent"))
    assert outward[0]["name"] == "workstep.subagent"
    assert not state.get("emitted_text")


@pytest.mark.asyncio
async def test_completed_child_result_is_nested_deduplicated_and_nonblocking(monkeypatch):
    engine = CodexSDKEngine()
    state = {"tool_emitted": set()}
    engine._map_notification(activity("completed"), state)
    entered, release = asyncio.Event(), asyncio.Event()

    class Thread:
        def __init__(self, client, id):
            assert id == "child-1"

        async def read(self, *, include_turns):
            assert include_turns
            entered.set()
            await release.wait()
            return NS(thread=NS(turns=[NS(items=[NS(root=NS(
                type="agentMessage", id="answer-1", text="1", phase="final_answer",
            ))])]))

    monkeypatch.setattr("openai_codex.AsyncThread", Thread)
    task = asyncio.create_task(engine._read_subagent_result(object(), "child-1", state))
    await asyncio.wait_for(entered.wait(), 1)
    # A slow SDK read must leave the event loop available.
    await asyncio.wait_for(asyncio.sleep(0), 0.1)
    release.set()
    events = await task
    assert len(events) == 1
    outward = to_agui_events(events[0], AGUIContext(message_id="parent"))[0]
    assert outward["value"]["events"][0]["delta"] == "1"
    assert outward["value"]["task_id"] == "child-1"
    assert outward["value"]["status"] == "completed"
    assert not state.get("emitted_text")
    assert await engine._read_subagent_result(object(), "child-1", state) == []


@pytest.mark.asyncio
async def test_unavailable_child_history_preserves_lifecycle(monkeypatch):
    class Thread:
        def __init__(self, *args):
            pass

        async def read(self, **kwargs):
            raise RuntimeError("thread unavailable")

    monkeypatch.setattr("openai_codex.AsyncThread", Thread)
    engine = CodexSDKEngine()
    state = {"tool_emitted": set()}
    events = engine._map_notification(activity("completed"), state)
    assert events[0].data["status"] == "completed"
    assert await engine._read_subagent_result(object(), "child-1", state) == []


@pytest.mark.asyncio
async def test_child_prompt_is_read_from_native_user_input_once(monkeypatch):
    class Thread:
        def __init__(self, *args):
            pass

        async def read(self, **kwargs):
            return NS(thread=NS(turns=[NS(items=[NS(root=NS(
                type="userMessage", id="input", content=[NS(root=NS(type="text", text="实际指令"))],
            ))])]))

    monkeypatch.setattr("openai_codex.AsyncThread", Thread)
    engine = CodexSDKEngine()
    state = {"tool_emitted": set()}
    engine._map_notification(activity("started"), state)
    metadata = await engine._read_subagent_result(object(), "child-1", state)
    assert metadata[0].data["prompt"] == "实际指令"
    assert metadata[0].data["agent_name"] == "child-1"
    assert metadata[0].data["agent_path"] == "/root/child-1"
    engine._map_notification(activity("completed"), state)
    assert await engine._read_subagent_result(object(), "child-1", state) == []


@pytest.mark.asyncio
@pytest.mark.parametrize("cancel", [False, True])
async def test_spawn_drains_three_child_results_without_delaying_parent(tmp_path, monkeypatch, cancel):
    release = asyncio.Event()
    cancelled = []

    class Turn:
        async def stream(self):
            for number in (1, 2, 3):
                for kind in ("started", "completed"):
                    for method in ("item/started", "item/completed"):
                        yield activity(kind, method, f"child-{number}")
            yield NS(method="item/completed", payload=NS(item=NS(root=NS(
                type="agentMessage", id="parent-answer", text="parent",
                phase="final_answer",
            ))))

    class Parent:
        id = "parent-thread"

        async def turn(self, *args, **kwargs):
            return Turn()

    class Client:
        def __init__(self, **kwargs):
            self._client = NS(_sync=NS(_approval_handler=None))

        async def thread_start(self, **kwargs):
            return Parent()

        async def close(self):
            pass

    class Child:
        def __init__(self, client, id):
            self.id = id

        async def read(self, **kwargs):
            try:
                await release.wait()
            except asyncio.CancelledError:
                cancelled.append(self.id)
                raise
            return NS(thread=NS(turns=[NS(items=[NS(root=NS(
                type="agentMessage", id=f"answer-{self.id}",
                text=self.id[-1], phase="final_answer",
            ))])]))

    monkeypatch.setattr("openai_codex.AsyncCodex", Client)
    monkeypatch.setattr("openai_codex.AsyncThread", Child)
    monkeypatch.setattr("engines.codex_sdk.config_store.get_codex_sdk_config", lambda: {
        "model_reasoning_effort": "", "approval_mode": "", "sandbox": "workspace-write",
    })
    engine = CodexSDKEngine()
    stream = engine.spawn(prompt="test", cwd=str(tmp_path))
    events = []
    async for event in stream:
        events.append(event)
        if event.type == "agent_message_chunk":
            assert event.data["content"]["text"] == "parent"
            assert not release.is_set()
            if cancel:
                await asyncio.wait_for(engine.stop(), 1)
            else:
                release.set()
    if cancel:
        assert sorted(cancelled) == ["child-1", "child-1", "child-2", "child-2", "child-3", "child-3"]
        return
    children = [e for e in events if e.type == "subagent"]
    assert len(children) == 9
    results = [e for e in children if "event" in e.data]
    assert sorted(e.data["event"]["data"]["content"]["text"] for e in results) == ["1", "2", "3"]
    assert not any(e.type in {"acp_raw", "error"} for e in events)
