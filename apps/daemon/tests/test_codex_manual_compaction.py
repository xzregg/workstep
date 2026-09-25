import queue
from types import SimpleNamespace

import pytest

from engines.codex_compaction import compact_codex_thread
from engines.codex import CodexEngine
from engines.codex_sdk import CodexSDKEngine
from engines.openclaw import OpenClawEngine
from engines.core.events import compacted_event
from engines.core.acp_base import AcpEngineBase


@pytest.mark.anyio
async def test_compact_codex_thread_waits_for_matching_native_notification():
    calls = []

    class Thread:
        id = "thread-1"

        async def compact(self):
            calls.append("compact")

    class Notifications:
        def __init__(self):
            self.items = iter([
                SimpleNamespace(method="thread/compacted", payload=SimpleNamespace(thread_id="other")),
                SimpleNamespace(method="thread/compacted", payload=SimpleNamespace(thread_id="thread-1")),
            ])

        def register_goal_operation(self, thread_id):
            calls.append(("subscribe", thread_id))
            return self

        def next_notification(self):
            calls.append("notification")
            return next(self.items)

        def finish(self):
            calls.append("finish")

        def unregister_goal_operation(self, route):
            calls.append("unsubscribe")

    await compact_codex_thread(SimpleNamespace(_client=Notifications()), Thread())
    assert calls == [
        ("subscribe", "thread-1"), "compact", "notification",
        "notification", "finish", "unsubscribe",
    ]


@pytest.mark.anyio
async def test_compact_codex_thread_receives_sdk_turn_routed_event():
    from openai_codex._message_router import MessageRouter
    from openai_codex.models import ContextCompactedNotification, Notification

    router = MessageRouter()

    class Notifications:
        def register_goal_operation(self, thread_id):
            return router.register_goal(thread_id)

        def unregister_goal_operation(self, route):
            router.unregister_goal(route)

    class Thread:
        id = "thread-1"

        async def compact(self):
            router.route_notification(Notification(
                method="thread/compacted",
                payload=ContextCompactedNotification(
                    thread_id="thread-1", turn_id="compact-turn",
                ),
            ))

    await compact_codex_thread(
        SimpleNamespace(_client=Notifications()), Thread(), timeout=0.1,
    )


@pytest.mark.anyio
async def test_compact_codex_thread_accepts_persisted_compaction_when_notification_is_lost():
    class Route:
        def __init__(self):
            self.items = queue.Queue()

        def next_notification(self):
            item = self.items.get()
            if isinstance(item, BaseException):
                raise item
            return item

        def fail(self, exc):
            self.items.put(exc)

        def finish(self):
            pass

    class Notifications:
        def register_goal_operation(self, thread_id):
            return Route()

        def unregister_goal_operation(self, route):
            pass

    class Client:
        _client = Notifications()
        reads = 0
        compacted = False

    client = Client()

    class Thread:
        id = "thread-1"

        async def read(self, *, include_turns=False):
            assert include_turns
            client.reads += 1
            turns = [SimpleNamespace(id="old", status="completed", items=[
                SimpleNamespace(type="contextCompaction"),
            ])]
            if client.compacted:
                turns.append(SimpleNamespace(id="new", status="completed", items=[
                    SimpleNamespace(type="contextCompaction"),
                ]))
            return SimpleNamespace(thread=SimpleNamespace(turns=turns))

        async def compact(self):
            client.compacted = True

    await compact_codex_thread(client, Thread(), timeout=0.5, poll_interval=0.01)
    assert client.reads >= 2


@pytest.mark.anyio
async def test_compact_codex_thread_accepts_rollout_completion_without_thread_item(tmp_path):
    rollout = tmp_path / "rollout-thread-1.jsonl"
    rollout.write_text('{"type":"compacted"}\n{"type":"event_msg","payload":{"type":"task_complete"}}\n')

    class Route:
        def __init__(self):
            self.items = queue.Queue()

        def next_notification(self):
            item = self.items.get()
            if isinstance(item, BaseException):
                raise item
            return item

        def fail(self, exc):
            self.items.put(exc)

        def finish(self):
            pass

    class Notifications:
        def register_goal_operation(self, thread_id):
            return Route()

        def unregister_goal_operation(self, route):
            pass

    class Thread:
        id = "thread-1"

        async def read(self, *, include_turns=False):
            return SimpleNamespace(thread=SimpleNamespace(path=str(rollout), turns=[]))

        async def compact(self):
            with rollout.open("a") as stream:
                stream.write('{"type":"compacted"}\n')
                stream.write('{"type":"event_msg","payload":{"type":"task_complete"}}\n')

    await compact_codex_thread(
        SimpleNamespace(_client=Notifications()), Thread(),
        timeout=0.5, poll_interval=0.01,
    )


@pytest.mark.anyio
async def test_compact_codex_thread_completes_from_item_and_turn_events():
    class Route:
        def __init__(self):
            self.items = queue.Queue()
            for item in [
                SimpleNamespace(method="item/completed", payload=SimpleNamespace(
                    thread_id="thread-1", turn_id="turn-1",
                    item=SimpleNamespace(type="contextCompaction"),
                )),
                SimpleNamespace(method="turn/completed", payload=SimpleNamespace(
                    thread_id="thread-1", turn=SimpleNamespace(
                        id="turn-1", status="completed", items=[],
                    ),
                )),
            ]:
                self.items.put(item)

        def next_notification(self):
            item = self.items.get()
            if isinstance(item, BaseException):
                raise item
            return item

        def fail(self, exc):
            self.items.put(exc)

        def finish(self):
            pass

    class Notifications:
        def register_goal_operation(self, thread_id):
            return Route()

        def unregister_goal_operation(self, route):
            pass

    class Thread:
        id = "thread-1"

        async def compact(self):
            pass

    await compact_codex_thread(
        SimpleNamespace(_client=Notifications()), Thread(), timeout=0.1,
    )


@pytest.mark.anyio
async def test_compact_codex_thread_requires_native_notification():
    class Thread:
        id = "thread-1"

        async def compact(self):
            return None

    class Notifications:
        def __init__(self):
            self.items = queue.Queue()

        def register_goal_operation(self, thread_id):
            return self

        def next_notification(self):
            item = self.items.get()
            if isinstance(item, BaseException):
                raise item
            return item

        def fail(self, exc):
            self.items.put(exc)

        def finish(self):
            return None

        def unregister_goal_operation(self, route):
            return None

    with pytest.raises(TimeoutError, match="压缩完成事件"):
        await compact_codex_thread(
            SimpleNamespace(_client=Notifications()), Thread(), timeout=0.01,
        )


@pytest.mark.anyio
async def test_codex_cli_compact_uses_native_sdk_without_starting_exec(monkeypatch):
    import openai_codex

    calls = []

    class Thread:
        id = "thread-1"

        async def compact(self):
            calls.append("compact")

    class Notifications:
        def register_goal_operation(self, thread_id):
            return self

        def next_notification(self):
            return SimpleNamespace(
                method="thread/compacted",
                payload=SimpleNamespace(thread_id="thread-1"),
            )

        def finish(self):
            return None

        def unregister_goal_operation(self, route):
            return None

    class Client:
        _client = Notifications()

        def __init__(self, config):
            calls.append(("client", config.codex_bin))

        async def thread_resume(self, session_id, **kwargs):
            calls.append(("resume", session_id))
            return Thread()

        async def close(self):
            calls.append("close")

    async def unexpected_exec(*args, **kwargs):
        raise AssertionError("codex exec must not receive /compact")

    monkeypatch.setattr(openai_codex, "AsyncCodex", Client)
    monkeypatch.setattr("engines.codex.CodexEngine.resolve_binary", lambda self: "/fake/codex")
    monkeypatch.setattr("engines.codex.asyncio.create_subprocess_exec", unexpected_exec)

    events = [event async for event in CodexEngine().spawn(
        prompt="/compact", cwd="/tmp", session_id="thread-1",
    )]

    assert ("resume", "thread-1") in calls
    assert "compact" in calls
    assert "close" in calls
    assert [event.type for event in events if event.type == "compacted"] == ["compacted"]


@pytest.mark.anyio
async def test_codex_sdk_compact_does_not_start_a_model_turn(monkeypatch):
    import openai_codex

    calls = []

    class Thread:
        id = "thread-1"

        async def compact(self):
            calls.append("compact")

        async def turn(self, *args, **kwargs):
            raise AssertionError("/compact must not start a model turn")

    class Notifications:
        _sync = SimpleNamespace(_approval_handler=None)

        def register_goal_operation(self, thread_id):
            return self

        def next_notification(self):
            return SimpleNamespace(
                method="thread/compacted",
                payload=SimpleNamespace(thread_id="thread-1"),
            )

        def finish(self):
            return None

        def unregister_goal_operation(self, route):
            return None

    class Client:
        _client = Notifications()

        def __init__(self, **kwargs):
            pass

        async def thread_resume(self, session_id, **kwargs):
            calls.append(("resume", session_id))
            return Thread()

        async def close(self):
            return None

    monkeypatch.setattr(openai_codex, "AsyncCodex", Client)
    events = [event async for event in CodexSDKEngine().spawn(
        prompt="/compact", cwd="/tmp", session_id="thread-1",
    )]

    assert calls == [("resume", "thread-1"), "compact"]
    assert [event.type for event in events if event.type == "compacted"] == ["compacted"]


@pytest.mark.anyio
async def test_engine_without_resumable_compaction_rejects_command_before_spawn(monkeypatch):
    async def unexpected_spawn(*args, **kwargs):
        raise AssertionError("unsupported /compact must not reach the model")
        yield

    monkeypatch.setattr(OpenClawEngine, "spawn", unexpected_spawn)
    events = [event async for event in OpenClawEngine().spawn_with_retry(
        prompt="/compact", cwd="/tmp", session_id="old-session",
    )]

    assert len(events) == 1
    assert events[0].type == "error"
    assert "不支持" in events[0].data["message"]


@pytest.mark.anyio
async def test_plan_mode_does_not_append_instructions_to_compact_command(monkeypatch):
    from agent_assistants.base import invoke_engine

    received = []

    class Engine:
        capabilities = SimpleNamespace(supports_plan_mode=False)
        supports_resume = True
        supports_message_history = False

        async def spawn_with_retry(self, **kwargs):
            received.append(kwargs["prompt"])
            yield compacted_event()

        spawn = spawn_with_retry

    monkeypatch.setattr("agent_assistants.base.create_engine", lambda engine_id: Engine())

    await invoke_engine(
        "codex_sdk", None, "/tmp", "/compact", "existing-session",
        plan_mode=True,
    )

    assert received == ["/compact"]


@pytest.mark.anyio
async def test_compact_bypasses_assistant_prompt_wrapper(monkeypatch):
    from agent_assistants.base import invoke_engine

    received = []

    class Engine:
        capabilities = SimpleNamespace(supports_plan_mode=False)
        supports_resume = True
        supports_message_history = False

        async def spawn_with_retry(self, **kwargs):
            received.append(kwargs["prompt"])
            yield compacted_event()

        spawn = spawn_with_retry

    def wrapped_spawner(*args, **kwargs):
        raise AssertionError("assistant wrapper must not change /compact")

    monkeypatch.setattr("agent_assistants.base.create_engine", lambda engine_id: Engine())
    await invoke_engine(
        "codex_sdk", None, "/tmp", "/compact", "existing-session",
        spawner=wrapped_spawner,
    )

    assert received == ["/compact"]


@pytest.mark.anyio
async def test_slash_transport_requires_compaction_receipt():
    class SlashEngine(AcpEngineBase):
        ENGINE_ID = "test-slash"

        @staticmethod
        def is_installed():
            return True

        @staticmethod
        def get_version():
            return "test"

        @staticmethod
        def resolve_binary():
            return "fake"

        async def spawn(self, **kwargs):
            yield SimpleNamespace(type="agent_message_chunk", data={"content": {"text": "OK"}})

    events = [event async for event in SlashEngine().spawn_with_retry(
        prompt="/compact", cwd="/tmp", session_id="existing-session",
    )]

    assert events[-1].type == "error"
    assert "无法确认" in events[-1].data["message"]
