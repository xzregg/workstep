"""Task review history and decision API routes."""

import json

from fastapi import APIRouter, HTTPException, Query

from api.task_context import _run_db
from schemas.task import ReviewDecisionRequest

router = APIRouter(prefix="/api/task")


@router.get("/{task_id}/reviews")
async def get_task_reviews(
    task_id: str,
    pid: str = Query(..., alias="project_id"),
):
    """Return persisted review history for a task."""
    from models import ReviewRun
    def load_reviews():
        rows = (
            ReviewRun.select()
            .where(ReviewRun.task == task_id)
            .order_by(ReviewRun.started_at.desc(), ReviewRun.id.desc())
        )
        return [{
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
            "error": row.error,
            "decision_comment": row.decision_comment,
            "reviewer_id": row.reviewer_id,
            "reviewer_name": row.reviewer_name,
            "reviewer_device_id": row.reviewer_device_id,
            "reviewer_device_name": row.reviewer_device_name,
            "started_at": row.started_at,
            "ended_at": row.ended_at,
        } for row in rows]

    return {"reviews": await _run_db(pid, load_reviews)}


async def _decide_review(
    task_id: str,
    step_key: str,
    req: ReviewDecisionRequest,
    project_id: str,
    decision: str,
):
    from main import workflow_runtime
    if not workflow_runtime:
        raise HTTPException(status_code=503, detail="Service not initialized")
    try:
        options = (
            {"schedule_downstream": req.schedule_downstream}
            if decision == "set_complete" else {}
        )
        handle = await workflow_runtime.decide_review(
            project_id, task_id, step_key, req.review_run_id, decision, req.comment,
            **options,
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {
        "decision": decision,
        "resumed": handle is not None,
        "run_id": handle.id if handle else None,
    }


@router.post("/{task_id}/steps/{step_key}/review/approve")
async def approve_review(
    task_id: str,
    step_key: str,
    req: ReviewDecisionRequest,
    pid: str = Query(..., alias="project_id"),
):
    return await _decide_review(task_id, step_key, req, pid, "approve")


@router.post("/{task_id}/steps/{step_key}/review/reject")
async def reject_review(
    task_id: str,
    step_key: str,
    req: ReviewDecisionRequest,
    pid: str = Query(..., alias="project_id"),
):
    return await _decide_review(task_id, step_key, req, pid, "reject")


@router.post("/{task_id}/steps/{step_key}/review/force-approve")
async def force_approve_review(
    task_id: str,
    step_key: str,
    req: ReviewDecisionRequest,
    pid: str = Query(..., alias="project_id"),
):
    return await _decide_review(task_id, step_key, req, pid, "force_approve")


@router.post("/{task_id}/steps/{step_key}/review/terminate")
async def terminate_review(
    task_id: str,
    step_key: str,
    req: ReviewDecisionRequest,
    pid: str = Query(..., alias="project_id"),
):
    return await _decide_review(task_id, step_key, req, pid, "terminate")


@router.post("/{task_id}/steps/{step_key}/review/complete-task")
async def complete_task_at_review(
    task_id: str,
    step_key: str,
    req: ReviewDecisionRequest,
    pid: str = Query(..., alias="project_id"),
):
    return await _decide_review(task_id, step_key, req, pid, "complete_task")


@router.post("/{task_id}/steps/{step_key}/review/set-complete")
async def set_terminated_review_complete(
    task_id: str,
    step_key: str,
    req: ReviewDecisionRequest,
    pid: str = Query(..., alias="project_id"),
):
    return await _decide_review(task_id, step_key, req, pid, "set_complete")
