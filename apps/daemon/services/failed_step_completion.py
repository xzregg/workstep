"""Accept a failed step's existing artifact round in one DB work unit."""

import json
import uuid
from pathlib import Path

from models import Message, StepRun, Task, TaskStep, WorkflowRun
from models.base import db_proxy
from models.fields import utc_now
from services.artifact_rounds import (
    ArtifactRound,
    step_round_dir,
    update_round_manifest_status,
)
from services.artifact_routing import normalize_routing_state, route_artifact_round
from services.pipeline import DAGScheduler, Step
from services.workflow_definition import WorkflowDefinition


def persist_failed_step_completion(
    project, task_id, message_id, artifact_round, *, schedule_downstream,
    active_runner, instance_id, current_workflow_steps,
):
    """Persist completion and optional downstream routing atomically."""
    with db_proxy.atomic():
        return _persist_failed_step_completion_transaction(
            project, task_id, message_id, artifact_round,
            schedule_downstream=schedule_downstream,
            active_runner=active_runner,
            instance_id=instance_id,
            current_workflow_steps=current_workflow_steps,
        )


def _persist_failed_step_completion_transaction(
    project, task_id, message_id, artifact_round, *, schedule_downstream,
    active_runner, instance_id, current_workflow_steps,
):
    from services.artifacts import list_task_artifacts

    task = Task.get_or_none(Task.id == task_id)
    message = Message.get_or_none(Message.id == message_id)
    if (
        task is None or message is None or message.task_id != task_id
        or message.channel != "execution" or message.role != "assistant"
        or message.run_status not in {"failed", "cancelled", "stopped"}
        or not message.step_run_id
    ):
        raise ValueError("失败执行消息不存在")
    source = StepRun.get_or_none(StepRun.id == message.step_run_id)
    workflow_run = WorkflowRun.get_or_none(
        WorkflowRun.id == task.active_workflow_run_id
    )
    task_step = TaskStep.get_or_none(
        (TaskStep.task == task) & (TaskStep.step_key == message.step_key)
    )
    if (
        source is None or source.step_key != message.step_key
        or source.run.task_id != task_id or source.status != "failed"
        or workflow_run is None or workflow_run.task_id != task_id
        or workflow_run.status not in {"failed", "paused", "stopped"}
        or task.status not in {"paused", "stopped"}
        or task_step is None or task_step.status not in {"failed", "pending", "cancelled"}
        or active_runner
    ):
        raise RuntimeError("只有已停止且未完成的失败步骤可以设置完成")
    active_steps = TaskStep.select().where(
        (TaskStep.task == task) &
        (TaskStep.status.in_(["running", "retrying", "rework", "reviewing", "awaiting_review"]))
    )
    if schedule_downstream and active_steps.exists():
        raise RuntimeError("其他步骤正在执行或等待审核，暂不能调度下游；可选择只设置完成当前步骤")
    if artifact_round < 1 or not any(
        artifact["step_key"] == message.step_key
        and artifact["round"] == artifact_round
        for artifact in list_task_artifacts(project, task_id)
    ):
        raise RuntimeError("该步骤没有已产生的产物，不能设置完成")

    steps_config = None
    if schedule_downstream:
        steps_config = (
            WorkflowDefinition.load(current_workflow_steps(project, task))
            .compile().to_steps_config()
        )
        if message.step_key not in {
            str(item.get("key") or "") for item in steps_config["steps"]
        }:
            raise ValueError(f"Step does not exist in latest workflow: {message.step_key}")
    now = utc_now()
    latest_attempt = (
        StepRun.select()
        .where((StepRun.run == workflow_run) & (StepRun.step_key == message.step_key))
        .order_by(StepRun.attempt.desc())
        .first()
    )
    StepRun.create(
        id=str(uuid.uuid4()), run=workflow_run, step_key=message.step_key,
        attempt=latest_attempt.attempt + 1 if latest_attempt else 1,
        artifact_round=artifact_round, status="reused",
        engine=source.engine, model=source.model,
        source_step_run_id=source.id, started_at=now, ended_at=now,
    )
    task_step.status = "passed"
    task_step.error = None
    task_step.review_feedback = None
    task_step.rework_feedback = None
    task_step.ended_at = now
    task_step.save()
    manifest = update_round_manifest_status(
        artifacts_root=Path(project.workstep_dir) / "artifacts",
        workflow_id=task.workflow_id, task_id=task.id,
        step_key=message.step_key, artifact_round=artifact_round,
        status="passed", eligible_for_downstream=True,
    )
    task.state_version += 1
    task.updated_at = now
    task.save()
    if not schedule_downstream:
        return None
    assert steps_config is not None
    if manifest is not None:
        scheduler = DAGScheduler([
            Step.from_dict(item) for item in steps_config["steps"]
        ])
        state = normalize_routing_state(
            json.loads(workflow_run.routing_state_json)
            if workflow_run.routing_state_json else None
        )
        result = route_artifact_round(
            step=scheduler.steps[message.step_key],
            artifact_round=ArtifactRound(
                round=artifact_round,
                path=step_round_dir(
                    Path(project.workstep_dir) / "artifacts",
                    task.workflow_id, task.id, message.step_key, artifact_round,
                ),
                manifest=manifest,
            ),
            routing_state=state,
        )
        if result.conflict or result.exhausted_edges:
            reason = (
                "同一轮同时产生了正常输出和返回输出，路由冲突"
                if result.conflict else "返回线已达到配置上限"
            )
            raise RuntimeError(reason)
        if result.feedback_edges:
            targets = {str(edge.get("to")) for edge in result.feedback_edges}
            rewind: set[str] = set()
            for target in targets:
                rewind.add(target)
                rewind.update(scheduler.get_all_downstream(target))
            scope = result.state.get("execution_scope")
            if isinstance(scope, list):
                result.state["execution_scope"] = sorted(
                    {str(key) for key in scope} | rewind
                )
            for key in rewind:
                row = TaskStep.get_or_none(
                    (TaskStep.task == task) & (TaskStep.step_key == key)
                )
                if row is None:
                    continue
                row.status = "rework_waiting" if key == message.step_key else "rework"
                row.error = None
                row.ended_at = None
                row.save()
        workflow_run.routing_state_json = json.dumps(
            result.state, ensure_ascii=False, sort_keys=True,
        )
    task.status = "running"
    task.save()
    workflow_run.status = "running"
    workflow_run.ended_at = None
    workflow_run.owner_id = instance_id
    workflow_run.heartbeat_at = now
    workflow_run.save()
    return task, workflow_run, steps_config
