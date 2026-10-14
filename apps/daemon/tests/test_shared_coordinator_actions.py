import asyncio
import base64
import json
import threading
import time

import pytest

from services.gateway_client.bridge import ManagedHttpBridge
from tests.test_api_contracts import api_context
from tests.test_coordinator import _create_task
from tests.test_gateway_share_ticket import _ticket
from workstep_gateway_protocol import FrameType, ProxyFrame


@pytest.mark.anyio
async def test_share_proposals_confirm_cancel_and_recheck_task_scope_without_blocking(api_context, monkeypatch):
    import main
    from models import ActionProposal, CoordinatorTurn, Message, StepSupplement, Task
    from models.fields import utc_now
    from agent_assistants.coordinator_actions import CoordinatorActionService

    client, tmp_path = api_context
    project_id, task_id = await _create_task(client, tmp_path)
    actions = CoordinatorActionService(main.project_manager, main.workflow_runtime)
    monkeypatch.setattr(main, "coordinator_module", actions)

    def seed(_project):
        task = Task.get_by_id(task_id)
        now = utc_now()
        user = Message.create(id="share-user", task=task, step_key="coordinator", channel="coordinator", role="user", content="test", position=0, sequence=1, created_at=now)
        assistant = Message.create(id="share-assistant", task=task, step_key="coordinator", channel="coordinator", role="assistant", content="test", position=1, sequence=2, created_at=now)
        turn = CoordinatorTurn.create(id="share-turn", task=task, user_message=user,
                                     assistant_message=assistant, idempotency_key="turn", created_at=now)
        for name, kind in (("confirm", "supplement_step"), ("cancel", "rerun_from_step"), ("legacy", "rerun_from_step"), ("workflow", "create_workflow_action"), ("workflow-legacy", "create_workflow_action")):
            ActionProposal.create(id=f"proposal-{name}", task=task, source_turn=turn,
                source_message=assistant, type=kind, target_step_key="req",
                payload_json=json.dumps({"content": "shared guidance"}), expected_task_version=task.state_version,
                created_at=now, updated_at=now)

    await main.project_manager.run_db(project_id, seed)

    async def post(name, action, mode="interactive", target_task=None, body=None):
        ticket, key, fingerprint = _ticket(task_id=target_task or task_id, host_project_id=project_id, mode=mode)
        frames = []
        async def capture(frame):
            frames.append(frame)
        bridge = ManagedHttpBridge(main.app, "share-action", {
            "method": "POST", "path": f"/api/platform-share/actions/proposal-{name}/{action}",
            "query": "", "headers": [["content-type", "application/json"]], "share_ticket": ticket,
        }, capture, "device-1", gateway_key=key, gateway_fingerprint=fingerprint, gateway_id="gateway-1")
        bridge.start_task()
        if body is not None:
            await bridge.feed(ProxyFrame(stream_id="share-action", type=FrameType.http_request,
                payload={"phase": "body", "data": base64.b64encode(json.dumps(body).encode()).decode()}))
        await bridge.feed(ProxyFrame(stream_id="share-action", type=FrameType.http_request, payload={"phase": "end"}))
        await asyncio.wait_for(bridge._task, 3)
        raw = b"".join(base64.b64decode(frame.payload["data"]) for frame in frames if frame.payload.get("phase") == "body")
        return frames[0].payload["status"], json.loads(raw) if raw else None

    monkeypatch.setattr(main.gateway_client, "managed_config", object())
    body = {"idempotency_key": "share-confirm"}
    assert (await post("confirm", "confirm", mode="read_only", body=body))[0] == 403
    assert (await post("confirm", "confirm", target_task="another-task", body=body))[0] == 404
    assert (await post("workflow", "cancel"))[1]["status"] == "cancelled"
    assert (await post("confirm", "confirm", body={"idempotency_key": " "}))[0] == 422
    entered = threading.Event()
    original_get = ActionProposal.get_or_none
    def slow_get(*args, **kwargs):
        entered.set()
        time.sleep(0.3)
        return original_get(*args, **kwargs)
    monkeypatch.setattr(ActionProposal, "get_or_none", slow_get)
    pending = asyncio.create_task(post("confirm", "confirm", body=body))
    assert await asyncio.to_thread(entered.wait, 2)
    started = time.monotonic()
    assert (await client.get("/api/health")).status_code == 200
    assert time.monotonic() - started < 0.2
    code, confirmed = await pending
    assert code == 200 and confirmed["status"] == "succeeded"
    assert (await post("confirm", "confirm", body=body))[1]["status"] == "succeeded"
    assert await main.project_manager.run_db(project_id, lambda _: StepSupplement.select().count()) == 1
    assert (await post("cancel", "cancel"))[1]["status"] == "cancelled"
    monkeypatch.setattr(main.gateway_client, "managed_config", None)
    import services.project as project_service
    monkeypatch.setattr(project_service, "project_manager", main.project_manager)
    created = await client.post(f"/api/task-share/{task_id}/create?project_id={project_id}", json={"mode": "interactive"})
    assert created.status_code == 200, created.text
    token = created.json()["token"]
    unlocked = await client.post(f"/api/task-share/public/{token}/unlock", json={"password": ""})
    assert unlocked.status_code == 200, unlocked.text
    headers = {"X-Share-Session": unlocked.json()["session_token"]}
    base = f"/api/task-share/public/{token}/actions"
    confirmed = await client.post(base + "/proposal-confirm/confirm", json=body, headers=headers)
    assert confirmed.status_code == 200 and confirmed.json()["status"] == "succeeded"
    cancelled = await client.post(base + "/proposal-legacy/cancel", headers=headers)
    assert cancelled.status_code == 200 and cancelled.json()["status"] == "cancelled"
    assert (await client.post(base + "/proposal-workflow-legacy/cancel", headers=headers)).json()["status"] == "cancelled"
