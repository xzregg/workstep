"""HTTP API for the ephemeral task-creation assistant."""

from fastapi import APIRouter, Header, HTTPException, Query

from schemas.base import BaseSchema


router = APIRouter(prefix="/api/task-draft")


class TaskDraftChatRequest(BaseSchema):
    project_id: str
    content: str
    title: str
    description: str | None = None
    session_id: str | None = None
    workflow_id: str | None = None
    start_step_key: str | None = None
    engine: str | None = None
    model: str | None = None
    fast_model: str | None = None
    vision_model: str | None = None
    provider_id: str | None = None
    thinking_effort: str | None = None
    instruction: str | None = None
    candidate_workflow_ids: list[str] | None = None
    allow_generate_title: bool = False


@router.post("/chat")
async def task_draft_chat(
    req: TaskDraftChatRequest,
    idempotency_key: str = Header(..., alias="Idempotency-Key"),
):
    from main import task_draft_module

    if not task_draft_module:
        raise HTTPException(status_code=503, detail="Task creation is not initialized")
    try:
        accepted = task_draft_module.submit_message(
            req.project_id,
            req.session_id,
            req.content,
            idempotency_key,
            title=req.title,
            description=req.description,
            workflow_id=req.workflow_id,
            start_step_key=req.start_step_key,
            engine=req.engine,
            model=req.model,
            fast_model=req.fast_model,
            vision_model=req.vision_model,
            provider_id=req.provider_id,
            thinking_effort=req.thinking_effort,
            instruction=req.instruction,
            candidate_workflow_ids=req.candidate_workflow_ids,
            allow_generate_title=req.allow_generate_title,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return accepted.to_dict()


@router.post("/{session_id}/stop")
async def stop_task_draft(session_id: str, project_id: str | None = Query(None)):
    from main import task_draft_module

    if not task_draft_module:
        raise HTTPException(status_code=503, detail="Task creation is not initialized")
    return {"stopped": await task_draft_module.stop_current(session_id)}
