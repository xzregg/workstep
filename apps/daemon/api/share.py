"""Task share API routes — create, fetch, verify, and revoke share links."""

import asyncio
import json
import logging

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse

from api.fs import (
    UploadFileRequest,
    UploadImageRequest,
    _serve_upload_file,
    upload_file,
    upload_image,
)
from schemas.base import BaseSchema
from services import share as share_service
from services.config import config_store
from services.intervention import intervention_manager

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/task-share", tags=["task-share"])


class CreateShareRequest(BaseSchema):
    password: str | None = None
    title: str | None = None
    mode: str = "read_only"


class VerifyShareRequest(BaseSchema):
    password: str = ""


class ShareStageMessageRequest(BaseSchema):
    content: str


class ShareReviewDecisionRequest(BaseSchema):
    review_run_id: str
    comment: str | None = None


class ShareInteractionResponseRequest(BaseSchema):
    intervention_id: str
    data: dict


def _require_interactive_share(ctx: dict) -> None:
    if ctx.get("mode") != "interactive":
        raise HTTPException(status_code=403, detail="Share is read-only")


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
                task_id, req.password, req.title, req.mode
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
        "mode": resolved["share"].get("mode", "read_only"),
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


async def _require_share_session_token(session_token: str) -> dict:
    """Validate a session passed in a URL (needed by browser image requests)."""
    if not session_token:
        raise HTTPException(status_code=401, detail="Missing share session token")
    ctx = await asyncio.to_thread(
        share_service.resolve_share_session, session_token
    )
    if ctx is None:
        raise HTTPException(status_code=401, detail="Invalid or expired share session")
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


@router.get("/public/{token}/execution-report")
async def public_share_execution_report(token: str, request: Request):
    """Return the shared task's execution analysis for either share mode."""
    ctx = await _require_share_session(request)
    if ctx["token"] != token:
        raise HTTPException(status_code=403, detail="Session does not match share")
    from main import project_manager
    from services.task_execution_report import build_task_execution_report

    pricing = await asyncio.to_thread(config_store.get_model_pricing)
    report = await project_manager.run_db(
        ctx["project_id"],
        lambda _project: build_task_execution_report(
            ctx["task_id"],
            pricing=pricing,
        ),
    )
    if report is None:
        raise HTTPException(status_code=404, detail="Task not found")
    return report


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
            ctx["task_id"], limit=limit, offset=offset, mode=ctx.get("mode", "read_only")
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


@router.get("/public/{token}/reviews")
async def public_share_reviews(token: str, request: Request):
    """List review history for the shared task."""
    ctx = await _require_share_session(request)
    if ctx["token"] != token:
        raise HTTPException(status_code=403, detail="Session does not match share")
    from main import project_manager
    from models import ReviewRun

    def load_reviews():
        rows = (
            ReviewRun.select()
            .where(ReviewRun.task == ctx["task_id"])
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
            "decision_comment": row.decision_comment,
            "reviewer_id": row.reviewer_id,
            "reviewer_name": row.reviewer_name,
            "reviewer_device_id": row.reviewer_device_id,
            "reviewer_device_name": row.reviewer_device_name,
            "started_at": row.started_at,
            "ended_at": row.ended_at,
        } for row in rows]

    return {"reviews": await project_manager.run_db(ctx["project_id"], lambda _project: load_reviews())}


@router.post("/public/{token}/upload/image")
async def public_share_upload_image(
    token: str,
    req: UploadImageRequest,
    request: Request,
):
    """Upload an image from an interactive share into the shared project."""
    ctx = await _require_share_session(request)
    if ctx["token"] != token:
        raise HTTPException(status_code=403, detail="Session does not match share")
    _require_interactive_share(ctx)
    return await upload_image(req, ctx["project_id"])


@router.post("/public/{token}/upload/file")
async def public_share_upload_file(
    token: str,
    req: UploadFileRequest,
    request: Request,
):
    """Upload a file from an interactive share into the shared project."""
    ctx = await _require_share_session(request)
    if ctx["token"] != token:
        raise HTTPException(status_code=403, detail="Session does not match share")
    _require_interactive_share(ctx)
    return await upload_file(req, ctx["project_id"])


@router.get("/public/{token}/uploads/{filename}", response_class=FileResponse)
async def public_share_upload_asset(
    token: str,
    filename: str,
    session: str = Query(...),
):
    """Serve a project upload only to a valid session for this share."""
    ctx = await _require_share_session_token(session)
    if ctx["token"] != token:
        raise HTTPException(status_code=403, detail="Session does not match share")
    from main import project_manager

    project = project_manager.get_project_by_id(ctx["project_id"])
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    response = await asyncio.to_thread(
        _serve_upload_file,
        project.workstep_dir / "uploads",
        filename,
    )
    response.headers["Content-Security-Policy"] = "sandbox"
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


@router.post("/public/{token}/steps/{step_key}/message")
async def public_share_send_stage_message(
    token: str,
    step_key: str,
    req: ShareStageMessageRequest,
    request: Request,
):
    """Inject a message into a running stage from an interactive share."""
    ctx = await _require_share_session(request)
    if ctx["token"] != token:
        raise HTTPException(status_code=403, detail="Session does not match share")
    _require_interactive_share(ctx)
    from main import workflow_runtime
    if not workflow_runtime:
        raise HTTPException(status_code=503, detail="Workflow runtime not initialized")
    try:
        return await workflow_runtime.send_stage_message(
            ctx["project_id"],
            ctx["task_id"],
            step_key,
            req.content,
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/public/{token}/steps/{step_key}/resume")
async def public_share_resume_stage(
    token: str,
    step_key: str,
    req: ShareStageMessageRequest,
    request: Request,
):
    """Persist a follow-up message and re-run a resumable stage."""
    ctx = await _require_share_session(request)
    if ctx["token"] != token:
        raise HTTPException(status_code=403, detail="Session does not match share")
    _require_interactive_share(ctx)
    from main import workflow_runtime
    if not workflow_runtime:
        raise HTTPException(status_code=503, detail="Workflow runtime not initialized")
    try:
        return await workflow_runtime.resume_stage_with_message(
            ctx["project_id"],
            ctx["task_id"],
            step_key,
            req.content,
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/public/{token}/steps/{step_key}/cancel")
async def public_share_cancel_stage(
    token: str,
    step_key: str,
    request: Request,
):
    """Stop a running stage from an interactive share."""
    ctx = await _require_share_session(request)
    if ctx["token"] != token:
        raise HTTPException(status_code=403, detail="Session does not match share")
    _require_interactive_share(ctx)
    from main import workflow_runtime
    if not workflow_runtime:
        raise HTTPException(status_code=503, detail="Workflow runtime not initialized")
    try:
        cancelled = await workflow_runtime.cancel_step(
            ctx["project_id"],
            ctx["task_id"],
            step_key,
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"cancelled": cancelled}


@router.post("/public/{token}/steps/{step_key}/review/{decision}")
async def public_share_review_decision(
    token: str,
    step_key: str,
    decision: str,
    req: ShareReviewDecisionRequest,
    request: Request,
):
    """Approve, reject, or force-approve a pending manual review."""
    ctx = await _require_share_session(request)
    if ctx["token"] != token:
        raise HTTPException(status_code=403, detail="Session does not match share")
    _require_interactive_share(ctx)
    normalized = decision.replace("-", "_")
    if normalized not in {"approve", "reject", "force_approve"}:
        raise HTTPException(status_code=404, detail="Unknown review decision")
    from main import workflow_runtime
    if not workflow_runtime:
        raise HTTPException(status_code=503, detail="Service not initialized")
    try:
        handle = await workflow_runtime.decide_review(
            ctx["project_id"],
            ctx["task_id"],
            step_key,
            req.review_run_id,
            normalized,
            req.comment,
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {
        "decision": normalized,
        "resumed": handle is not None,
        "run_id": handle.id if handle else None,
    }


@router.post("/public/{token}/intervention/respond")
async def public_share_respond_interaction(
    token: str,
    req: ShareInteractionResponseRequest,
    request: Request,
):
    """Respond to a pending engine interaction from an interactive share."""
    ctx = await _require_share_session(request)
    if ctx["token"] != token:
        raise HTTPException(status_code=403, detail="Session does not match share")
    _require_interactive_share(ctx)
    delivered = intervention_manager.deliver_response(
        req.intervention_id,
        req.data,
        ctx["task_id"],
    )
    if not delivered:
        raise HTTPException(status_code=404, detail="Intervention not found or already resolved")
    return {"delivered": True}
