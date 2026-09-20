"""Per-task execution analysis report tests."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest

from models import Message, ReviewRun, StepRun, Task, WorkflowRun
from services.project import DEFAULT_STEPS, ProjectManager
from services.task_execution_report import build_task_execution_report


@pytest.fixture
def execution_report_fixture(tmp_path):
    manager = ProjectManager()
    project_path = tmp_path / "project"
    project_path.mkdir()
    project = manager.init_project(project_path)
    workflow = manager.create_workflow(project, "研发流程", DEFAULT_STEPS)
    base = datetime(2026, 9, 20, 2, 0, tzinfo=timezone.utc)

    with manager.activate_project_by_id(project.id):
        task = Task.create(
            id="task-analysis",
            title="实现登录",
            cwd=str(project_path),
            workflow_id=workflow["id"],
            status="stopped",
            created_at=base,
            updated_at=base + timedelta(minutes=18),
        )
        first_run = WorkflowRun.create(
            id="run-1",
            task=task,
            status="superseded",
            workflow_schema_version=1,
            workflow_snapshot_json=json.dumps(DEFAULT_STEPS),
            started_at=base,
            ended_at=base + timedelta(minutes=11),
        )
        req_run = StepRun.create(
            id="step-req",
            run=first_run,
            step_key="req",
            attempt=1,
            status="succeeded",
            engine="claude",
            model="sonnet",
            started_at=base,
            ended_at=base + timedelta(minutes=3),
        )
        frontend_run = StepRun.create(
            id="step-frontend-1",
            run=first_run,
            step_key="frontend",
            attempt=1,
            status="succeeded",
            engine="codex",
            model="gpt-5",
            started_at=base + timedelta(minutes=3),
            ended_at=base + timedelta(minutes=10),
        )
        ReviewRun.create(
            id="review-frontend-1",
            workflow_run=first_run,
            step_run=frontend_run,
            task=task,
            step_key="frontend",
            attempt=1,
            mode="auto",
            status="rejected",
            engine="claude",
            model="sonnet",
            started_at=base + timedelta(minutes=10),
            ended_at=base + timedelta(minutes=11),
        )
        second_run = WorkflowRun.create(
            id="run-2",
            task=task,
            status="succeeded",
            workflow_schema_version=1,
            workflow_snapshot_json=json.dumps(DEFAULT_STEPS),
            parent_run_id=first_run.id,
            restart_from_step_key="frontend",
            started_at=base + timedelta(minutes=12),
            ended_at=base + timedelta(minutes=18),
        )
        StepRun.create(
            id="step-frontend-2",
            run=second_run,
            step_key="frontend",
            attempt=1,
            status="succeeded",
            engine="codex",
            model="gpt-5",
            started_at=base + timedelta(minutes=12),
            ended_at=base + timedelta(minutes=18),
        )

        def message(
            message_id: str,
            *,
            step_key: str,
            channel: str,
            started_at: datetime,
            usage: dict,
            engine: str,
            model: str,
        ) -> None:
            Message.create(
                id=message_id,
                task=task,
                step_key=step_key,
                channel=channel,
                role="assistant",
                content="done",
                engine=engine,
                model=model,
                run_id=message_id,
                run_status="succeeded",
                usage_json=json.dumps(usage),
                position=1,
                started_at=started_at,
                ended_at=started_at + timedelta(seconds=30),
                created_at=started_at,
            )

        message(
            "message-req",
            step_key="req",
            channel="execution",
            started_at=base + timedelta(minutes=1),
            usage={
                "input_tokens": 60,
                "output_tokens": 40,
                "total_tokens": 100,
                "cost": {"amount": 0.01, "currency": "USD"},
            },
            engine="claude",
            model="sonnet",
        )
        message(
            "message-frontend-1",
            step_key="frontend",
            channel="execution",
            started_at=base + timedelta(minutes=4),
            usage={"input_tokens": 100, "output_tokens": 100, "total_tokens": 200},
            engine="codex",
            model="gpt-5",
        )
        message(
            "message-review",
            step_key="frontend",
            channel="review",
            started_at=base + timedelta(minutes=10, seconds=10),
            usage={
                "input_tokens": 30,
                "output_tokens": 20,
                "total_tokens": 50,
                "cost": {"amount": 0.005, "currency": "USD"},
            },
            engine="claude",
            model="sonnet",
        )
        message(
            "message-frontend-2",
            step_key="frontend",
            channel="execution",
            started_at=base + timedelta(minutes=13),
            usage={
                "input_tokens": 200,
                "output_tokens": 100,
                "total_tokens": 300,
                "cost": {"amount": 0.03, "currency": "USD"},
            },
            engine="codex",
            model="gpt-5",
        )

        pricing = {
            "currency": "USD",
            "usd_to_cny_rate": 7.2,
            "prices": [{
                "provider_id": None,
                "engine_id": "codex",
                "model": "gpt-5",
                "input_price": 1,
                "output_price": 2,
                "cache_price": 0,
            }],
        }
        report = build_task_execution_report(task.id, pricing=pricing, now=base + timedelta(minutes=20))

    yield project, report
    manager.close_all()


def test_execution_report_groups_rounds_segments_usage_and_milestones(execution_report_fixture):
    _, report = execution_report_fixture

    assert report["currency"] == "USD"
    assert report["summary"] == pytest.approx({
        "duration_ms": 18 * 60 * 1000,
        "total_tokens": 650,
        "cost": 0.0453,
        "provider_cost": 0.045,
        "estimated_cost": 0.0003,
        "usage_coverage": 1.0,
        "run_count": 2,
        "attempt_count": 3,
        "retry_count": 1,
    })
    assert [(row["id"], row["round"]) for row in report["runs"]] == [
        ("run-1", 1),
        ("run-2", 2),
    ]
    assert [segment["type"] for segment in report["segments"]] == [
        "execution", "execution", "review", "execution",
    ]
    assert report["segments"][1]["total_tokens"] == 200
    assert report["segments"][1]["cost_source"] == "estimated"
    assert report["segments"][2]["status"] == "rejected"
    assert report["segments"][3]["round"] == 2
    assert report["stage_breakdown"][0]["step_key"] == "frontend"
    assert report["stage_breakdown"][0]["total_tokens"] == 550
    assert report["milestones"][0]["kind"] == "task_completed"
    assert report["milestones"][0]["at"] == "2026-09-20T02:18:00+00:00"


def test_execution_report_returns_none_for_unknown_task(tmp_path):
    manager = ProjectManager()
    project_path = tmp_path / "missing"
    project_path.mkdir()
    project = manager.init_project(project_path)
    with manager.activate_project_by_id(project.id):
        assert build_task_execution_report("missing", pricing={"currency": "USD", "prices": []}) is None
    manager.close_all()
