"""History and intervention API routes."""


from fastapi import APIRouter, HTTPException, Query

from schemas.base import BaseSchema
from services.history import get_message_events, get_step_history
from services.intervention import intervention_manager

router = APIRouter(prefix="/api")


class RespondRequest(BaseSchema):
    intervention_id: str
    data: dict


# --- History ---
@router.get("/task/{task_id}/step/{step_key}/history")
async def step_history(
    task_id: str,
    step_key: str,
    project_id: str = Query(...),
):
    """Get execution history for a specific step."""
    project = project_manager.get_project_by_id(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    history = await project_manager.run_db(
        project_id,
        lambda _project: get_step_history(
            task_id, step_key, project.workstep_dir
        ),
    )
    return {"task_id": task_id, "step_key": step_key, "messages": history}


@router.get("/task/{task_id}/messages/{message_id}/events")
async def task_message_events(
    task_id: str,
    message_id: str,
    project_id: str = Query(...),
    cursor: int = Query(0, ge=0),
    limit: int = Query(30000, ge=1, le=30000),
):
    """Return a bounded detail page from a task message's JSONL journal."""
    project = project_manager.get_project_by_id(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    try:
        return await project_manager.run_db(
            project_id,
            lambda _project: get_message_events(
                task_id,
                message_id,
                project.workstep_dir,
                cursor=cursor,
                limit=limit,
            ),
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


# --- Intervention ---


@router.post("/intervention/respond")
async def respond_to_intervention(req: RespondRequest, project_id: str | None = Query(None)):
    """Respond to a pending intervention request."""
    delivered = intervention_manager.deliver_response(req.intervention_id, req.data)
    if not delivered:
        raise HTTPException(status_code=404, detail="Intervention not found or already resolved")
    return {"delivered": True}


@router.get("/intervention/pending")
async def list_pending_interventions():
    """List all pending intervention requests."""
    return {"pending": intervention_manager.list_pending()}


# --- Session List (History of all tasks) ---

from services.project import project_manager


@router.get("/sessions")
async def list_sessions(project_id: str | None = None, limit: int = 50, offset: int = 0):
    """List all task sessions (history).

    If project_id is provided, filter by that project.
    """
    from services.task_search import list_sessions as load
    try:
        return await load(project_manager, project_id, limit, offset)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
