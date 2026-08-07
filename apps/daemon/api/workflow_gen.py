"""Workflow generation chat API — AI-assisted workflow design sessions.

Sessions are memory-only: no task rows, no DB writes. Events stream over
the global WebSocket with ``session_id`` (no ``task_id``).
"""

from fastapi import APIRouter, Header, HTTPException
from schemas.base import BaseSchema

router = APIRouter(prefix="/api/workflow/generate")


class WorkflowGenChatRequest(BaseSchema):
    project_id: str
    content: str
    session_id: str | None = None
    engine: str | None = None
    model: str | None = None
    fast_model: str | None = None


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
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return accepted.to_dict()
