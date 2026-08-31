"""Task share API routes — create, fetch, verify, and revoke share links."""

import asyncio
import logging

from fastapi import APIRouter, HTTPException, Query, Request

from schemas.base import BaseSchema
from services import share as share_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/task-share", tags=["task-share"])


class CreateShareRequest(BaseSchema):
    password: str | None = None
    title: str | None = None


class VerifyShareRequest(BaseSchema):
    password: str = ""


@router.post("/{task_id}/create")
async def create_share(task_id: str, req: CreateShareRequest, pid: str = Query(..., alias="project_id")):
    """Create or replace the share link for a task. Password is optional."""
    if req.password and len(req.password) < 4:
        raise HTTPException(status_code=422, detail="Password must be at least 4 characters")
    try:
        from main import project_manager

        share = await project_manager.run_db(
            pid,
            lambda _project: share_service.create_share(
                task_id, req.password, req.title
            ),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return share


@router.get("/{task_id}")
async def get_share(task_id: str, pid: str = Query(..., alias="project_id")):
    """Return the active share for a task, or 404 if none exists."""
    from main import project_manager
    share = await project_manager.run_db(
        pid, lambda _project: share_service.get_share_for_task(task_id)
    )
    if share is None:
        raise HTTPException(status_code=404, detail="No active share")
    return share


@router.delete("/{task_id}")
async def revoke_share(task_id: str, pid: str = Query(..., alias="project_id")):
    """Revoke the share link for a task (if any)."""
    from main import project_manager
    revoked = await project_manager.run_db(
        pid, lambda _project: share_service.revoke_share(task_id)
    )
    return {"revoked": revoked}


@router.get("/public/{token}/meta")
async def public_share_meta(token: str):
    """Public endpoint: returns share metadata (no password hash).

    Used by the share viewer page to check whether the share exists and
    whether a password prompt is needed before unlocking.
    """
    resolved = await asyncio.to_thread(share_service.resolve_share_by_token, token)
    if resolved is None:
        raise HTTPException(status_code=404, detail="Share not found or revoked")
    return {
        "token": resolved["share"]["token"],
        "title": resolved["share"].get("title"),
        "task_id": resolved["task_id"],
        "has_password": resolved["share"].get("has_password", False),
        "created_at": resolved["share"]["created_at"],
    }


@router.post("/public/{token}/unlock")
async def public_share_unlock(token: str, req: VerifyShareRequest):
    """Verify the share password and mint a session token.

    The session token is opaque and should be sent back as the
    ``X-Share-Session`` header on subsequent share requests and as the
    ``session`` query parameter on the share WebSocket.
    """
    resolved = await asyncio.to_thread(share_service.resolve_share_by_token, token)
    if resolved is None:
        raise HTTPException(status_code=404, detail="Share not found or revoked")
    session_token = await asyncio.to_thread(
        share_service.verify_share_password, token, req.password
    )
    if session_token is None:
        raise HTTPException(status_code=401, detail="Incorrect password")
    return {"session_token": session_token}


async def _require_share_session(request: Request) -> dict:
    """Resolve and validate the ``X-Share-Session`` header. Raises 401 on miss."""
    session_token = request.headers.get("X-Share-Session")
    if not session_token:
        raise HTTPException(status_code=401, detail="Missing share session token")
    ctx = await asyncio.to_thread(
        share_service.resolve_share_session, session_token
    )
    if ctx is None:
        raise HTTPException(status_code=401, detail="Invalid or expired share session")
    # Activate the right project DB for the rest of this request.
    from main import project_manager
    if not project_manager:
        raise HTTPException(status_code=503, detail="Service not initialized")
    project = project_manager.get_project_by_id(ctx["project_id"])
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return ctx


@router.get("/public/{token}/task")
async def public_share_task(token: str, request: Request):
    """Load the shared task (read-only). Requires an unlocked session."""
    ctx = await _require_share_session(request)
    if ctx["token"] != token:
        raise HTTPException(status_code=403, detail="Session does not match share")
    from main import project_manager
    task = await project_manager.run_db(
        ctx["project_id"],
        lambda _project: share_service.load_shared_task(ctx["task_id"]),
    )
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    return task


@router.get("/public/{token}/history")
async def public_share_history(
    token: str,
    request: Request,
    limit: int = Query(200, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    """Load execution-channel message history for the shared task."""
    ctx = await _require_share_session(request)
    if ctx["token"] != token:
        raise HTTPException(status_code=403, detail="Session does not match share")
    from main import project_manager
    messages = await project_manager.run_db(
        ctx["project_id"],
        lambda _project: share_service.load_shared_history(
            ctx["task_id"], limit=limit, offset=offset
        ),
    )
    return {"messages": messages, "limit": limit, "offset": offset}


@router.get("/public/{token}/artifacts")
async def public_share_artifacts(token: str, request: Request):
    """List the shared task's produced artifacts (read-only)."""
    ctx = await _require_share_session(request)
    if ctx["token"] != token:
        raise HTTPException(status_code=403, detail="Session does not match share")
    from main import project_manager
    if not project_manager:
        raise HTTPException(status_code=503, detail="Service not initialized")
    project = project_manager.get_project_by_id(ctx["project_id"])
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    from services.artifacts import list_task_artifacts
    artifacts = await project_manager.run_db(
        ctx["project_id"],
        lambda _project: list_task_artifacts(project, ctx["task_id"]),
    )
    return {"artifacts": artifacts}
