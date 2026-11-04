"""Coordinator dispatch keeps its identity across CLI/HTTP and finishes independently."""

import asyncio
import json
import threading
import time
from types import SimpleNamespace

import httpx
import pytest

from tests.test_coordinator import api_context, _create_task, _wait_for_reply, CoordinatorFakeEngine
from engines.core.events import InternalEvent
from engines.core.registry import ENGINE_REGISTRY
from models import CoordinatorTurn, Message, TaskStep


@pytest.mark.anyio
@pytest.mark.parametrize("operation", ["start", "live"])
async def test_coordinator_start_keeps_source_and_does_not_wait_for_step(api_context, monkeypatch, operation):
    import main
    if operation == "start":
        import services.step_message_restart as persistence
    else:
        import services.step_live_messages as persistence
    from services.tool_registry import WorkstepClient

    client, tmp_path = api_context
    project_id, task_id = await _create_task(client, tmp_path)
    view = (await client.get(f"/api/task/{task_id}?project_id={project_id}")).json()
    step_key = view["steps"][0]["step_key"]
    await main.project_manager.run_db(project_id, lambda _: TaskStep.update(status="failed").where(
        (TaskStep.task == task_id) & (TaskStep.step_key == step_key)
    ).execute())
    published = []
    bus = main.workflow_runtime._event_bus
    original_publish = bus.publish

    async def publish(event):
        published.append(event)
        await original_publish(event)

    monkeypatch.setattr(bus, "publish", publish)

    async def restart(*args, **kwargs):
        await main.project_manager.run_db(project_id, lambda _: TaskStep.update(status="running").where(
            (TaskStep.task == task_id) & (TaskStep.step_key == step_key)
        ).execute())
        return SimpleNamespace(id="started-run")

    monkeypatch.setattr(main.workflow_runtime, "restart_from_step", restart)
    runner = None
    if operation == "live":
        from services.task_runner import TaskRunner

        runner = TaskRunner(bus, database_executor=main.project_manager.get_project_by_id(project_id).database_executor)
        runner._live._running_engines[f"{task_id}:{step_key}"] = SimpleNamespace(
            capabilities=SimpleNamespace(supports_live_step_message=True))
        runner._live._queues[f"{task_id}:{step_key}"] = asyncio.Queue()
        main.workflow_runtime._runners[task_id] = runner
        await main.project_manager.run_db(project_id, lambda _: TaskStep.update(status="running").where(
            (TaskStep.task == task_id) & (TaskStep.step_key == step_key)
        ).execute())
    entered = threading.Event()
    original_create = persistence.create_task_message

    def slow_create(**kwargs):
        entered.set()
        time.sleep(0.5)
        return original_create(**kwargs)

    monkeypatch.setattr(persistence, "create_task_message", slow_create)

    async def transport(request):
        return await client.request(request.method, str(request.url), content=request.content,
                                    headers=dict(request.headers))

    tools = WorkstepClient(base_url="http://test", transport=httpx.MockTransport(transport))

    class DispatchCoordinator(CoordinatorFakeEngine):
        async def spawn(self, **kwargs):
            instructions = kwargs.get("system_prompt") or kwargs["prompt"]
            assert "for dispatch-only requests" in instructions
            assert "only when the user explicitly requests it" in instructions
            result = await tools.call("workstep_start_step" if operation == "start" else "workstep_send_step_message", {
                "project_id": project_id, "task_id": task_id, "step_key": step_key,
                "content": "执行已授权的要求", "confirm": "yes",
            })
            assert result["status"] == "queued", result
            yield InternalEvent("agent_message_chunk", {"content": {"text": json.dumps({
                "version": 1, "reply": "已发起，步骤仍在执行", "proposal": None,
            }, ensure_ascii=False)}})

    monkeypatch.setitem(ENGINE_REGISTRY, "claude", DispatchCoordinator)
    accepted = await client.post(f"/api/task/{task_id}/chat?project_id={project_id}",
                                 headers={"Idempotency-Key": "source-dispatch",
                                          "X-WorkStep-User-Name": "requester"},
                                 json={"content": "启动步骤即可"})
    assert accepted.status_code == 200, accepted.text
    assert await asyncio.to_thread(entered.wait, 2)
    started = time.monotonic()
    assert (await client.get("/health")).status_code == 200
    assert time.monotonic() - started < 0.25
    reply = await _wait_for_reply(client, project_id, task_id, accepted.json()["assistant_message_id"])
    assert reply["run_status"] == "succeeded"

    def read(_):
        message = Message.get((Message.task == task_id) & (Message.content == "执行已授权的要求"))
        user = Message.get_by_id(accepted.json()["user_message_id"])
        return (message.author_type, message.author_name, message.reply_to_message_id,
                message.initiated_by_user_id, user.author_id,
                TaskStep.get((TaskStep.task == task_id) & (TaskStep.step_key == step_key)).status)

    fields = await main.project_manager.run_db(project_id, read)
    assert fields[:3] == ("coordinator", "协调助手", accepted.json()["assistant_message_id"])
    assert fields[3] == fields[4]
    assert fields[5] == "running"
    event = next(e for e in published if e.get("type") == "TEXT_MESSAGE_START"
                 and e.get("role") == "user" and e.get("channel") == "execution")
    assert event["actor"]["type"] == "coordinator"
    history = (await client.get(f"/api/task/{task_id}/history?project_id={project_id}")).json()["messages"]
    dispatch = next(m for m in history if m["content"] == "执行已授权的要求")
    assert dispatch["author_type"] == "coordinator"
    assert dispatch["reply_to_message_id"] == accepted.json()["assistant_message_id"]
    if runner is not None:
        main.workflow_runtime._runners.pop(task_id)
        await runner.close()

    # A normal user action retains user identity; a finished turn cannot be reused.
    await main.project_manager.run_db(project_id, lambda _: TaskStep.update(status="failed").where(
        (TaskStep.task == task_id) & (TaskStep.step_key == step_key)
    ).execute())
    source_turn_id = await main.project_manager.run_db(project_id, lambda _: CoordinatorTurn.get(
        CoordinatorTurn.assistant_message == accepted.json()["assistant_message_id"]
    ).id)
    stale = await client.post(f"/api/task/{task_id}/step/{step_key}/resume?project_id={project_id}",
                              headers={"X-WorkStep-Coordinator-Turn": source_turn_id},
                              json={"content": "失效来源不能冒充协调"})
    assert stale.status_code == 409
    assert "来源" in stale.json()["detail"]
    manual = await client.post(f"/api/task/{task_id}/step/{step_key}/resume?project_id={project_id}",
                               json={"content": "人工补充要求"})
    assert manual.status_code == 200, manual.text
    author_type = await main.project_manager.run_db(project_id, lambda _: Message.get_by_id(manual.json()["message_id"]).author_type)
    assert author_type == "user"


def test_coordinator_cli_environment_is_scoped():
    from services.coordinator_source import coordinator_source, coordinator_source_env
    from engines.core.base import ProviderRuntimeConfig

    with coordinator_source("turn-1"):
        assert coordinator_source_env() == {"WORKSTEP_COORDINATOR_TURN_ID": "turn-1"}
        assert ProviderRuntimeConfig().child_env()["WORKSTEP_COORDINATOR_TURN_ID"] == "turn-1"
    assert coordinator_source_env() == {}


@pytest.mark.anyio
async def test_cli_and_native_source_do_not_leak_between_calls(monkeypatch):
    from services.coordinator_source import coordinator_source
    from services.tool_registry import WorkstepClient

    seen = []

    async def transport(request):
        seen.append(request.headers.get("X-WorkStep-Coordinator-Turn"))
        return httpx.Response(200, json={"status": "queued"})

    client = WorkstepClient(base_url="http://test", transport=httpx.MockTransport(transport))
    arguments = {"project_id": "project", "task_id": "task", "step_key": "build",
                 "content": "执行", "confirm": "yes"}
    monkeypatch.setenv("WORKSTEP_COORDINATOR_TURN_ID", "cli-turn")
    await client.call("workstep_start_step", arguments)
    with coordinator_source("native-turn"):
        await client.call("workstep_send_step_message", arguments)
    monkeypatch.delenv("WORKSTEP_COORDINATOR_TURN_ID")
    await client.call("workstep_start_step", arguments)
    assert seen == ["cli-turn", "native-turn", None]
