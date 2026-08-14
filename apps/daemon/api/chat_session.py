"""HTTP API for Codex-style session chats (per project, multiple sessions).

Sessions are created explicitly and survive daemon restarts through the
``chat_sessions`` / ``chat_messages`` tables. Live events stream over the
global WebSocket keyed by ``session_id`` on the ``session_chat`` channel.
"""

from fastapi import APIRouter, Body, Header, HTTPException, Query

from schemas.base import BaseSchema

router = APIRouter(prefix="/api/chat-sessions", tags=["会话聊天"])


class ChatSessionCreateRequest(BaseSchema):
    project_id: str
    workflow_id: str | None = None
    title: str | None = None
    engine: str | None = None
    model: str | None = None
    fast_model: str | None = None
    provider_id: str | None = None
    permission_mode: str | None = None


class ChatSessionRenameRequest(BaseSchema):
    project_id: str
    title: str


class ChatMessageRequest(BaseSchema):
    project_id: str
    content: str
    engine: str | None = None
    model: str | None = None
    fast_model: str | None = None
    provider_id: str | None = None
    thinking_effort: str | None = None
    permission_mode: str | None = None
    plan_mode: bool | None = None


class SystemPromptRequest(BaseSchema):
    project_id: str
    prompt: str


class EnhancePromptRequest(BaseSchema):
    project_id: str
    prompt: str


class QuickButtonItem(BaseSchema):
    id: str | None = None
    label: str
    prompt: str


class QuickButtonsRequest(BaseSchema):
    project_id: str
    buttons: list[QuickButtonItem]


def _module():
    from main import chat_session_module

    if not chat_session_module:
        raise HTTPException(
            status_code=503,
            detail="Chat sessions are not initialized",
        )
    return chat_session_module


def _error_status(exc: ValueError) -> int:
    message = str(exc)
    if "not found" in message:
        return 404
    if "running" in message:
        return 409
    return 400


@router.get("/quick-buttons")
async def get_quick_buttons(project_id: str = Query(..., alias="project_id")):
    """Return the per-project chat quick buttons (defaults when unset)."""
    return {"buttons": _module().get_quick_buttons(project_id)}


@router.put("/quick-buttons")
async def set_quick_buttons(req: QuickButtonsRequest):
    """Persist the per-project chat quick buttons."""
    try:
        buttons = _module().set_quick_buttons(
            req.project_id,
            [item.model_dump() for item in req.buttons],
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"buttons": buttons}


@router.get("/system-prompt")
async def get_system_prompt(project_id: str = Query(..., alias="project_id")):
    """Return the project's configured chat system prompt (default when unset)."""
    return {"prompt": _module().get_system_prompt(project_id)}


@router.put("/system-prompt")
async def set_system_prompt(req: SystemPromptRequest):
    """Persist the project's chat system prompt; empty restores the default."""
    try:
        prompt = _module().set_system_prompt(req.project_id, req.prompt)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"prompt": prompt}


@router.post("/enhance-prompt")
async def enhance_prompt(req: EnhancePromptRequest):
    """Rewrite a draft prompt into a clearer version (default chat engine)."""
    try:
        prompt = await _module().enhance_prompt(req.project_id, req.prompt)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"prompt": prompt}


@router.get("")
async def list_sessions(
    project_id: str = Query(..., alias="project_id"),
    workflow_id: str | None = Query(None, alias="workflow_id"),
):
    """List all chat sessions of a project (newest first)."""
    try:
        sessions = _module().list_sessions(project_id, workflow_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"sessions": sessions}


@router.post("")
async def create_session(req: ChatSessionCreateRequest):
    """Create one chat session for a project."""
    try:
        session = _module().create_session(
            req.project_id,
            req.workflow_id,
            title=req.title,
            engine=req.engine,
            model=req.model,
            fast_model=req.fast_model,
            provider_id=req.provider_id,
            permission_mode=req.permission_mode,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return session


@router.get("/{session_id}")
async def get_session(
    session_id: str,
    project_id: str = Query(..., alias="project_id"),
):
    """Return one chat session with its full message history."""
    session = _module().get_session(project_id, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Chat session not found")
    return session


@router.patch("/{session_id}")
async def rename_session(
    session_id: str,
    req: ChatSessionRenameRequest,
):
    """Rename one chat session."""
    try:
        session = _module().rename_session(req.project_id, session_id, req.title)
    except ValueError as exc:
        raise HTTPException(status_code=_error_status(exc), detail=str(exc)) from exc
    if session is None:
        raise HTTPException(status_code=404, detail="Chat session not found")
    return session


@router.delete("/{session_id}")
async def delete_session(
    session_id: str,
    project_id: str = Query(..., alias="project_id"),
):
    """Delete one chat session and all of its messages."""
    try:
        deleted = _module().delete_session(project_id, session_id)
    except ValueError as exc:
        raise HTTPException(status_code=_error_status(exc), detail=str(exc)) from exc
    if not deleted:
        raise HTTPException(status_code=404, detail="Chat session not found")
    return {"deleted": True}


@router.post("/{session_id}/chat")
async def chat_message(
    session_id: str,
    req: ChatMessageRequest,
    idempotency_key: str = Header(..., alias="Idempotency-Key"),
):
    """Queue one chat turn for a session; events stream over WebSocket."""
    try:
        accepted = _module().submit_message(
            req.project_id,
            session_id,
            req.content,
            idempotency_key,
            engine=req.engine,
            model=req.model,
            fast_model=req.fast_model,
            provider_id=req.provider_id,
            thinking_effort=req.thinking_effort,
            permission_mode=req.permission_mode,
            plan_mode=req.plan_mode,
        )
    except ValueError as exc:
        raise HTTPException(status_code=_error_status(exc), detail=str(exc)) from exc
    return accepted.to_dict()


@router.post("/reorder")
async def reorder_sessions(
    pid: str = Query(..., alias="project_id"),
    ordered_ids: list[str] = Body(..., embed=True),
):
    """Persist a new display order for a project's chat sessions."""
    try:
        _module().reorder_sessions(pid, ordered_ids)
    except ValueError as exc:
        raise HTTPException(status_code=_error_status(exc), detail=str(exc)) from exc
    return {"ok": True}


@router.post("/{session_id}/stop")
async def stop_session(session_id: str, project_id: str | None = Query(None)):
    """Stop the running turn of one chat session."""
    return {"stopped": await _module().stop_current(session_id)}
