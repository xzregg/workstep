"""History and intervention API routes."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from services.history import get_task_history, get_step_history
from services.intervention import intervention_manager

router = APIRouter(prefix="/api")


class RespondRequest(BaseModel):
    intervention_id: str
    data: dict


# --- History ---


@router.get("/task/{task_id}/history")
async def task_history(task_id: str):
    """Get full execution history for a task."""
    history = get_task_history(task_id)
    return {"task_id": task_id, "messages": history}


@router.get("/task/{task_id}/step/{step_key}/history")
async def step_history(task_id: str, step_key: str):
    """Get execution history for a specific step."""
    history = get_step_history(task_id, step_key)
    return {"task_id": task_id, "step_key": step_key, "messages": history}


# --- Intervention ---


@router.post("/intervention/respond")
async def respond_to_intervention(req: RespondRequest):
    """Respond to a pending intervention request."""
    delivered = intervention_manager.deliver_response(req.intervention_id, req.data)
    if not delivered:
        raise HTTPException(status_code=404, detail="Intervention not found or already resolved")
    return {"delivered": True}


@router.get("/intervention/pending")
async def list_pending_interventions():
    """List all pending intervention requests."""
    return {"pending": intervention_manager.list_pending()}
