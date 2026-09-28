"""Persist a child workflow run when execution restarts from one step."""

import json
import uuid
from pathlib import Path

from models import Message, ReviewRun, StepRun, Task, TaskStep, WorkflowRun
from models.base import db_proxy
from models.fields import utc_now
from services.artifact_rounds import iter_artifact_rounds
from services.artifact_routing import (
    empty_routing_state, source_for_connection,
)
from services.pipeline import DAGScheduler, Step
from services.messages import current_actor_message_fields
from services.step_message_restart import inspect_failed_message_retry
from services.workflow_definition import WorkflowDefinition


def validate_restart_input_rounds(
    project, task: Task, step_key: str,
    input_rounds: dict[str, int] | None, *, current_workflow_steps,
) -> dict[str, dict]:
    """Validate explicit upstream artifact rounds inside the project worker."""
    if not input_rounds:
        return {}
    workflow_data = current_workflow_steps(project, task)
    steps_config = WorkflowDefinition.load(workflow_data).compile().to_steps_config()
    step_list = [Step.from_dict(item) for item in steps_config["steps"]]
    scheduler = DAGScheduler(step_list)
    if step_key not in scheduler.steps:
        raise ValueError(f"Step does not exist: {step_key}")
    dependencies = set(scheduler.steps[step_key].depends_on)
    feedback_connections = {}
    for connection in scheduler.steps[step_key].incoming_connections:
        if connection.get("kind") == "dashed":
            feedback_connections.setdefault(str(connection.get("from")), []).append(
                connection
            )
    artifacts_root = Path(project.workstep_dir) / "artifacts"
    feedback_inputs: dict[str, dict] = {}
    for dep_key, requested_round in input_rounds.items():
        if dep_key not in dependencies and dep_key not in feedback_connections:
            raise ValueError(
                f"产物轮次 {dep_key} 不是目标步骤 {step_key} 的输入来源"
            )
        rounds = iter_artifact_rounds(
            artifacts_root, task.workflow_id, task.id, dep_key,
        )
        selected = next(
            (item for item in rounds if item.round == int(requested_round)),
            None,
        )
        if selected is None or not selected.eligible_for_downstream:
            raise ValueError(
                f"产物轮次 {dep_key} 第 {requested_round} 轮不可沿用"
            )
        if dep_key in feedback_connections:
            for connection in feedback_connections[dep_key]:
                source = source_for_connection(
                    connection, selected, connection.get("output")
                )
                if source is not None:
                    feedback_inputs[str(connection.get("id"))] = source
            if not any(
                str(connection.get("id")) in feedback_inputs
                for connection in feedback_connections[dep_key]
            ):
                raise ValueError(
                    f"产物轮次 {dep_key} 第 {requested_round} 轮没有可用的返工产物"
                )
    return feedback_inputs


def inspect_restart_run(
    project, task_id: str, step_key: str, *,
    input_rounds: dict[str, int] | None,
    expected_run_id: str | None,
    expected_failed_message_id: str | None,
    active_runner: bool,
    current_workflow_steps,
) -> dict:
    """Read the current DAG and validate a restart before stopping the runner."""
    task = Task.get_or_none(Task.id == task_id)
    if task is None:
        raise ValueError(f"Task not found: {task_id}")
    feedback_inputs = validate_restart_input_rounds(
        project, task, step_key, input_rounds,
        current_workflow_steps=current_workflow_steps,
    )
    parent_run_id = expected_run_id or task.active_workflow_run_id
    if not parent_run_id:
        return {"without_parent": True, "feedback_inputs": feedback_inputs}
    parent = WorkflowRun.get_or_none(
        (WorkflowRun.id == parent_run_id) & (WorkflowRun.task == task)
    )
    if parent is None:
        raise RuntimeError("The referenced workflow run no longer exists")
    if expected_run_id and task.active_workflow_run_id != expected_run_id:
        raise RuntimeError("The active workflow run has changed")
    if expected_failed_message_id:
        retry_step_key, retry_run_id = inspect_failed_message_retry(
            task_id, expected_failed_message_id, active_runner,
        )
        if retry_step_key != step_key or retry_run_id != parent_run_id:
            raise ValueError("失败消息已不属于当前阶段")
    workflow_data = current_workflow_steps(project, task)
    compiled = WorkflowDefinition.load(workflow_data).compile()
    steps_config = compiled.to_steps_config()
    step_list = [Step.from_dict(item) for item in steps_config["steps"]]
    scheduler = DAGScheduler(step_list)
    if step_key not in scheduler.steps:
        raise ValueError(f"Step does not exist: {step_key}")
    affected = {step_key, *scheduler.get_all_downstream(step_key)}
    return {
        "without_parent": False,
        "parent_run_id": parent_run_id,
        "compiled": compiled,
        "steps_config": steps_config,
        "affected": affected,
        "feedback_inputs": feedback_inputs,
    }


def create_restart_run(
    task: Task,
    parent: WorkflowRun,
    schema_version: int,
    step_key: str,
    execution_keys: set[str],
    *,
    instance_id: str,
    reset_session_step_key: str | None = None,
    feedback_inputs: dict[str, dict] | None = None,
) -> tuple[Task, WorkflowRun]:
    """Replace a run atomically inside the selected project's DB executor."""
    now = utc_now()
    actor_fields = current_actor_message_fields()
    with db_proxy.atomic():
        parent.status = "superseded"
        parent.ended_at = parent.ended_at or now
        parent.save()
        StepRun.update(
            status="cancelled",
            ended_at=now,
        ).where(
            (StepRun.run == parent)
            & (StepRun.status == "running")
        ).execute()
        ReviewRun.update(
            status="cancelled",
            ended_at=now,
            error="流程运行已被新的入口替代",
        ).where(
            (ReviewRun.workflow_run == parent)
            & (ReviewRun.status.in_(["pending", "running"]))
        ).execute()
        # A review can be interrupted after its StepRun has succeeded.
        # Close both bubbles from this parent run before launching the
        # replacement; otherwise their old "running" state survives.
        from services.history import project_terminal_message_state

        parent_step_run_ids = [
            row.id for row in StepRun.select(StepRun.id).where(StepRun.run == parent)
        ]
        if parent_step_run_ids:
            stale_messages = Message.select().where(
                (Message.task == task)
                & (Message.step_run_id.in_(parent_step_run_ids))
                & (Message.role == "assistant")
                & (Message.channel.in_(["execution", "review"]))
                & (Message.run_status == "running")
            )
            for message in stale_messages:
                projection = {}
                project_terminal_message_state(projection, message)
                if projection.get("run_status"):
                    message.run_status = projection["run_status"]
                    message.ended_at = projection["ended_at"] or now
                    message.save(only=[Message.run_status, Message.ended_at])
        routing_state = empty_routing_state()
        routing_state["entry_step_key"] = step_key
        routing_state["execution_scope"] = sorted(execution_keys)
        if feedback_inputs:
            routing_state["feedback_inputs"][step_key] = feedback_inputs
            routing_state["active_edges"] = sorted(feedback_inputs)
        child = WorkflowRun.create(
            id=str(uuid.uuid4()),
            task=task,
            status="running",
            workflow_schema_version=schema_version,
            workflow_snapshot_json="{}",
            parent_run_id=parent.id,
            restart_from_step_key=step_key,
            routing_state_json=json.dumps(routing_state, ensure_ascii=False),
            owner_id=instance_id,
            heartbeat_at=now,
            initiated_by_user_id=(
                actor_fields.get("initiated_by_user_id") or parent.initiated_by_user_id
            ),
            initiated_by_username=(
                actor_fields.get("initiated_by_username") or parent.initiated_by_username
            ),
            initiated_by_name=(
                actor_fields.get("author_name") or parent.initiated_by_name
            ),
            initiated_by_device_id=(
                actor_fields.get("author_device_id") or parent.initiated_by_device_id
            ),
            initiated_by_device_name=(
                actor_fields.get("author_device_name") or parent.initiated_by_device_name
            ),
            started_at=now,
        )
        reusable = {
            row.step_key
            for row in TaskStep.select().where(
                (TaskStep.task == task)
                & (TaskStep.status == "passed")
                & (~(TaskStep.step_key.in_(execution_keys)))
            )
        }
        for reusable_key in reusable:
            source = (
                StepRun.select()
                .where(
                    (StepRun.run == parent)
                    & (StepRun.step_key == reusable_key)
                    & (StepRun.status.in_(["succeeded", "reused"]))
                )
                .order_by(StepRun.attempt.desc())
                .first()
            )
            if source is None:
                continue
            StepRun.create(
                id=str(uuid.uuid4()),
                run=child,
                step_key=reusable_key,
                attempt=1,
                artifact_round=source.artifact_round,
                status="reused",
                engine=source.engine,
                model=source.model,
                source_step_run_id=source.id,
                started_at=now,
                ended_at=now,
            )
        TaskStep.update(
            status="pending",
            started_at=None,
            ended_at=None,
            error=None,
        ).where(
            (TaskStep.task == task)
            & (TaskStep.step_key.in_(execution_keys))
        ).execute()
        if reset_session_step_key:
            TaskStep.update(
                session_id=None,
                session_provider=None,
                pending_handoff_json=None,
            ).where(
                (TaskStep.task == task)
                & (TaskStep.step_key == reset_session_step_key)
            ).execute()
        TaskStep.update(
            status="cancelled",
            ended_at=now,
            error="已切换到其他流程入口",
        ).where(
            (TaskStep.task == task)
            & (~(TaskStep.step_key.in_(execution_keys)))
            & (TaskStep.status.in_([
                "running", "reviewing", "awaiting_review", "retrying",
                "rework", "rework_waiting",
            ]))
        ).execute()
        task.status = "running"
        task.active_workflow_run_id = child.id
        task.state_version += 1
        task.updated_at = now
        task.save()
    return task, child
