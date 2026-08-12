"""Workflow generation chat API — AI-assisted workflow design sessions.

Sessions are memory-only: no task rows, no DB writes. Events stream over
the global WebSocket with ``session_id`` (no ``task_id``).
"""

from fastapi import APIRouter, Header, HTTPException, Query
from schemas.base import BaseSchema

router = APIRouter(prefix="/api/workflow/generate")


class WorkflowGenChatRequest(BaseSchema):
    project_id: str
    content: str
    session_id: str | None = None
    engine: str | None = None
    model: str | None = None
    fast_model: str | None = None
    thinking_effort: str | None = None
    steps: dict | None = None
    workflow_name: str | None = None
    context_mode: str = "none"
    workflow_id: str | None = None


@router.get("/history")
async def workflow_gen_history(
    project_id: str = Query(..., alias="project_id"),
    workflow_id: str = Query(..., alias="workflow_id"),
):
    """Return the stable conversation for a workflow (empty when none yet)."""
    from main import workflow_gen_module

    if not workflow_gen_module:
        raise HTTPException(
            status_code=503,
            detail="Workflow generation is not initialized",
        )
    return workflow_gen_module.history(project_id, workflow_id)


@router.delete("/history")
async def reset_workflow_gen_history(
    project_id: str = Query(..., alias="project_id"),
    workflow_id: str = Query(..., alias="workflow_id"),
):
    """Reset the stable AI editing conversation for a workflow."""
    from main import workflow_gen_module

    if not workflow_gen_module:
        raise HTTPException(
            status_code=503,
            detail="Workflow generation is not initialized",
        )
    try:
        reset = workflow_gen_module.reset_session(project_id, workflow_id)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {
        "reset": reset,
        "session_id": f"wf:{project_id}:{workflow_id}",
    }


@router.post("/chat")
async def workflow_gen_chat(
    req: WorkflowGenChatRequest,
    idempotency_key: str = Header(..., alias="Idempotency-Key"),
):
    """Queue one generation turn for an in-memory workflow design session."""
    from main import workflow_gen_module

    if not workflow_gen_module:
        raise HTTPException(
            status_code=503,
            detail="Workflow generation is not initialized",
        )
    try:
        accepted = workflow_gen_module.submit_message(
            req.project_id,
            req.session_id,
            req.content,
            idempotency_key,
            engine=req.engine,
            model=req.model,
            fast_model=req.fast_model,
            thinking_effort=req.thinking_effort,
            steps=req.steps,
            workflow_name=req.workflow_name,
            context_mode=req.context_mode,
            workflow_id=req.workflow_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return accepted.to_dict()


@router.post("/{session_id}/stop")
async def stop_workflow_gen(session_id: str):
    """Stop the currently running workflow-generation turn."""
    from main import workflow_gen_module

    if not workflow_gen_module:
        raise HTTPException(
            status_code=503,
            detail="Workflow generation is not initialized",
        )
    return {"stopped": await workflow_gen_module.stop_current(session_id)}
