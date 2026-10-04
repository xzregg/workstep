"""Materialized task projections; callers execute each unit through run_db."""

import json
from models import Task, Workflow, ReviewRun, Message
from models.chat_session import ChatSession


def task_exists(task_id):
    return Task.select().where(Task.id == task_id).exists()


def task_workspace_state(task_id):
    task = Task.get_or_none(Task.id == task_id)
    if task is None:
        return None
    return {"status": task.status, "creator_name": task.creator_name or "", "workflow_id": task.workflow_id}


def workflow_exists(workflow_id):
    return Workflow.get_or_none(Workflow.id == workflow_id) is not None


def chat_session_exists(session_id):
    return ChatSession.select().where(ChatSession.id == session_id).exists()


def pending_review_exists(task_id, step_key, review_id):
    return ReviewRun.select(ReviewRun.id).where(
        ReviewRun.id == review_id, ReviewRun.task == task_id,
        ReviewRun.step_key == step_key, ReviewRun.mode == "manual",
        ReviewRun.status == "pending",
    ).exists()


def pending_reviews(task_id):
    rows = ReviewRun.select(ReviewRun.id, ReviewRun.step_key, ReviewRun.report_json,
                            ReviewRun.started_at, ReviewRun.mode, ReviewRun.status).where(
        ReviewRun.task == task_id, ReviewRun.mode == "manual", ReviewRun.status == "pending",
    ).order_by(ReviewRun.started_at.desc(), ReviewRun.id.desc()).limit(100)
    return [{"id": row.id, "step_key": row.step_key,
             "report": json.loads(row.report_json) if row.report_json else None,
             "started_at": row.started_at, "mode": row.mode, "status": row.status} for row in rows]


def shared_message_events(project, task_id, message_id, *, cursor, limit, mode):
    from services.history import get_message_events
    from services.share import _scrub_events
    message = Message.get_or_none(Message.id == message_id, Message.task == task_id,
                                  Message.channel == "execution")
    if message is None:
        raise LookupError("Task message not found")
    page = get_message_events(task_id, message_id, project.workstep_dir, cursor=cursor, limit=limit)
    page["events"] = _scrub_events(page["events"], mode=mode)
    return page


def task_reviews(task_id, *, include_errors=True):
    rows = (
        ReviewRun.select()
        .where(ReviewRun.task == task_id)
        .order_by(ReviewRun.started_at.desc(), ReviewRun.id.desc())
    )
    result = [{
        "id": row.id,
        "workflow_run_id": row.workflow_run_id,
        "step_run_id": row.step_run_id,
        "artifact_round": row.step_run.artifact_round,
        "step_key": row.step_key,
        "mode": row.mode,
        "status": row.status,
        "engine": row.engine,
        "model": row.model,
        "report": json.loads(row.report_json) if row.report_json else None,
        "decision": row.decision,
        "decision_comment": row.decision_comment,
        "reviewer_id": row.reviewer_id,
        "reviewer_name": row.reviewer_name,
        "reviewer_device_id": row.reviewer_device_id,
        "reviewer_device_name": row.reviewer_device_name,
        "started_at": row.started_at,
        "ended_at": row.ended_at,
    } for row in rows]
    if include_errors:
        for item, row in zip(result, rows):
            item["error"] = row.error
    return result


def audit_idle_cancel(project_id, task_id, actor):
    from services.project_audit import record_project_audit
    if Task.get_or_none(Task.id == task_id) is not None:
        record_project_audit(
            project_id=project_id, task_id=task_id,
            action="task.cancel", result="denied",
            mode=("managed" if actor is not None and actor.source == "managed"
                  else "local"),
            metadata={"reason_code": "not_running"},
        )
