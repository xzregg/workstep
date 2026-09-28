"""Prepare persistent workflow runs inside the owning project's DB thread."""

import json
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from models import Message, StepRun, Task, TaskStep, WorkflowRun
from models.base import db_proxy
from models.fields import utc_now
from services.artifact_routing import empty_routing_state, normalize_routing_state
from services.messages import (
    create_task_message, current_actor_message_fields, new_message_id,
)
from services.pipeline import DAGScheduler, Step
from services.workflow_definition import WorkflowDefinition
from services.workflow_recovery import heal_task_cwd


@dataclass(frozen=True, slots=True)
class PreparedWorkflowRun:
    project_id: str
    database_executor: object
    task: Task
    workflow_run: WorkflowRun
    steps_config: dict
    artifacts_dir: Path
    user_message: Message | None
    user_input: str = ""
    entry_step_key: str | None = None
    execution_scope: frozenset[str] | None = None


def resolve_message_step_key(
    steps_config: dict,
    step_statuses: dict[str, str],
) -> str:
    ordered_keys = [
        step["key"]
        for step in steps_config.get("steps", [])
        if step.get("key")
    ]
    for statuses in (
        {"running", "reviewing", "awaiting_review", "retrying", "rework", "rework_waiting"},
        {"failed", "rejected"},
        {"pending"},
    ):
        current = next(
            (
                step_key
                for step_key in ordered_keys
                if step_statuses.get(step_key) in statuses
            ),
            None,
        )
        if current:
            return current
    return ordered_keys[-1] if ordered_keys else "do"


def infer_entry_scope(
    task: Task,
    steps_config: dict,
) -> tuple[str | None, set[str] | None]:
    """Infer a deliberately selected entry from initial step statuses."""
    if WorkflowRun.select().where(WorkflowRun.task == task).exists():
        return None, None
    scheduler = DAGScheduler([
        Step.from_dict(item) for item in steps_config.get("steps", [])
    ])
    statuses = {
        row.step_key: row.status
        for row in TaskStep.select().where(TaskStep.task == task)
    }
    if not any(
        statuses.get(step_key) == "skipped"
        for step_key in scheduler.steps
    ):
        return None, None
    scope = {
        step_key
        for step_key in scheduler.steps
        if statuses.get(step_key) != "skipped"
    }
    roots = [
        step_key
        for step_key in scope
        if not (set(scheduler.steps[step_key].depends_on) & scope)
    ]
    if len(roots) != 1:
        return None, None
    return roots[0], scope


def prepare_start_in_project(
    project,
    task_id: str,
    user_input: str,
    *,
    instance_id: str,
    current_workflow_steps: Callable[[object, Task], dict],
    source: str = "manual",
) -> PreparedWorkflowRun:
    """Persist a new run while executing on the project's DB thread."""
    try:
        task = Task.get_by_id(task_id)
    except Task.DoesNotExist as exc:
        raise ValueError(f"Task not found: {task_id}") from exc
    was_queued = task.status == "queued"
    queued = None
    if was_queued and task.queued_run_json:
        try:
            value = json.loads(task.queued_run_json)
            queued = value if isinstance(value, dict) else None
        except (TypeError, ValueError):
            queued = None
    if queued is not None:
        saved_source = queued.get("source")
        if saved_source in {"manual", "schedule", "scheduled_start"}:
            source = saved_source
        saved_input = queued.get("input")
        if isinstance(saved_input, str):
            user_input = saved_input
    heal_task_cwd(task, project)

    workflow_data = current_workflow_steps(project, task)
    workflow = WorkflowDefinition.load(workflow_data)
    compiled = workflow.compile()
    steps_config = compiled.to_steps_config()
    entry_step_key, execution_scope = infer_entry_scope(task, steps_config)
    routing_state = empty_routing_state()
    routing_state["entry_step_key"] = entry_step_key
    routing_state["execution_scope"] = (
        sorted(execution_scope) if execution_scope is not None else None
    )
    now = utc_now()
    if source in {"schedule", "scheduled_start"} or (was_queued and queued is None):
        actor_fields = {}
    elif queued is not None:
        saved_actor = queued.get("actor")
        actor_fields = {
            key: value for key, value in saved_actor.items()
            if key in {
                "author_id", "author_username", "author_name", "author_type",
                "initiated_by_user_id", "initiated_by_username",
                "author_device_id", "author_device_name",
            } and isinstance(value, str) and value
        } if isinstance(saved_actor, dict) else {}
    else:
        actor_fields = current_actor_message_fields()
    workflow_run = WorkflowRun.create(
        id=str(uuid.uuid4()),
        task=task,
        status="running",
        workflow_schema_version=compiled.schema_version,
        workflow_snapshot_json="{}",
        routing_state_json=json.dumps(routing_state, ensure_ascii=False),
        restart_from_step_key=entry_step_key,
        owner_id=instance_id,
        heartbeat_at=now,
        trigger_source=source,
        initiated_by_user_id=(
            actor_fields.get("initiated_by_user_id") or task.creator_id
        ),
        initiated_by_username=(
            actor_fields.get("initiated_by_username")
            or task.creator_username or task.creator_name
        ),
        initiated_by_name=actor_fields.get("author_name") or task.creator_name,
        initiated_by_device_id=(
            actor_fields.get("author_device_id") or task.creator_device_id
        ),
        initiated_by_device_name=(
            actor_fields.get("author_device_name") or task.creator_device_name
        ),
        started_at=now,
    )

    artifacts_dir = Path(project.workstep_dir) / "artifacts"
    artifacts_dir.mkdir(parents=True, exist_ok=True)
    task.status = "running"
    task.active_workflow_run_id = workflow_run.id
    task.queued_run_json = None
    task.state_version += 1
    task.updated_at = now
    task.save()

    normalized_input = user_input.strip()
    user_message = None
    if normalized_input:
        message_actor_fields = actor_fields
        if source in {"schedule", "scheduled_start"}:
            message_actor_fields = {
                "author_id": "scheduler",
                "author_username": "scheduler",
                "author_name": "定时任务",
                "author_type": "scheduler",
                "initiated_by_user_id": task.creator_id,
                "initiated_by_username": task.creator_username or task.creator_name,
                "author_device_id": task.creator_device_id,
                "author_device_name": task.creator_device_name,
            }
        step_statuses = {
            task_step.step_key: task_step.status
            for task_step in TaskStep.select().where(TaskStep.task == task)
        }
        message_step_key = resolve_message_step_key(
            steps_config,
            step_statuses,
        )
        user_message = create_task_message(
            id=new_message_id(),
            task=task,
            channel="execution",
            step_key=message_step_key,
            role="user",
            content=normalized_input,
            run_id=workflow_run.id,
            run_status="completed",
            position=0,
            started_at=now,
            ended_at=now,
            created_at=now,
            snapshot_current_actor=False,
            **message_actor_fields,
        )

    return PreparedWorkflowRun(
        project_id=project.id,
        database_executor=getattr(project, "database_executor", None),
        task=task,
        workflow_run=workflow_run,
        steps_config=steps_config,
        artifacts_dir=artifacts_dir,
        user_message=user_message,
        user_input=user_input,
        entry_step_key=entry_step_key,
        execution_scope=(
            frozenset(execution_scope)
            if execution_scope is not None else None
        ),
    )


def prepare_start_from_step_without_parent(
    project,
    task_id: str,
    step_key: str,
    *,
    instance_id: str,
    current_workflow_steps: Callable[[object, Task], dict],
    reset_session: bool = False,
    feedback_inputs: dict[str, dict] | None = None,
) -> PreparedWorkflowRun:
    """Create the initial run from one step, reusing passed upstream steps."""
    task = Task.get_by_id(task_id)
    heal_task_cwd(task, project)
    workflow_data = current_workflow_steps(project, task)
    compiled = WorkflowDefinition.load(workflow_data).compile()
    steps_config = compiled.to_steps_config()
    scheduler = DAGScheduler([
        Step.from_dict(item) for item in steps_config["steps"]
    ])
    if step_key not in scheduler.steps:
        raise ValueError(f"Step does not exist: {step_key}")
    execution_keys = {step_key, *scheduler.get_all_downstream(step_key)}
    reusable_keys = {
        row.step_key
        for row in TaskStep.select().where(
            (TaskStep.task == task)
            & (TaskStep.status == "passed")
            & (~(TaskStep.step_key.in_(execution_keys)))
        )
        if row.step_key in scheduler.steps
    }

    with db_proxy.atomic():
        TaskStep.update(
            status="pending",
            started_at=None,
            ended_at=None,
            error=None,
        ).where(
            (TaskStep.task == task)
            & (TaskStep.step_key.in_(execution_keys))
        ).execute()
        TaskStep.update(
            status="skipped",
            started_at=None,
            ended_at=None,
            error=None,
        ).where(
            (TaskStep.task == task)
            & (~(TaskStep.step_key.in_(execution_keys)))
            & (TaskStep.status != "passed")
        ).execute()
        task.status = "ready"
        task.updated_at = utc_now()
        task.save()

    prepared = prepare_start_in_project(
        project, task.id, "",
        instance_id=instance_id,
        current_workflow_steps=current_workflow_steps,
    )
    now = utc_now()
    workflow_run = prepared.workflow_run
    workflow_run.restart_from_step_key = step_key
    routing_state = normalize_routing_state(
        json.loads(workflow_run.routing_state_json)
        if workflow_run.routing_state_json else None
    )
    routing_state["entry_step_key"] = step_key
    routing_state["execution_scope"] = sorted(execution_keys)
    if feedback_inputs:
        routing_state["feedback_inputs"][step_key] = feedback_inputs
        routing_state["active_edges"] = sorted(
            set(routing_state["active_edges"]) | set(feedback_inputs)
        )
    workflow_run.routing_state_json = json.dumps(
        routing_state,
        ensure_ascii=False,
    )
    workflow_run.save(only=[
        WorkflowRun.restart_from_step_key,
        WorkflowRun.routing_state_json,
    ])
    if reset_session:
        TaskStep.update(
            session_id=None,
            session_provider=None,
            pending_handoff_json=None,
        ).where(
            (TaskStep.task == task)
            & (TaskStep.step_key == step_key)
        ).execute()
    prepared = PreparedWorkflowRun(
        project_id=prepared.project_id,
        database_executor=prepared.database_executor,
        task=prepared.task,
        workflow_run=prepared.workflow_run,
        steps_config=prepared.steps_config,
        artifacts_dir=prepared.artifacts_dir,
        user_message=prepared.user_message,
        user_input=prepared.user_input,
        entry_step_key=step_key,
        execution_scope=frozenset(execution_keys),
    )
    for reusable_key in reusable_keys:
        step = scheduler.steps[reusable_key]
        StepRun.create(
            id=str(uuid.uuid4()),
            run=workflow_run,
            step_key=reusable_key,
            attempt=1,
            status="reused",
            engine=step.engine,
            model=step.model or None,
            started_at=now,
            ended_at=now,
        )
    return prepared
