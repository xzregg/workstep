"""Statistics aggregation and HTTP contract tests."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest
from httpx import ASGITransport, AsyncClient

from models import Message, ReviewRun, StepRun, Task, WorkflowRun
from services.project import ProjectManager
from services.statistics import StatisticsModule, StatisticsQuery


class MemoryConfigStore:
    def __init__(self):
        self.values: dict[str, object] = {}

    def get(self, key, default=None):
        return self.values.get(key, default)

    def set(self, key, value):
        self.values[key] = value

    def get_model_pricing(self):
        return self.values.get("model_pricing", {
            "currency": "USD",
            "usd_to_cny_rate": 7.2,
            "prices": [],
        })


@pytest.fixture
def statistics_fixture(tmp_path, monkeypatch):
    import services.project as project_service

    store = MemoryConfigStore()
    monkeypatch.setattr(project_service, "config_store", store)
    manager = ProjectManager()

    project_a_path = tmp_path / "project-a"
    project_b_path = tmp_path / "project-b"
    project_a_path.mkdir()
    project_b_path.mkdir()
    project_a = manager.init_project(project_a_path)
    project_b = manager.init_project(project_b_path)

    base = datetime(2026, 8, 10, 0, 0, tzinfo=timezone.utc)
    workflow_a = project_a.default_workflow()
    assert workflow_a is not None

    with manager.activate_project_by_id(project_a.id):
        successful_task = Task.create(
            id="task-success",
            title="Successful task",
            cwd=str(project_a_path),
            workflow_id=workflow_a["id"],
            status="ready",
            created_at=base,
            updated_at=base,
        )
        successful_run = WorkflowRun.create(
            id="run-success",
            task=successful_task,
            status="succeeded",
            workflow_schema_version=1,
            workflow_snapshot_json=json.dumps(workflow_a["steps"]),
            started_at=base + timedelta(hours=1),
            ended_at=base + timedelta(hours=1, minutes=10),
        )
        successful_step = StepRun.create(
            id="step-success",
            run=successful_run,
            step_key="requirements",
            attempt=1,
            status="succeeded",
            engine="codex",
            model="gpt-5",
            started_at=base + timedelta(hours=1),
            ended_at=base + timedelta(hours=1, minutes=8),
        )
        ReviewRun.create(
            id="review-success",
            workflow_run=successful_run,
            step_run=successful_step,
            task=successful_task,
            step_key="requirements",
            mode="auto",
            status="passed",
            engine="codex",
            model="gpt-5",
            started_at=base + timedelta(hours=1, minutes=8),
            ended_at=base + timedelta(hours=1, minutes=9),
        )

        failed_task = Task.create(
            id="task-failed",
            title="Failed task",
            cwd=str(project_a_path),
            workflow_id=workflow_a["id"],
            status="stopped",
            archived=1,
            created_at=base + timedelta(hours=2),
            updated_at=base + timedelta(hours=2),
        )
        failed_run = WorkflowRun.create(
            id="run-failed",
            task=failed_task,
            status="failed",
            workflow_schema_version=1,
            workflow_snapshot_json=json.dumps(workflow_a["steps"]),
            started_at=base + timedelta(hours=2),
            ended_at=base + timedelta(hours=2, minutes=5),
        )
        StepRun.create(
            id="step-failed-1",
            run=failed_run,
            step_key="requirements",
            attempt=1,
            status="failed",
            engine="codex",
            model="gpt-5",
            started_at=base + timedelta(hours=2),
            ended_at=base + timedelta(hours=2, minutes=2),
        )
        StepRun.create(
            id="step-failed-2",
            run=failed_run,
            step_key="requirements",
            attempt=2,
            status="failed",
            engine="codex",
            model="gpt-5",
            started_at=base + timedelta(hours=2, minutes=2),
            ended_at=base + timedelta(hours=2, minutes=5),
        )

        def message(
            message_id: str,
            *,
            task: Task,
            channel: str,
            usage: dict | None,
            role: str = "assistant",
            offset_minutes: int = 0,
        ) -> None:
            Message.create(
                id=message_id,
                task=task,
                step_key="requirements",
                channel=channel,
                sequence=None,
                role=role,
                content="",
                engine="codex",
                model="gpt-5",
                run_id=message_id,
                run_status="succeeded",
                usage_json=json.dumps(usage) if usage is not None else None,
                position=1,
                started_at=base + timedelta(hours=1, minutes=offset_minutes),
                ended_at=base + timedelta(hours=1, minutes=offset_minutes + 1),
                created_at=base + timedelta(hours=1, minutes=offset_minutes),
            )

        message(
            "message-execution",
            task=successful_task,
            channel="execution",
            usage={
                "input_tokens": 100,
                "output_tokens": 20,
                "cache_read_input_tokens": 30,
                "cache_creation_input_tokens": 10,
                "total_tokens": 120,
            },
        )
        message(
            "message-review",
            task=successful_task,
            channel="review",
            usage={"input_tokens": 50, "output_tokens": 10},
            offset_minutes=2,
        )
        message(
            "message-coordinator",
            task=successful_task,
            channel="coordinator",
            usage={"input_tokens": 30, "output_tokens": 5},
            offset_minutes=4,
        )
        message(
            "message-context-window",
            task=successful_task,
            channel="execution",
            usage={"usage_kind": "context_window", "used": 1000, "size": 2000},
            offset_minutes=6,
        )
        message(
            "message-user",
            task=successful_task,
            channel="execution",
            usage={"input_tokens": 999, "output_tokens": 999},
            role="user",
            offset_minutes=8,
        )

    workflow_b = project_b.default_workflow()
    assert workflow_b is not None
    with manager.activate_project_by_id(project_b.id):
        old_task = Task.create(
            id="old-task",
            title="Old task",
            cwd=str(project_b_path),
            workflow_id=workflow_b["id"],
            status="ready",
            created_at=base - timedelta(days=60),
            updated_at=base - timedelta(days=60),
        )
        WorkflowRun.create(
            id="old-run",
            task=old_task,
            status="succeeded",
            workflow_schema_version=1,
            workflow_snapshot_json=json.dumps(workflow_b["steps"]),
            started_at=base - timedelta(days=60),
            ended_at=base - timedelta(days=60) + timedelta(minutes=1),
        )

    yield manager, project_a, project_b, base
    manager.close_all()


def test_statistics_aggregates_projects_runs_usage_and_quality(statistics_fixture):
    manager, project_a, _, base = statistics_fixture
    report = StatisticsModule(manager).overview(StatisticsQuery(
        range_key="custom",
        start=base,
        end=base + timedelta(days=1),
        timezone="Asia/Shanghai",
    ))

    summary = report["summary"]
    assert summary["project_count"] == 2
    assert summary["workflow_count"] == 2
    assert summary["task_count"] == 2
    assert summary["run_count"] == 2
    assert summary["succeeded_runs"] == 1
    assert summary["failed_runs"] == 1
    assert summary["success_rate"] == 0.5
    assert summary["average_duration_ms"] == 450_000
    assert summary["input_tokens"] == 180
    assert summary["output_tokens"] == 35
    assert summary["total_tokens"] == 215
    assert summary["cache_read_tokens"] == 30
    assert summary["cache_write_tokens"] == 10
    assert summary["cache_rate"] == 0.1667
    assert summary["token_coverage"] == 0.75
    assert report["quality"]["step_failure_rate"] == 0.6667
    assert report["quality"]["retry_count"] == 1
    assert report["quality"]["review_pass_rate"] == 1.0
    assert report["quality"]["average_review_duration_ms"] == 60_000
    assert report["comparison"]["summary"]["run_count"] == 0
    assert report["comparison"]["changes"]["run_count"] == 2

    assert len(report["projects"]) == 2
    project_row = next(row for row in report["projects"] if row["id"] == project_a.id)
    assert project_row["run_count"] == 2
    assert project_row["total_tokens"] == 215

    assert report["trend"][0]["succeeded_runs"] == 1
    assert report["trend"][0]["failed_runs"] == 1
    assert report["trend"][1]["run_count"] == 0

    engine = report["engines"][0]
    assert engine["engine"] == "codex"
    assert engine["model"] == "gpt-5"
    assert engine["call_count"] == 3
    assert engine["total_tokens"] == 215


def test_statistics_calculates_model_cost_in_configured_currency(
    statistics_fixture,
    monkeypatch,
):
    import services.statistics as statistics_service

    manager, _, _, base = statistics_fixture
    store = MemoryConfigStore()
    store.set("model_pricing", {
        "currency": "CNY",
        "usd_to_cny_rate": 7.18,
        "prices": [{
            "provider_id": None,
            "model": "gpt-5",
            "input_price": 10,
            "output_price": 30,
            "cache_price": 2,
        }],
    })
    monkeypatch.setattr(statistics_service, "config_store", store)

    report = StatisticsModule(manager).overview(StatisticsQuery(
        range_key="custom",
        start=base,
        end=base + timedelta(days=1),
    ))

    assert report["currency"] == "CNY"
    assert report["summary"]["cost"] == 0.00263
    assert report["engines"][0]["cost"] == 0.00263


def test_statistics_prefers_provider_cost_and_converts_usd_to_cny(
    statistics_fixture,
    monkeypatch,
):
    import services.statistics as statistics_service

    manager, project, _, base = statistics_fixture
    store = MemoryConfigStore()
    store.set("model_pricing", {
        "currency": "CNY",
        "usd_to_cny_rate": 7.2,
        "prices": [],
    })
    monkeypatch.setattr(statistics_service, "config_store", store)
    with manager.activate_project_by_id(project.id):
        message = Message.get_by_id("message-execution")
        message.usage_json = json.dumps({
            "input_tokens": 100,
            "output_tokens": 20,
            "cost": {"amount": 1, "currency": "USD"},
        })
        message.save()

    report = StatisticsModule(manager).overview(StatisticsQuery(
        range_key="custom",
        start=base,
        end=base + timedelta(days=1),
    ))

    assert report["summary"]["cost"] == 7.2


def test_statistics_project_and_workflow_drilldown(statistics_fixture):
    manager, project_a, _, base = statistics_fixture
    workflow_id = project_a.default_workflow()["id"]
    module = StatisticsModule(manager)

    project_report = module.overview(StatisticsQuery(
        project_id=project_a.id,
        range_key="custom",
        start=base,
        end=base + timedelta(days=1),
    ))
    assert project_report["scope"]["level"] == "project"
    assert [row["id"] for row in project_report["workflows"]] == [workflow_id]

    workflow_report = module.overview(StatisticsQuery(
        project_id=project_a.id,
        workflow_id=workflow_id,
        range_key="custom",
        start=base,
        end=base + timedelta(days=1),
    ))
    assert workflow_report["scope"]["level"] == "workflow"
    assert workflow_report["summary"]["run_count"] == 2
    assert workflow_report["stages"] == [{
        "step_key": "requirements",
        "name": "requirements",
        "attempt_count": 3,
        "succeeded_attempts": 1,
        "failed_attempts": 2,
        "cancelled_attempts": 0,
        "retry_count": 1,
        "failure_rate": 0.6667,
        "review_passed": 1,
        "review_rejected": 0,
        "review_pass_rate": 1.0,
        "average_duration_ms": 260_000,
        "p95_duration_ms": 450_000,
        "total_tokens": 180,
    }]


def test_statistics_rejects_invalid_scope_and_range(statistics_fixture):
    manager, _, _, base = statistics_fixture
    module = StatisticsModule(manager)

    with pytest.raises(ValueError, match="project_id"):
        module.overview(StatisticsQuery(workflow_id="missing"))
    with pytest.raises(ValueError, match="start.*end"):
        module.overview(StatisticsQuery(
            range_key="custom",
            start=base + timedelta(days=1),
            end=base,
        ))
    with pytest.raises(ValueError, match="timezone"):
        module.overview(StatisticsQuery(timezone="Mars/Olympus"))


@pytest.mark.anyio
async def test_statistics_api_returns_overview(statistics_fixture, monkeypatch):
    import api.statistics as statistics_api
    import main

    manager, project_a, _, base = statistics_fixture
    monkeypatch.setattr(statistics_api, "project_manager", manager)
    transport = ASGITransport(app=main.app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/api/statistics/overview", params={
            "project_id": project_a.id,
            "range": "custom",
            "start": base.isoformat(),
            "end": (base + timedelta(days=1)).isoformat(),
            "timezone": "Asia/Shanghai",
        })
        invalid = await client.get("/api/statistics/overview", params={
            "workflow_id": "orphan",
        })

    assert response.status_code == 200
    assert response.json()["scope"]["level"] == "project"
    assert response.json()["summary"]["run_count"] == 2
    assert invalid.status_code == 422
