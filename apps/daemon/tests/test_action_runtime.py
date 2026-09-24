"""API-level regression for shortcut script execution."""

import asyncio
import json
import threading
import time

import pytest
from httpx import ASGITransport, AsyncClient

import main
from models import ChatMessage, ChatSession, ProjectSetting, Task, Workflow
from models.fields import utc_now
from services.project import ProjectManager
from services.task import TaskService


@pytest.fixture
async def action_client(tmp_path, monkeypatch):
    manager = ProjectManager()
    project = manager.init_project(tmp_path / "project")
    monkeypatch.setattr(main, "project_manager", manager)
    monkeypatch.setattr(main, "task_service", TaskService(main.event_bus))
    workflow = await manager.run_db(project.id, lambda proj: manager.create_workflow(
        proj, name="研发流程", steps={"nodes": [{"id": "stage-1", "key": "build"}], "connections": [], "inheritProjectQuickButtons": True},
    ))
    def seed(_project):
        Task.create(
            id="task-action", title="重启服务", cwd=str(project.path),
            workflow_id=workflow["id"], status="ready", created_at=utc_now(), updated_at=utc_now(),
        )
        ProjectSetting.create(
            id="action-buttons", project_id=project.id, key="chat_quick_buttons",
            value_json='[{"id":"restart","kind":"action","label":"重启服务","prompt":"","action_id":"restart","script_path":"restart.sh","cwd_mode":"task","require_confirmation":true}]',
            updated_at=utc_now(),
        )
    await manager.run_db(project.id, seed)
    action_dir = project.workstep_dir / "actions" / "restart"
    action_dir.mkdir(parents=True)
    (action_dir / "restart.sh").write_text("#!/bin/sh\necho started\nsleep 0.3\necho finished\n")
    async with AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test") as client:
        yield client, manager, project
    from services.action_runtime import action_runtime
    if action_runtime.tasks:
        await asyncio.wait_for(asyncio.gather(*list(action_runtime.tasks.values())), timeout=3)


@pytest.mark.anyio
async def test_action_confirm_deduplicate_and_stream(action_client):
    client, _manager, project = action_client
    url = f"/api/tasks/task-action/actions/run?project_id={project.id}"
    body = {"button_id": "restart", "source": "project"}
    denied = await client.post(url, json=body)
    assert denied.status_code == 409
    first = await client.post(url, json={**body, "confirmed": True})
    assert first.status_code == 200, first.text
    second = await client.post(url, json={**body, "confirmed": True})
    assert second.json()["run_id"] == first.json()["run_id"]
    assert second.json()["deduplicated"] is True
    for _ in range(40):
        current = await client.get(f"/api/action-runs/{first.json()['run_id']}?project_id={project.id}")
        if current.json()["status"] == "succeeded":
            break
        await asyncio.sleep(0.05)
    assert current.json()["status"] == "succeeded"
    assert "started" in current.json()["output"]
    assert "finished" in current.json()["output"]
    history = await client.get(f"/api/task/task-action/history?project_id={project.id}")
    assert [item["channel"] for item in history.json()["messages"]] == ["action", "action"]


@pytest.mark.anyio
async def test_concurrent_action_requests_claim_one_run(action_client):
    client, _manager, project = action_client
    url = f"/api/tasks/task-action/actions/run?project_id={project.id}"
    body = {"button_id": "restart", "source": "project", "confirmed": True}
    responses = await asyncio.gather(*(client.post(url, json=body) for _ in range(6)))
    assert all(response.status_code == 200 for response in responses)
    assert len({response.json()["run_id"] for response in responses}) == 1
    assert sum(not response.json()["deduplicated"] for response in responses) == 1


@pytest.mark.anyio
async def test_slow_action_log_write_does_not_block_health(action_client, monkeypatch):
    from services import action_runtime as runtime_module

    client, _manager, project = action_client
    entered = threading.Event()
    original = runtime_module._append_log

    def slow_append(path, value):
        entered.set()
        time.sleep(0.8)
        original(path, value)

    monkeypatch.setattr(runtime_module, "_append_log", slow_append)
    response = await client.post(
        f"/api/tasks/task-action/actions/run?project_id={project.id}",
        json={"button_id": "restart", "source": "project", "confirmed": True},
    )
    assert response.status_code == 200
    assert await asyncio.to_thread(entered.wait, 2)
    before = time.monotonic()
    health = await client.get("/api/health")
    assert health.status_code == 200
    assert time.monotonic() - before < 0.5


@pytest.mark.anyio
async def test_action_rejects_outside_script(action_client):
    client, manager, project = action_client
    def change(_project):
        row = ProjectSetting.get(ProjectSetting.key == "chat_quick_buttons")
        row.value_json = row.value_json.replace("restart.sh", "outside.sh")
        row.save()
    await manager.run_db(project.id, change)
    response = await client.post(
        f"/api/tasks/task-action/actions/run?project_id={project.id}",
        json={"button_id": "restart", "source": "project", "confirmed": True},
    )
    assert response.status_code == 400


@pytest.mark.anyio
async def test_action_rejects_symlink_escaping_action_root(action_client):
    client, _manager, project = action_client
    outside = project.workstep_dir / "outside.sh"
    outside.write_text("#!/bin/sh\necho escaped\n")
    action_dir = project.workstep_dir / "actions" / "restart"
    (action_dir / "restart.sh").unlink()
    (action_dir / "restart.sh").symlink_to(outside)
    response = await client.post(
        f"/api/tasks/task-action/actions/run?project_id={project.id}",
        json={"button_id": "restart", "source": "project", "confirmed": True},
    )
    assert response.status_code == 400


@pytest.mark.anyio
async def test_workflow_does_not_inherit_project_buttons_by_default(action_client):
    client, manager, project = action_client

    def remove_inheritance_setting(_project):
        workflow = Workflow.get_by_id(project.workflows[0]["id"])
        steps = json.loads(workflow.steps_json)
        steps.pop("inheritProjectQuickButtons")
        workflow.steps_json = json.dumps(steps)
        workflow.save()

    await manager.run_db(project.id, remove_inheritance_setting)
    response = await client.get(f"/api/tasks/task-action/actions?project_id={project.id}&step_key=build")
    assert response.status_code == 200
    assert response.json()["buttons"] == []


@pytest.mark.anyio
async def test_workflow_selects_individual_project_buttons(action_client):
    client, manager, project = action_client

    def configure(_project):
        setting = ProjectSetting.get(ProjectSetting.key == "chat_quick_buttons")
        buttons = json.loads(setting.value_json)
        buttons.append({"id": "docs", "kind": "prompt", "label": "文档", "prompt": "打开文档"})
        setting.value_json = json.dumps(buttons)
        setting.save()
        workflow = Workflow.get_by_id(project.workflows[0]["id"])
        steps = json.loads(workflow.steps_json)
        steps["projectQuickButtonIds"] = ["docs"]
        workflow.steps_json = json.dumps(steps)
        workflow.save()

    await manager.run_db(project.id, configure)
    response = await client.get(f"/api/tasks/task-action/actions?project_id={project.id}&step_key=build")
    assert response.status_code == 200
    assert [button["id"] for button in response.json()["buttons"]] == ["docs"]
    denied = await client.post(
        f"/api/tasks/task-action/actions/run?project_id={project.id}",
        json={"button_id": "restart", "source": "project", "confirmed": True},
    )
    assert denied.status_code == 404


@pytest.mark.anyio
async def test_workflow_level_action_is_available_to_task(action_client):
    client, manager, project = action_client
    workflow_id = project.workflows[0]["id"]

    def configure(_project):
        workflow = Workflow.get_by_id(workflow_id)
        steps = json.loads(workflow.steps_json)
        steps["projectQuickButtonIds"] = []
        steps["quickButtons"] = [{
            "id": "workflow-restart", "kind": "action", "label": "流程重启",
            "action_id": "workflow-restart", "script_path": "restart.sh",
            "require_confirmation": False,
        }]
        workflow.steps_json = json.dumps(steps)
        workflow.save()

    await manager.run_db(project.id, configure)
    script_dir = project.workstep_dir / "artifacts" / workflow_id / "actions" / "workflow-restart"
    script_dir.mkdir(parents=True)
    (script_dir / "restart.sh").write_text("#!/bin/sh\necho workflow-action\n")
    listing = await client.get(f"/api/tasks/task-action/actions?project_id={project.id}&step_key=build")
    assert [(button["id"], button["source"]) for button in listing.json()["buttons"]] == [
        ("workflow-restart", "workflow"),
    ]
    response = await client.post(
        f"/api/tasks/task-action/actions/run?project_id={project.id}",
        json={"button_id": "workflow-restart", "source": "workflow"},
    )
    assert response.status_code == 200, response.text


@pytest.mark.anyio
async def test_existing_task_sees_stage_button_added_to_workflow(action_client):
    client, manager, project = action_client

    def add_stage_button(_project):
        workflow = Workflow.get_by_id(project.workflows[0]["id"])
        steps = json.loads(workflow.steps_json)
        steps["nodes"][0]["quickButtons"] = [{
            "id": "review", "kind": "prompt", "label": "评审", "prompt": "请评审代码",
        }]
        workflow.steps_json = json.dumps(steps)
        workflow.save()

    await manager.run_db(project.id, add_stage_button)
    response = await client.get(f"/api/tasks/task-action/actions?project_id={project.id}&step_key=build")
    assert response.status_code == 200
    assert ("review", "stage") in [
        (button["id"], button["source"]) for button in response.json()["buttons"]
    ]


@pytest.mark.anyio
async def test_stop_action_releases_active_button(action_client):
    client, _manager, project = action_client
    action_dir = project.workstep_dir / "actions" / "restart"
    (action_dir / "restart.sh").write_text("#!/bin/sh\necho ready\nexec sleep 10\n")
    url = f"/api/tasks/task-action/actions/run?project_id={project.id}"
    first = await client.post(url, json={"button_id": "restart", "source": "project", "confirmed": True})
    run_id = first.json()["run_id"]
    stopped = await client.post(f"/api/action-runs/{run_id}/stop?project_id={project.id}")
    assert stopped.status_code == 200
    for _ in range(40):
        current = await client.get(f"/api/action-runs/{run_id}?project_id={project.id}")
        if current.json()["status"] == "stopped":
            break
        await asyncio.sleep(0.05)
    assert current.json()["status"] == "stopped", current.json()
    second = await client.post(url, json={"button_id": "restart", "source": "project", "confirmed": True})
    assert second.status_code == 200
    assert second.json()["run_id"] != run_id
    await client.post(f"/api/action-runs/{second.json()['run_id']}/stop?project_id={project.id}")


@pytest.mark.anyio
async def test_project_chat_action_is_session_scoped(action_client):
    client, manager, project = action_client
    def seed(_project):
        ChatSession.create(
            id="chat-action", project_id=project.id, workflow_id=project.workflows[0]["id"],
            engine="claude", title="测试聊天", created_at=utc_now(), updated_at=utc_now(),
        )
    await manager.run_db(project.id, seed)
    response = await client.post(
        f"/api/project-actions/sessions/chat-action/run?project_id={project.id}",
        json={"button_id": "restart", "confirmed": True},
    )
    assert response.status_code == 200, response.text
    run_id = response.json()["run_id"]
    duplicate = await client.post(
        f"/api/project-actions/sessions/chat-action/run?project_id={project.id}",
        json={"button_id": "restart", "confirmed": True},
    )
    assert duplicate.json()["run_id"] == run_id
    listing = await client.get(f"/api/project-actions/sessions/chat-action?project_id={project.id}")
    assert listing.json()["runs"][0]["session_id"] == "chat-action"
    def load_messages(_project):
        return [(row.role, row.status, row.engine) for row in ChatMessage.select().where(ChatMessage.session == "chat-action")]
    messages = await manager.run_db(project.id, load_messages)
    assert any(role == "assistant" and status.startswith("action_") and engine == "action"
               for role, status, engine in messages)
