"""Manual review completion must refresh the board's persisted completion time."""

from datetime import datetime, timedelta
import json

import pytest

from tests.test_api_contracts import api_context


@pytest.mark.anyio
@pytest.mark.parametrize("decision,later_status,completed", [
    ("complete-task", "pending", True),
    ("set-complete", "passed", True),
    ("set-complete", "pending", False),
])
async def test_review_decision_refreshes_completion_time(
    api_context, decision, later_status, completed,
):
    import main
    from models import ReviewRun, StepRun, Task, TaskStep, WorkflowRun
    from models.fields import utc_now

    client, tmp_path = api_context
    directory = tmp_path / "manual-completion"
    directory.mkdir()
    pid = (await client.post("/api/project/init", json={"path": str(directory)})).json()["id"]
    workflow_response = await client.post(f"/api/workflow/create?project_id={pid}", json={
        "name": "ManualCompletion", "steps": {
            "nodes": [{"id": key, "type": key, "title": key} for key in ("do", "later")],
            "connections": [{"from": "do", "to": "later"}],
        },
    })
    assert workflow_response.status_code == 200, workflow_response.text
    workflow = workflow_response.json()
    task_ids = []
    for title in ("人工完成任务", "此前完成任务"):
        response = await client.post(f"/api/task/create?project_id={pid}", json={
            "title": title, "workflow_id": workflow["id"], "auto_start": False,
        })
        assert response.status_code == 200, response.text
        task_ids.append(response.json()["id"])
    tid, reference_id = task_ids
    old_end = utc_now() - timedelta(hours=2)
    reference_end = old_end + timedelta(hours=1)

    def prepare(_project):
        for identity, status, finish in ((tid, "paused", old_end), (reference_id, "succeeded", reference_end)):
            run_id = f"run-{identity}"
            WorkflowRun.create(id=run_id, task=identity, status=status, workflow_schema_version=1,
                               started_at=old_end - timedelta(hours=1), ended_at=finish)
            Task.update(status="waiting" if identity == tid else "completed", active_workflow_run_id=run_id).where(Task.id == identity).execute()
            TaskStep.update(status="passed", ended_at=finish).where(TaskStep.task == identity).execute()
        TaskStep.update(status="awaiting_review").where((TaskStep.task == tid) & (TaskStep.step_key == "do")).execute()
        TaskStep.update(status=later_status).where((TaskStep.task == tid) & (TaskStep.step_key == "later")).execute()
        step_run = StepRun.create(id="attempt", run=f"run-{tid}", step_key="do", attempt=1,
                                  status="succeeded", started_at=old_end, ended_at=old_end)
        ReviewRun.create(id="review", task=tid, workflow_run=f"run-{tid}", step_run=step_run,
                         step_key="do", mode="manual", status="pending", started_at=old_end)

    await main.project_manager.run_db(pid, prepare)
    before = (await client.get(f"/api/task/list?project_id={pid}")).json()["tasks"]
    bus = main.workflow_runtime._event_bus
    queue = bus.subscribe()
    try:
        response = await client.post(f"/api/task/{tid}/steps/do/review/{decision}?project_id={pid}", json={
            "review_run_id": "review", "schedule_downstream": False,
        })
        assert response.status_code == 200, response.text
        assert response.json()["resumed"] is False
        events = []
        while not queue.empty():
            events.append(queue.get_nowait())
    finally:
        bus.unsubscribe(queue)
    after = (await client.get(f"/api/task/list?project_id={pid}")).json()["tasks"]
    snapshot = next(task for task in after if task["id"] == tid)
    updates = [event for event in events if event.get("name") == "workstep.task_updated"]
    assert len(updates) == int(completed), "only a completed task publishes its authoritative completion refresh"
    if completed:
        assert updates[0]["project_id"] == pid and updates[0]["task_id"] == tid
        assert snapshot["status"] == "completed"
        assert snapshot["completed_at"] > next(task["completed_at"] for task in after if task["id"] == reference_id)
        assert snapshot["completed_at"] != next(task["completed_at"] for task in before if task["id"] == tid)
        ended_at = await main.project_manager.run_db(pid, lambda _p: WorkflowRun.get_by_id(f"run-{tid}").ended_at)
        assert datetime.fromisoformat(snapshot["completed_at"]) == ended_at
    else:
        assert snapshot["status"] == "waiting"
    # Reusable evidence for checking the actual API events against the Web store/render.
    (tmp_path / "completion-evidence.json").write_text(json.dumps({
        "decision": decision, "completed": completed, "project_id": pid, "workflow_id": workflow["id"],
        "task_id": tid, "reference_id": reference_id, "before": before, "events": events, "after": after,
    }, ensure_ascii=False))
