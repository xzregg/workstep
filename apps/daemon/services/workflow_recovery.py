"""Recover interrupted workflow runs inside one project database work unit."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Callable

from agent_assistants.event_journal import TurnEventJournal
from models import Message, ReviewRun, StepRun, Task, TaskStep, WorkflowRun
from models.fields import utc_now
from services.artifact_rounds import discard_artifact_round
from services.intervention import seal_unanswered_interactions
from services.workflow_definition import WorkflowDefinition

logger = logging.getLogger(__name__)
RUN_LEASE_STALE_SECONDS = 30.0


def heal_task_cwd(task, project) -> bool:
    """Persist the project root when a task's cwd no longer exists.

    Tasks created inside the containerized layout store ``/data/projects/<name>``
    paths that never exist on the host. Engines spawn with this cwd, so the
    first write (skill plugin materialization) fails with a read-only filesystem
    error. Repairing it here keeps every run path consistent.
    """
    cwd = str(task.cwd or "").strip()
    if cwd and Path(cwd).is_dir():
        return False
    root = str(project.path)
    if cwd == root:
        return False
    task.cwd = root
    task.save(only=[Task.cwd])
    logger.warning(
        "Task %s cwd %r is unavailable; fell back to project root %s",
        task.id,
        cwd,
        root,
    )
    return True


def lease_held_by_live_owner(workflow_run: WorkflowRun, now: datetime, owner_id: str) -> bool:
    owner = getattr(workflow_run, "owner_id", None)
    heartbeat = getattr(workflow_run, "heartbeat_at", None)
    return bool(owner and heartbeat is not None and owner != owner_id
                and (now - heartbeat).total_seconds() < RUN_LEASE_STALE_SECONDS)


@dataclass(frozen=True, slots=True)
class RecoveredRun:
    task_id: str
    run_id: str
    step_keys: frozenset[str]
    recovered_at: datetime
    recovered_count: int
    steps_config: dict


@dataclass(frozen=True, slots=True)
class RecoveryDecision:
    runs: tuple[RecoveredRun, ...]
    contended_run_ids: tuple[str, ...]


def _seal_event_journal(project, message: Message, *, restore_content: bool) -> None:
    journal = TurnEventJournal()
    ref = journal.reopen(project.workstep_dir, message.event_log_path)
    snapshot = journal.snapshot(ref)
    original_events = snapshot["events"]
    sealed_json = seal_unanswered_interactions(
        json.dumps(original_events, ensure_ascii=False)
    )
    for response_event in json.loads(sealed_json or "[]")[len(original_events):]:
        journal.record(ref, response_event)
    journal.finish(ref)
    snapshot = journal.snapshot(ref)
    if restore_content:
        message.content = snapshot["content"]
    message.events_json = json.dumps(
        snapshot["events"], ensure_ascii=False
    ) if snapshot["events"] else None
    message.event_summary_json = json.dumps(snapshot["summary"], ensure_ascii=False)
    message.event_count = snapshot["summary"]["event_count"]
    message.last_event_seq = snapshot["summary"]["last_event_seq"]


def prepare_project_recovery(
    project,
    *,
    active_task_ids: frozenset[str],
    owner_id: str,
    current_workflow_steps: Callable[[object, Task], dict],
) -> RecoveryDecision:
    """Finish synchronous database and journal work before returning pure data."""
    prepared = []
    contended = []
    interrupted = list(
        WorkflowRun.select().where(WorkflowRun.status == "running")
    )
    for workflow_run in interrupted:
        task = Task.get_by_id(workflow_run.task_id)
        if task.id in active_task_ids:
            continue
        heal_task_cwd(task, project)
        now = utc_now()
        if lease_held_by_live_owner(workflow_run, now, owner_id):
            # Another daemon still holds a fresh lease. Do NOT touch the run
            # (that would clobber the live instance's status writes); retry
            # recovery once the lease is expected to have gone stale.
            logger.warning(
                "Skipping recovery of run %s: lease still held by live daemon %s",
                workflow_run.id,
                workflow_run.owner_id,
            )
            contended.append(workflow_run.id)
            continue
        steps_config = (
            WorkflowDefinition.load(current_workflow_steps(project, task))
            .compile()
            .to_steps_config()
        )
        stale_keys = set()
        review_keys = set()
        review_step_runs = {}
        review_passed_keys = set()
        for step_run in StepRun.select().where(
            (StepRun.run == workflow_run)
            & (StepRun.status == "running")
        ):
            if step_run.artifact_round is not None:
                discard_artifact_round(
                    Path(project.workstep_dir) / "artifacts",
                    task.workflow_id,
                    task.id,
                    step_run.step_key,
                    step_run.artifact_round,
                )
                step_run.artifact_round = None
                step_run.input_rounds_json = None
            step_run.status = "failed"
            step_run.error = "进程重启中断，等待自动恢复"
            step_run.ended_at = now
            step_run.save()
            stale_keys.add(step_run.step_key)
        for ts in TaskStep.select().where(
            (TaskStep.task == task) & (TaskStep.status == "running")
        ):
            latest_step_run = (
                StepRun.select()
                .where(
                    (StepRun.run == workflow_run)
                    & (StepRun.step_key == ts.step_key)
                )
                .order_by(StepRun.attempt.desc())
                .first()
            )
            if latest_step_run is not None and latest_step_run.status == "succeeded":
                # The process may have died between committing execution
                # success and moving the step into review.
                ts.status = "reviewing"
                ts.save()
                continue
            ts.status = "pending"
            ts.ended_at = None
            ts.error = None
            ts.save()
            stale_keys.add(ts.step_key)
        for ts in TaskStep.select().where(
            (TaskStep.task == task) & (TaskStep.status == "reviewing")
        ):
            latest_step_run = (
                StepRun.select()
                .where(
                    (StepRun.run == workflow_run)
                    & (StepRun.step_key == ts.step_key)
                )
                .order_by(StepRun.attempt.desc())
                .first()
            )
            if latest_step_run is None or latest_step_run.status != "succeeded":
                continue
            review_keys.add(ts.step_key)
            review_step_runs[ts.step_key] = latest_step_run
            latest_review = (
                ReviewRun.select()
                .where(ReviewRun.step_run == latest_step_run)
                .order_by(ReviewRun.attempt.desc())
                .first()
            )
            if latest_review is not None and latest_review.status == "passed":
                review_passed_keys.add(ts.step_key)
            ReviewRun.update(
                status="failed",
                error="进程重启中断，等待自动恢复审核",
                ended_at=now,
            ).where(
                (ReviewRun.step_run == latest_step_run)
                & (ReviewRun.mode == "auto")
                & (ReviewRun.status == "running")
            ).execute()
        current_step_run_ids = [
            row.id for row in StepRun.select(StepRun.id).where(
                StepRun.run == workflow_run
            )
        ]
        current_message_run = Message.step_run_id.in_(current_step_run_ids)
        if workflow_run.started_at is not None:
            current_message_run |= (
                Message.step_run_id.is_null(True)
                & (Message.created_at >= workflow_run.started_at)
            )
        if stale_keys or review_keys:
            # Close in-flight execution messages so the UI does not keep
            # an eternally-running spinner for the interrupted attempt.
            stale_messages = Message.select().where(
                (Message.task == task)
                & (Message.channel == "execution")
                & (Message.run_status == "running")
                & current_message_run
                & (Message.step_key.in_(stale_keys | review_keys))
            )
            for stale_message in stale_messages:
                review_execution_finished = stale_message.step_key in review_keys
                stale_message.run_status = (
                    "succeeded" if review_execution_finished else "failed"
                )
                stale_message.ended_at = (
                    review_step_runs[stale_message.step_key].ended_at or now
                    if review_execution_finished else now
                )
                if stale_message.event_log_path:
                    _seal_event_journal(project, stale_message, restore_content=True)
                else:
                    stale_message.events_json = seal_unanswered_interactions(
                        stale_message.events_json
                    )
                stale_message.save()
        if review_keys:
            review_messages = Message.select().where(
                (Message.task == task)
                & (Message.channel == "review")
                & (Message.run_status == "running")
                & current_message_run
                & (Message.step_key.in_(review_keys))
            )
            for review_message in review_messages:
                passed = review_message.step_key in review_passed_keys
                review_message.run_status = "completed" if passed else "failed"
                review_message.content = (
                    "审核已通过" if passed else "审核因服务重启中断，正在自动重试"
                )
                review_message.ended_at = now
                if review_message.event_log_path:
                    _seal_event_journal(project, review_message, restore_content=False)
                review_message.save()
        task.status = "running"
        task.updated_at = now
        task.save()
        workflow_run.recovered_at = now
        workflow_run.recovered_count = (
            workflow_run.recovered_count or 0
        ) + 1
        workflow_run.owner_id = owner_id
        workflow_run.heartbeat_at = now
        workflow_run.save()
        prepared.append(RecoveredRun(
            task.id, workflow_run.id, frozenset(stale_keys | review_keys),
            now, workflow_run.recovered_count, steps_config,
        ))
    return RecoveryDecision(tuple(prepared), tuple(contended))
