"""Synchronous decision transaction for one workflow review."""

import json
import uuid
from pathlib import Path
from typing import Callable, Mapping

from models import Message, ReviewRun, StepRun, Task, TaskStep, WorkflowRun
from models.fields import utc_now
from services.artifact_rounds import ArtifactRound, step_round_dir, update_round_manifest_status
from services.artifact_routing import normalize_routing_state, route_artifact_round
from services.pipeline import DAGScheduler, Step
from services.workflow_definition import WorkflowDefinition


def persist_review_decision(
    project, task_id: str, step_key: str, review_run_id: str,
    decision: str, comment: str | None, actor_fields: dict,
    schedule_downstream: bool | None, *, active_runners: Mapping,
    instance_id: str, current_workflow_steps: Callable[[object, Task], dict],
) -> tuple[Task, WorkflowRun, dict] | None:
    """Run only through the owning project database executor."""
    review = ReviewRun.get_or_none(ReviewRun.id == review_run_id)
    if (
        review is None
        or review.task_id != task_id
        or review.step_key != step_key
    ):
        raise ValueError("Review not found for the requested task step")
    if review.status == "skipped":
        raise RuntimeError("Review has been skipped by a newer step message")
    latest = (
        ReviewRun.select()
        .where(
            (ReviewRun.task == task_id)
            & (ReviewRun.step_key == step_key)
        )
        .order_by(ReviewRun.started_at.desc(), ReviewRun.id.desc())
        .first()
    )
    setting_complete = decision == "set_complete"
    if not setting_complete and (latest is None or latest.id != review.id):
        raise RuntimeError("Review has been superseded by a newer attempt")
    if review.decision:
        if review.decision == decision:
            return None
        if not (setting_complete and review.decision == "terminate"):
            raise RuntimeError("Review already has a different decision")

    now = utc_now()
    completed_task = decision == "complete_task"
    approved = decision in {"approve", "force_approve", "complete_task", "set_complete"}
    terminated = decision == "terminate"
    task = Task.get_by_id(task_id)
    workflow_run = (
        WorkflowRun.get_or_none(WorkflowRun.id == task.active_workflow_run_id)
        if setting_complete else review.workflow_run
    )
    if setting_complete:
        current_step = TaskStep.get_or_none(
            (TaskStep.task == task) & (TaskStep.step_key == step_key)
        )
        stopped_manual_review = (
            review.mode == "manual" and review.status == "terminated"
        )
        stopped_auto_review = (
            review.mode == "auto" and review.status == "failed"
            and review.error == "手动停止"
            and review.step_run.status == "succeeded"
        )
        pending_manual_review = (
            review.mode == "manual" and review.status in {"pending", "rejected"}
            and latest is not None and latest.id == review.id
            and task.active_workflow_run_id == review.workflow_run_id
            and current_step is not None
            and current_step.status == "awaiting_review"
        )
        if (
            not (stopped_manual_review or stopped_auto_review or pending_manual_review)
            or workflow_run is None or workflow_run.task_id != task_id
            or task.status not in {"stopped", "paused"}
            or workflow_run.status not in {"stopped", "failed", "paused"}
            or current_step is None
            or current_step.status not in {"cancelled", "failed", "pending", "awaiting_review"}
            or task_id in active_runners
        ):
            raise RuntimeError("只有待处理或已停止的审核，且任务已暂停、步骤未完成时才能设置完成")
        if schedule_downstream and TaskStep.select().where(
            (TaskStep.task == task)
            & (TaskStep.step_key != step_key)
            & (TaskStep.status.in_([
                "running", "retrying", "rework", "reviewing", "awaiting_review",
            ]))
        ).exists():
            raise RuntimeError("其他步骤正在执行或等待审核，暂不能调度下游；可选择只设置完成当前步骤")
        from services.artifacts import list_task_artifacts

        if not pending_manual_review and (
            review.step_run.artifact_round is None or not any(
                artifact["step_key"] == step_key
                and artifact["round"] == review.step_run.artifact_round
                for artifact in list_task_artifacts(project, task_id)
            )
        ):
            raise RuntimeError("该审核轮次没有已产生的产物，不能设置完成")
    if completed_task:
        if review.mode != "manual" or review.status not in {"pending", "rejected"}:
            raise RuntimeError("只有待处理的人工审核可以完成任务")
        if task.active_workflow_run_id != workflow_run.id:
            raise RuntimeError("审核不属于当前执行轮次")
        current_step = TaskStep.get_or_none(
            (TaskStep.task == task) & (TaskStep.step_key == step_key)
        )
        if current_step is None or current_step.status != "awaiting_review":
            raise RuntimeError("当前阶段已不再等待人工审核")
        other_running = TaskStep.select().where(
            (TaskStep.task == task)
            & (TaskStep.step_key != step_key)
            & (TaskStep.status.in_(["running", "retrying", "rework", "reviewing"]))
        )
        if other_running.exists() or task_id in active_runners:
            raise RuntimeError("其他阶段仍在执行，不能完成任务")
    steps_config = None
    if not terminated and not completed_task:
        steps_config = (
            WorkflowDefinition.load(current_workflow_steps(project, task))
            .compile()
            .to_steps_config()
        )
        if step_key not in {
            str(item.get("key") or "") for item in steps_config["steps"]
        }:
            raise ValueError(f"Step does not exist in latest workflow: {step_key}")
    review.decision = decision
    review.decision_comment = comment
    review.reviewer_id = actor_fields.get("author_id")
    review.reviewer_name = actor_fields.get("author_name")
    review.reviewer_device_id = actor_fields.get("author_device_id")
    review.reviewer_device_name = actor_fields.get("author_device_name")
    review.decided_at = now
    review.ended_at = review.ended_at or now
    review.status = (
        "terminated" if terminated else "passed" if approved else "rejected"
    )
    review.save()
    from services.project_audit import record_project_audit
    from services.remote_access import get_effective_actor

    actor = get_effective_actor()
    record_project_audit(
        project_id=project.id,
        task_id=task_id,
        action=f"review.{decision}",
        result="succeeded",
        mode="managed" if actor is not None and actor.source == "managed" else "local",
        metadata={
            "step_key": step_key,
            "review_run_id": review_run_id,
            "workflow_run_id": workflow_run.id,
        },
    )

    # 人工审核完成后，同步审核消息的结束时间，前端据此显示审核耗时。
    Message.update(
        ended_at=review.ended_at,
        run_status="completed",
        **actor_fields,
    ).where(
        (Message.task == task_id)
        & (Message.channel == "review")
        & (Message.step_key == step_key)
        & (Message.ended_at.is_null())
    ).execute()

    task_step = TaskStep.get(
        (TaskStep.task == task_id) & (TaskStep.step_key == step_key)
    )
    if terminated:
        task_step.status = "cancelled"
        task_step.error = comment or "用户终止"
        task_step.ended_at = now
        task_step.review_feedback = None
    elif approved:
        task_step.status = "passed"
        task_step.error = None
        task_step.ended_at = now
        task_step.review_feedback = None
    else:
        # 人工审核不通过：保存原因，带反馈自动重跑当前步骤。
        task_step.status = "retrying"
        task_step.error = comment or "用户驳回审核"
        task_step.review_feedback = comment or ""
        task_step.ended_at = None
    task_step.save()
    if setting_complete and review.workflow_run_id != workflow_run.id:
        latest_attempt = (
            StepRun.select()
            .where((StepRun.run == workflow_run) & (StepRun.step_key == step_key))
            .order_by(StepRun.attempt.desc())
            .first()
        )
        StepRun.create(
            id=str(uuid.uuid4()),
            run=workflow_run,
            step_key=step_key,
            attempt=(latest_attempt.attempt + 1) if latest_attempt else 1,
            artifact_round=review.step_run.artifact_round,
            status="reused",
            engine=review.step_run.engine,
            model=review.step_run.model,
            source_step_run_id=review.step_run_id,
            started_at=now,
            ended_at=now,
        )
    if completed_task:
        if review.step_run.artifact_round is not None:
            update_round_manifest_status(
                artifacts_root=Path(project.workstep_dir) / "artifacts",
                workflow_id=task.workflow_id,
                task_id=task.id,
                step_key=step_key,
                artifact_round=review.step_run.artifact_round,
                status="passed",
                eligible_for_downstream=True,
            )
        TaskStep.update(
            status="skipped", error=None, ended_at=now,
        ).where(
            (TaskStep.task == task)
            & (TaskStep.step_key != step_key)
            & (TaskStep.status != "passed")
        ).execute()
        ReviewRun.update(status="skipped", ended_at=now).where(
            (ReviewRun.workflow_run == workflow_run)
            & (ReviewRun.id != review.id)
            & (ReviewRun.status.in_(["pending", "running"]))
        ).execute()
        current_step_run_ids = StepRun.select(StepRun.id).where(
            StepRun.run == workflow_run
        )
        Message.update(run_status="completed", ended_at=now).where(
            (Message.task == task)
            & (Message.channel == "review")
            & (Message.run_status == "running")
            & (Message.step_run_id.in_(current_step_run_ids))
        ).execute()
        task.status = "ready"
        task.state_version += 1
        task.updated_at = now
        task.save()
        workflow_run.status = "succeeded"
        workflow_run.ended_at = now
        workflow_run.owner_id = None
        workflow_run.heartbeat_at = None
        workflow_run.save()
        return None
    if terminated:
        task.status = "stopped"
        task.state_version += 1
        task.updated_at = now
        task.save()
        workflow_run.status = "stopped"
        workflow_run.ended_at = now
        workflow_run.owner_id = None
        workflow_run.heartbeat_at = now
        workflow_run.save()
        return None
    if setting_complete and not schedule_downstream:
        if review.step_run.artifact_round is not None:
            update_round_manifest_status(
                artifacts_root=Path(project.workstep_dir) / "artifacts",
                workflow_id=task.workflow_id,
                task_id=task.id,
                step_key=step_key,
                artifact_round=review.step_run.artifact_round,
                status="passed",
                eligible_for_downstream=True,
            )
        task.state_version += 1
        task.updated_at = now
        task.save()
        return None
    assert steps_config is not None
    halt_after_routing = False
    if approved and review.step_run.artifact_round is not None:
        manifest = update_round_manifest_status(
            artifacts_root=Path(project.workstep_dir) / "artifacts",
            workflow_id=task.workflow_id,
            task_id=task.id,
            step_key=step_key,
            artifact_round=review.step_run.artifact_round,
            status="passed",
            eligible_for_downstream=True,
        )
        if manifest is not None:
            scheduler = DAGScheduler([
                Step.from_dict(item)
                for item in steps_config["steps"]
            ])
            routed_step = scheduler.steps[step_key]
            state = normalize_routing_state(
                json.loads(workflow_run.routing_state_json)
                if workflow_run.routing_state_json else None
            )
            result = route_artifact_round(
                step=routed_step,
                artifact_round=ArtifactRound(
                    round=review.step_run.artifact_round,
                    path=step_round_dir(
                        Path(project.workstep_dir) / "artifacts",
                        task.workflow_id,
                        task.id,
                        step_key,
                        review.step_run.artifact_round,
                    ),
                    manifest=manifest,
                ),
                routing_state=state,
            )
            if result.conflict or result.exhausted_edges:
                halt_after_routing = True
                task_step.status = "failed"
                task_step.error = (
                    "同一轮同时产生了正常输出和返回输出，路由冲突"
                    if result.conflict else
                    f"返回线已达到配置上限 {routed_step.max_return_rounds} 次"
                )
                task_step.ended_at = now
                task_step.save()
            elif result.feedback_edges:
                targets = {
                    str(connection.get("to"))
                    for connection in result.feedback_edges
                }
                rewind: set[str] = set()
                for target in targets:
                    rewind.add(target)
                    rewind.update(scheduler.get_all_downstream(target))
                persisted_scope = result.state.get("execution_scope")
                if isinstance(persisted_scope, list):
                    result.state["execution_scope"] = sorted(
                        {str(key) for key in persisted_scope} | rewind
                    )
                elif result.state.get("entry_step_key") in scheduler.steps:
                    entry_key = result.state["entry_step_key"]
                    result.state["execution_scope"] = sorted(
                        {entry_key, *scheduler.get_all_downstream(entry_key)}
                        | rewind
                    )
                for key in rewind:
                    row = TaskStep.get(
                        (TaskStep.task == task) & (TaskStep.step_key == key)
                    )
                    row.status = (
                        "rework_waiting" if key == step_key else "rework"
                    )
                    row.error = None
                    row.ended_at = None
                    row.save()
            workflow_run.routing_state_json = json.dumps(
                result.state, ensure_ascii=False, sort_keys=True
            )
    if halt_after_routing:
        task.status = "paused"
        task.state_version += 1
        task.updated_at = now
        task.save()
        workflow_run.status = "paused"
        workflow_run.ended_at = now
        workflow_run.owner_id = None
        workflow_run.heartbeat_at = now
        workflow_run.save()
        return None
    task.status = "running"
    task.state_version += 1
    task.updated_at = now
    task.save()
    workflow_run.status = "running"
    workflow_run.ended_at = None
    workflow_run.owner_id = instance_id
    workflow_run.heartbeat_at = now
    workflow_run.save()
    return task, workflow_run, steps_config
