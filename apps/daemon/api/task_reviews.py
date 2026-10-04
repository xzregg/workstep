"""Task review history and decision API routes."""


from fastapi import APIRouter, HTTPException, Query

from api.task_context import _require_scoped_task, _run_db
from schemas.task import ReviewDecisionRequest

router = APIRouter(prefix="/api/task")


@router.get("/{task_id}/reviews")
async def get_task_reviews(
    task_id: str,
    pid: str = Query(..., alias="project_id"),
):
    """Return persisted review history for a task."""
    await _require_scoped_task(pid, task_id)
    from services.task_queries import task_reviews

    return {"reviews": await _run_db(pid, lambda: task_reviews(task_id))}


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
    await _require_scoped_task(project_id, task_id)
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
