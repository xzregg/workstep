"""HTTP API for Codex-style session chats (per project, multiple sessions).

Sessions are created explicitly and survive daemon restarts through the
``chat_sessions`` / ``chat_messages`` tables. Live events stream over the
global WebSocket keyed by ``session_id`` on the ``session_chat`` channel.
"""

from fastapi import APIRouter, Body, Header, HTTPException, Query
from pydantic import Field

from schemas.base import BaseSchema

router = APIRouter(prefix="/api/chat-sessions", tags=["会话聊天"])


class ChatSessionCreateRequest(BaseSchema):
    project_id: str
    workflow_id: str | None = None
    title: str | None = None
    engine: str | None = None
    model: str | None = None
    fast_model: str | None = None
    vision_model: str | None = None
    provider_id: str | None = None
    permission_mode: str | None = None


class ChatSessionRenameRequest(BaseSchema):
    project_id: str
    title: str


class ChatSessionArchiveRequest(BaseSchema):
    project_id: str
    archived: bool


class ChatSessionPermissionRequest(BaseSchema):
    project_id: str
    permission_mode: str


class ChatSessionForkRequest(BaseSchema):
    project_id: str
    title: str
    engine: str
    context_mode: str
    model: str | None = None
    fast_model: str | None = None
    vision_model: str | None = None
    provider_id: str | None = None
    permission_mode: str | None = None
    fork_message_id: str | None = None


class ChatSessionHandoffRequest(BaseSchema):
    project_id: str
    engine: str
    context_mode: str
    model: str | None = None
    fast_model: str | None = None
    vision_model: str | None = None
    provider_id: str | None = None
    permission_mode: str | None = None


class ChatMessageRequest(BaseSchema):
    project_id: str
    content: str
    engine: str | None = None
    model: str | None = None
    fast_model: str | None = None
    vision_model: str | None = None
    provider_id: str | None = None
    thinking_effort: str | None = None
    permission_mode: str | None = None
    plan_mode: bool | None = None
    goal_mode: bool | None = None


class ChatLiveMessageRequest(BaseSchema):
    project_id: str
    content: str
    pending_insert_ids: list[str] = Field(default_factory=list)


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
    content: str = ""
    kind: str = "prompt"
    immediate_send: bool = False
    action_id: str | None = None
    script_path: str | None = None
    cwd_mode: str | None = None
    require_confirmation: bool | None = None
    confirmation_input_prompt: str | None = None


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


def _enforce_project_scope(project_id: str | None) -> None:
    from services.remote_access import get_current_actor

    actor = get_current_actor()
    if actor is not None and actor.project_id is not None and actor.project_id != project_id:
        raise HTTPException(status_code=403, detail="Project scope denied")


async def _run_db(project_id: str, operation):
    from main import project_manager

    _enforce_project_scope(project_id)
    return await project_manager.run_db(
        project_id,
        lambda _project: operation(),
    )


@router.get("/quick-buttons")
async def get_quick_buttons(project_id: str = Query(..., alias="project_id")):
    """Return the per-project chat quick buttons (defaults when unset)."""
    return {
        "buttons": await _run_db(
            project_id, lambda: _module().get_quick_buttons(project_id)
        )
    }


@router.put("/quick-buttons")
async def set_quick_buttons(req: QuickButtonsRequest):
    """Persist the per-project chat quick buttons."""
    _enforce_project_scope(req.project_id)
    try:
        buttons = await _run_db(
            req.project_id,
            lambda: _module().set_quick_buttons(
                req.project_id,
                [item.model_dump() for item in req.buttons],
            ),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"buttons": buttons}


@router.get("/system-prompt")
async def get_system_prompt(project_id: str = Query(..., alias="project_id")):
    """Return the configured chat system prompt ("" if none) and the built-in default."""
    from agent_assistants.chat_session import SYSTEM_PROMPT

    return {
        "prompt": await _run_db(
            project_id, lambda: _module().get_system_prompt(project_id)
        ),
        "default_prompt": SYSTEM_PROMPT,
    }


@router.put("/system-prompt")
async def set_system_prompt(req: SystemPromptRequest):
    """Persist the project's chat system prompt; empty clears it (no system prompt)."""
    _enforce_project_scope(req.project_id)
    try:
        prompt = await _run_db(
            req.project_id,
            lambda: _module().set_system_prompt(req.project_id, req.prompt),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"prompt": prompt}


@router.post("/enhance-prompt")
async def enhance_prompt(req: EnhancePromptRequest):
    """Rewrite a draft prompt into a clearer version (default chat engine)."""
    _enforce_project_scope(req.project_id)
    try:
        prompt = await _module().enhance_prompt(req.project_id, req.prompt)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"prompt": prompt}


@router.get("")
async def list_sessions(
    project_id: str = Query(..., alias="project_id"),
    workflow_id: str | None = Query(None, alias="workflow_id"),
    archived: bool = Query(False),
):
    """List all chat sessions of a project (newest first)."""
    try:
        sessions = await _run_db(
            project_id,
            lambda: _module().list_sessions(project_id, workflow_id, archived),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"sessions": sessions}


@router.patch("/{session_id}/archive")
async def archive_session(session_id: str, req: ChatSessionArchiveRequest):
    _enforce_project_scope(req.project_id)
    try:
        return await _run_db(
            req.project_id,
            lambda: _module().set_archived(req.project_id, session_id, req.archived),
        )
    except ValueError as exc:
        raise HTTPException(status_code=_error_status(exc), detail=str(exc)) from exc


@router.post("")
async def create_session(req: ChatSessionCreateRequest):
    """Create one chat session for a project."""
    _enforce_project_scope(req.project_id)
    try:
        session = await _run_db(
            req.project_id,
            lambda: _module().create_session(
                req.project_id,
                req.workflow_id,
                title=req.title,
                engine=req.engine,
                model=req.model,
                fast_model=req.fast_model,
                vision_model=req.vision_model,
                provider_id=req.provider_id,
                permission_mode=req.permission_mode,
            ),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return session


@router.get("/{session_id}")
async def get_session(
    session_id: str,
    project_id: str = Query(..., alias="project_id"),
    limit: int = Query(300, ge=1, le=300),
    offset: int = Query(0, ge=0),
):
    """Return one chat session with a page of recent messages."""
    session = await _run_db(
        project_id, lambda: _module().get_session(project_id, session_id, limit=limit, offset=offset)
    )
    if session is None:
        raise HTTPException(status_code=404, detail="Chat session not found")
    return session


@router.get("/{session_id}/messages/{message_id}/events")
async def get_message_events(
    session_id: str,
    message_id: str,
    project_id: str = Query(..., alias="project_id"),
    cursor: int = Query(0, ge=0),
    limit: int = Query(30000, ge=1, le=30000),
):
    """Return a bounded detail page from the host-side JSONL journal."""
    try:
        return await _run_db(
            project_id,
            lambda: _module().message_events(
                project_id,
                session_id,
                message_id,
                cursor=cursor,
                limit=limit,
            ),
        )
    except ValueError as exc:
        raise HTTPException(status_code=_error_status(exc), detail=str(exc)) from exc


@router.patch("/{session_id}")
async def rename_session(
    session_id: str,
    req: ChatSessionRenameRequest,
):
    """Rename one chat session."""
    _enforce_project_scope(req.project_id)
    try:
        session = await _run_db(
            req.project_id,
            lambda: _module().rename_session(req.project_id, session_id, req.title),
        )
    except ValueError as exc:
        raise HTTPException(status_code=_error_status(exc), detail=str(exc)) from exc
    if session is None:
        raise HTTPException(status_code=404, detail="Chat session not found")
    return session


@router.patch("/{session_id}/permission-mode")
async def update_permission_mode(
    session_id: str,
    req: ChatSessionPermissionRequest,
):
    """Apply a permission mode to the current run and future turns."""
    _enforce_project_scope(req.project_id)
    try:
        return await _module().update_permission_mode(
            req.project_id,
            session_id,
            req.permission_mode,
        )
    except ValueError as exc:
        raise HTTPException(status_code=_error_status(exc), detail=str(exc)) from exc


@router.post("/{session_id}/fork")
async def fork_session(session_id: str, req: ChatSessionForkRequest):
    """Create an independent native or history-backed chat-session fork."""
    _enforce_project_scope(req.project_id)
    try:
        return await _module().fork_session(
            req.project_id,
            session_id,
            title=req.title,
            engine=req.engine,
            context_mode=req.context_mode,
            model=req.model,
            fast_model=req.fast_model,
            vision_model=req.vision_model,
            provider_id=req.provider_id,
            permission_mode=req.permission_mode,
            fork_message_id=req.fork_message_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=_error_status(exc), detail=str(exc)) from exc


@router.post("/{session_id}/handoff")
async def handoff_session(session_id: str, req: ChatSessionHandoffRequest):
    """Switch engines without creating another visible chat session."""
    _enforce_project_scope(req.project_id)
    try:
        return await _run_db(
            req.project_id,
            lambda: _module().handoff_session(
                req.project_id,
                session_id,
                engine=req.engine,
                context_mode=req.context_mode,
                model=req.model,
                fast_model=req.fast_model,
                vision_model=req.vision_model,
                provider_id=req.provider_id,
                permission_mode=req.permission_mode,
            ),
        )
    except ValueError as exc:
        raise HTTPException(status_code=_error_status(exc), detail=str(exc)) from exc


@router.delete("/{session_id}")
async def delete_session(
    session_id: str,
    project_id: str = Query(..., alias="project_id"),
):
    """Delete one chat session and all of its messages."""
    _enforce_project_scope(project_id)
    try:
        deleted = await _run_db(
            project_id, lambda: _module().delete_session(project_id, session_id)
        )
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
    _enforce_project_scope(req.project_id)
    try:
        accepted = await _run_db(
            req.project_id,
            lambda: _module().submit_message(
                req.project_id,
                session_id,
                req.content,
                idempotency_key,
                engine=req.engine,
                model=req.model,
                fast_model=req.fast_model,
                vision_model=req.vision_model,
                provider_id=req.provider_id,
                thinking_effort=req.thinking_effort,
                permission_mode=req.permission_mode,
                plan_mode=req.plan_mode,
                goal_mode=req.goal_mode,
                schedule=False,
            ),
        )
    except ValueError as exc:
        raise HTTPException(status_code=_error_status(exc), detail=str(exc)) from exc
    _module().start_queued_turn(accepted.turn_id)
    return accepted.to_dict()


@router.post("/reorder")
async def reorder_sessions(
    pid: str = Query(..., alias="project_id"),
    ordered_ids: list[str] = Body(..., embed=True),
):
    """Persist a new display order for a project's chat sessions."""
    _enforce_project_scope(pid)
    try:
        await _run_db(pid, lambda: _module().reorder_sessions(pid, ordered_ids))
    except ValueError as exc:
        raise HTTPException(status_code=_error_status(exc), detail=str(exc)) from exc
    return {"ok": True}


@router.post("/bulk-delete")
async def bulk_delete_sessions(
    pid: str = Query(..., alias="project_id"),
    session_ids: list[str] = Body(..., embed=True),
):
    """Delete multiple chat sessions; running sessions are skipped."""
    _enforce_project_scope(pid)
    try:
        result = await _run_db(
            pid, lambda: _module().bulk_delete_sessions(pid, session_ids)
        )
    except ValueError as exc:
        raise HTTPException(status_code=_error_status(exc), detail=str(exc)) from exc
    return result


@router.post("/{session_id}/stop")
async def stop_session(session_id: str, project_id: str | None = Query(None)):
    """Stop the running turn of one chat session."""
    _enforce_project_scope(project_id)
    if project_id is not None:
        from models.chat_session import ChatSession

        exists = await _run_db(project_id, lambda: ChatSession.select().where(
            ChatSession.id == session_id,
        ).exists())
        if not exists:
            raise HTTPException(status_code=404, detail="Chat session not found")
    return {"stopped": await _module().stop_current(session_id, project_id=project_id)}


@router.post("/{session_id}/live-message")
async def send_live_message(session_id: str, req: ChatLiveMessageRequest):
    """Insert a user message into the session's currently running turn."""
    _enforce_project_scope(req.project_id)
    try:
        return await _module().send_live_message(
            session_id,
            req.content,
            project_id=req.project_id,
            pending_insert_ids=req.pending_insert_ids,
        )
    except ValueError as exc:
        raise HTTPException(status_code=_error_status(exc), detail=str(exc)) from exc
