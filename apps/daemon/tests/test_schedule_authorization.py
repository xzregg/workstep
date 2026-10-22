"""Managed hosts must preserve native remote schedule authorization."""

import json
import time
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest


@pytest.mark.anyio
@pytest.mark.parametrize("mode", ["static", "agent"])
@pytest.mark.parametrize("legacy", [False, True])
@pytest.mark.parametrize("access", ["active", "revoked", "expired", "other-project", "disabled"])
async def test_native_remote_schedule_rechecks_project_device_authorization(
    tmp_path, monkeypatch, mode, legacy, access,
):
    import main
    from models import Schedule, Task
    from services.gateway_client.policy import ManagedPolicyCache
    from services.project import DEFAULT_STEPS, ProjectManager
    from services.remote_access import ActorSnapshot, actor_context
    from services.schedule import ScheduleModule
    from services.task import TaskService
    from streaming.bus import EventBus

    manager = ProjectManager()
    project = manager.init_project(tmp_path / "project")
    workflow = await manager.run_db(project.id, lambda p: manager.create_workflow(p, "流程", DEFAULT_STEPS))
    actor = ActorSnapshot("remote-user", "远程用户", "remote-device", "远程电脑", "remote")
    agent = SimpleNamespace()

    async def generate(*args, **kwargs):
        return {"title": "Generated task", "workflow_id": workflow["id"]}

    # Use the same agent seam as the real scheduled task assistant.
    agent.run_schedule = generate
    module = ScheduleModule(manager, TaskService(EventBus()), None, task_agent=agent)
    template = {"title": "Scheduled task"}
    if mode == "agent":
        template = {"mode": "agent", "instruction": "生成任务", "candidate_workflow_ids": [workflow["id"]]}
    with actor_context(actor):
        created = await manager.run_db(project.id, lambda _: module.create(
            project.id, name="定时规则", workflow_id=workflow["id"] if mode == "static" else "",
            task_template=template,
            rule={"kind": "once", "run_at": "2099-01-02T03:04:00", "timezone": "UTC"},
            execution_mode="manual",
        ))
    if legacy:
        def remove_source(_):
            row = Schedule.get_by_id(created["id"])
            saved = json.loads(row.task_template_json)
            saved["_creator"].pop("source", None)
            row.task_template_json = json.dumps(saved)
            row.save()
        await manager.run_db(project.id, remove_source)
    monkeypatch.setattr(main, "gateway_client", SimpleNamespace(managed_config=object(), policy_cache=ManagedPolicyCache()))
    monkeypatch.setattr(main, "remote_access_service", SimpleNamespace(
        settings=lambda: {"enabled": access != "disabled"},
        list_devices=lambda project_id: [{
            "project_id": "another" if access == "other-project" else project.id,
            "device_id": actor.device_id,
            "status": access if access in {"revoked", "expired"} else "active",
        }],
    ))
    await module.tick(datetime(2099, 1, 2, 3, 4, 1, tzinfo=timezone.utc))
    await module.wait_idle()
    runs = await manager.run_db(project.id, lambda _: module.list_runs(project.id, created["id"]))
    run = runs[0]
    if access == "active":
        assert run["status"] == "created", run
        task = await manager.run_db(project.id, lambda _: Task.get_by_id(run["task_id"]))
        assert task.creator_id == actor.actor_id
    else:
        assert run["status"] == "failed", run
        assert run["reason"] == "Managed capability denied: task.create"
        assert await manager.run_db(project.id, lambda _: Task.select().count()) == 0


@pytest.mark.anyio
async def test_schedule_creator_cannot_be_supplied_or_replaced(tmp_path):
    from models import Schedule
    from services.project import DEFAULT_STEPS, ProjectManager
    from services.remote_access import ActorSnapshot, actor_context
    from services.schedule import ScheduleModule

    manager = ProjectManager()
    project = manager.init_project(tmp_path / "project")
    workflow = await manager.run_db(project.id, lambda p: manager.create_workflow(p, "流程", DEFAULT_STEPS))
    module = ScheduleModule(manager, None, None)
    actor = ActorSnapshot("real-user", "用户", "real-device", "电脑", "managed")
    forged = {"id": "forged", "device_id": "authorized-device", "source": "remote"}
    with actor_context(actor):
        created = await manager.run_db(project.id, lambda _: module.create(
            project.id, name="规则", workflow_id=workflow["id"],
            task_template={"title": "任务", "_creator": forged},
            rule={"kind": "daily", "time": "04:00", "timezone": "UTC"},
        ))
    await manager.run_db(project.id, lambda _: module.update(
        project.id, created["id"], task_template={"title": "更新", "_creator": forged},
    ))
    saved = await manager.run_db(project.id, lambda _: json.loads(Schedule.get_by_id(created["id"]).task_template_json))
    assert saved["_creator"]["id"] == actor.actor_id
    assert saved["_creator"]["source"] == "managed"
    assert "_creator" not in created["task_template"]


@pytest.mark.anyio
@pytest.mark.parametrize("source", [None, "managed", "remote"])
@pytest.mark.parametrize("policy_state", ["allowed", "denied", "expired", "other-user"])
async def test_scheduled_creation_does_not_borrow_actor_or_confuse_authorities(monkeypatch, source, policy_state):
    import main
    from services.gateway_client.policy import ManagedPolicy, ManagedPolicyCache
    from services.remote_access import ActorSnapshot, actor_context
    from services.task_creation import _require_scheduled_creation

    now = int(time.time())
    cache = ManagedPolicyCache()
    cache.apply(ManagedPolicy(
        "gateway", "device", "other" if policy_state == "other-user" else "owner", 1, now,
        now - 1 if policy_state == "expired" else now + 600,
        frozenset(), frozenset(), False, policy_state != "denied", False, False, False,
    ))
    monkeypatch.setattr(main, "gateway_client", SimpleNamespace(managed_config=object(), policy_cache=cache))
    monkeypatch.setattr(main, "remote_access_service", SimpleNamespace(
        settings=lambda: {"enabled": True},
        list_devices=lambda project_id: [{"project_id": project_id, "device_id": "device", "status": "revoked"}],
    ))
    fields = {"creator_id": "owner", "creator_device_id": "device"}
    # An unrelated privileged poller must never replace the saved creator.
    with actor_context(ActorSnapshot("other", "Poller", "device", "PC", "managed")):
        if source == "managed" and policy_state == "allowed":
            await _require_scheduled_creation("project", fields, source)
        else:
            with pytest.raises(PermissionError, match="Managed capability denied"):
                await _require_scheduled_creation("project", fields, source)
