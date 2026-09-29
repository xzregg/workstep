"""Task-scoped read projection for Gateway public sharing."""

import asyncio
import hashlib
import json
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from api.task_context import _run_db

router = APIRouter(prefix="/api/platform-share")
_ARTIFACT_ID = re.compile(r"[0-9a-f]{64}\Z")
_MESSAGE_ID = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")
_STEP_KEY = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")


class ShareStepMessage(BaseModel):
    content: str = Field(min_length=1, max_length=65536)


class ShareReviewDecision(BaseModel):
    review_run_id: str = Field(min_length=1, max_length=128)
    comment: str | None = Field(default=None, max_length=4096)


class ShareInterventionResponse(BaseModel):
    data: dict


def _share_scope(request: Request) -> dict:
    scope = request.scope.get("gateway_share_scope")
    if not isinstance(scope, dict):
        raise HTTPException(status_code=403, detail="Gateway share ticket required")
    return scope


def _interactive_share_scope(request: Request) -> dict:
    scope = _share_scope(request)
    if scope.get("mode") != "interactive":
        raise HTTPException(status_code=403, detail="Share is read-only")
    return scope


def _interactive_scope(request: Request, step_key: str) -> dict:
    scope = _interactive_share_scope(request)
    if not _STEP_KEY.fullmatch(step_key):
        raise HTTPException(status_code=404, detail="Step unavailable")
    return scope


@router.get("/interventions")
async def read_platform_share_interventions(request: Request):
    scope = _interactive_share_scope(request)
    from services.intervention import intervention_manager
    return {"interventions": intervention_manager.list_pending_for_task(scope["task_id"])}


@router.post("/interventions/{interaction_id}/respond")
async def respond_platform_share_intervention(request: Request, interaction_id: str,
                                              body: ShareInterventionResponse):
    scope = _interactive_share_scope(request)
    if not _MESSAGE_ID.fullmatch(interaction_id):
        raise HTTPException(status_code=404, detail="Interaction unavailable")
    from services.intervention import intervention_manager
    delivered = intervention_manager.deliver_response(
        interaction_id, body.data, scope["task_id"],
    )
    if not delivered:
        raise HTTPException(status_code=404, detail="Interaction unavailable")
    return {"delivered": True}


def _task_artifacts(project, task_id: str) -> list[tuple[dict, Path]]:
    from services.artifacts import list_task_artifacts

    root = (Path(project.workstep_dir) / "artifacts").resolve()
    result = []
    for artifact in list_task_artifacts(project, task_id):
        if artifact["is_dir"]:
            continue
        path = Path(artifact["path"])
        try:
            relative = path.relative_to(root)
        except ValueError:
            continue
        if len(relative.parts) < 4 or relative.parts[1] != task_id:
            continue
        if any(parent.is_symlink() for parent in (root / relative.parts[0],
                                                   root / relative.parts[0] / task_id,
                                                   *[root.joinpath(*relative.parts[:i])
                                                     for i in range(3, len(relative.parts) + 1)])):
            continue
        artifact_id = hashlib.sha256(relative.as_posix().encode()).hexdigest()
        public = {key: artifact.get(key) for key in (
            "step_key", "round", "is_latest", "is_selected", "manifest_status",
            "eligible_for_downstream", "name", "logical_name", "artifact_type",
            "output_port", "declared_output", "relative_path", "size", "updated_at",
        )}
        public["id"] = artifact_id
        result.append((public, path))
    return result


@router.get("/artifacts")
async def read_platform_share_artifacts(request: Request):
    scope = _share_scope(request)
    from main import project_manager
    if project_manager is None:
        raise HTTPException(status_code=503, detail="Service not initialized")
    artifacts = await project_manager.run_db(
        scope["host_project_id"],
        lambda project: [public for public, _ in _task_artifacts(project, scope["task_id"])],
    )
    return {"artifacts": artifacts}


@router.get("/artifacts/{artifact_id}/content")
async def read_platform_share_artifact_content(request: Request, artifact_id: str):
    scope = _share_scope(request)
    path = await _share_artifact_path(scope, artifact_id)
    return FileResponse(path, media_type="application/octet-stream",
                        filename=Path(path).name,
                        content_disposition_type="attachment")


async def _share_artifact_path(scope: dict, artifact_id: str) -> str:
    if not _ARTIFACT_ID.fullmatch(artifact_id):
        raise HTTPException(status_code=404, detail="Artifact unavailable")
    from main import project_manager
    if project_manager is None:
        raise HTTPException(status_code=503, detail="Service not initialized")

    def find(project):
        return next((str(path) for public, path in _task_artifacts(project, scope["task_id"])
                     if public["id"] == artifact_id), None)

    path = await project_manager.run_db(scope["host_project_id"], find)
    if path is None:
        raise HTTPException(status_code=404, detail="Artifact unavailable")
    return path


@router.get("/artifacts/{artifact_id}/preview")
async def read_platform_share_artifact_preview(request: Request, artifact_id: str):
    scope = _share_scope(request)
    path = await _share_artifact_path(scope, artifact_id)
    from api import fs as fs_api
    try:
        preview = await asyncio.to_thread(
            fs_api._preview_file_sync, path, scope["host_project_id"], True,
        )
    except HTTPException as exc:
        if exc.status_code == 413:
            raise HTTPException(status_code=413, detail="Artifact too large to preview") from exc
        raise HTTPException(status_code=404, detail="Artifact preview unavailable") from exc
    return {key: preview[key] for key in (
        "type", "content_type", "content", "file_size", "extension",
    )}


@router.get("/task")
async def read_platform_share_task(request: Request):
    scope = _share_scope(request)
    from main import task_service
    if task_service is None:
        raise HTTPException(status_code=503, detail="Service not initialized")
    task = await _run_db(
        scope["host_project_id"],
        lambda: task_service.get_task(scope["task_id"]),
    )
    if task is None or task.get("id") != scope["task_id"]:
        raise HTTPException(status_code=404, detail="Task unavailable")
    public = {key: task.get(key) for key in (
        "id", "title", "description", "status", "created_at", "updated_at",
        "creator_name",
    )}
    public["steps"] = [
        {key: step.get(key) for key in ("step_key", "status", "has_history")}
        for step in task.get("steps", [])
    ]
    return public


@router.post("/steps/{step_key}/message")
async def send_platform_share_step_message(request: Request, step_key: str,
                                           body: ShareStepMessage):
    scope = _interactive_scope(request, step_key)
    from main import workflow_runtime
    if workflow_runtime is None:
        raise HTTPException(status_code=503, detail="Workflow runtime unavailable")
    try:
        return await workflow_runtime.send_step_message(
            scope["host_project_id"], scope["task_id"], step_key, body.content,
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/steps/{step_key}/resume")
async def resume_platform_share_step(request: Request, step_key: str,
                                     body: ShareStepMessage):
    scope = _interactive_scope(request, step_key)
    from main import workflow_runtime
    if workflow_runtime is None:
        raise HTTPException(status_code=503, detail="Workflow runtime unavailable")
    try:
        return await workflow_runtime.resume_step_with_message(
            scope["host_project_id"], scope["task_id"], step_key, body.content,
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/steps/{step_key}/cancel")
async def cancel_platform_share_step(request: Request, step_key: str):
    scope = _interactive_scope(request, step_key)
    from main import workflow_runtime
    if workflow_runtime is None:
        raise HTTPException(status_code=503, detail="Workflow runtime unavailable")
    try:
        cancelled = await workflow_runtime.cancel_step(
            scope["host_project_id"], scope["task_id"], step_key,
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"cancelled": cancelled}


@router.get("/reviews")
async def read_platform_share_reviews(request: Request):
    scope = _share_scope(request)
    from main import project_manager
    from models import ReviewRun

    if project_manager is None:
        raise HTTPException(status_code=503, detail="Service not initialized")

    def load(_project):
        rows = list(ReviewRun.select(
            ReviewRun.id, ReviewRun.step_key, ReviewRun.report_json,
            ReviewRun.started_at,
        ).where(
            (ReviewRun.task == scope["task_id"])
            & (ReviewRun.mode == "manual")
            & (ReviewRun.status == "pending")
        ).order_by(ReviewRun.started_at.desc(), ReviewRun.id.desc()).limit(100))
        return [{"id": row.id, "step_key": row.step_key,
                 "report": json.loads(row.report_json) if row.report_json else None,
                 "started_at": row.started_at} for row in rows]

    return {"reviews": await project_manager.run_db(scope["host_project_id"], load)}


@router.post("/steps/{step_key}/review/{decision}")
async def decide_platform_share_review(request: Request, step_key: str,
                                       decision: str, body: ShareReviewDecision):
    scope = _interactive_scope(request, step_key)
    if decision not in {"approve", "reject", "force_approve", "terminate", "complete_task"}:
        raise HTTPException(status_code=404, detail="Review decision unavailable")
    if not _MESSAGE_ID.fullmatch(body.review_run_id):
        raise HTTPException(status_code=404, detail="Review unavailable")
    from main import project_manager, workflow_runtime
    from models import ReviewRun

    if project_manager is None or workflow_runtime is None:
        raise HTTPException(status_code=503, detail="Workflow runtime unavailable")

    def review_exists(_project):
        return ReviewRun.select(ReviewRun.id).where(
            (ReviewRun.id == body.review_run_id)
            & (ReviewRun.task == scope["task_id"])
            & (ReviewRun.step_key == step_key)
            & (ReviewRun.mode == "manual")
            & (ReviewRun.status == "pending")
        ).exists()

    if not await project_manager.run_db(scope["host_project_id"], review_exists):
        raise HTTPException(status_code=404, detail="Review unavailable")
    try:
        handle = await workflow_runtime.decide_review(
            scope["host_project_id"], scope["task_id"], step_key,
            body.review_run_id, decision, body.comment,
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"decision": decision, "resumed": handle is not None,
            "run_id": handle.id if handle else None}


@router.get("/history")
async def read_platform_share_history(request: Request):
    return await _history_page(request, 0)


@router.get("/history/{offset}")
async def read_platform_share_history_page(request: Request, offset: int):
    if not 0 <= offset <= 999999:
        raise HTTPException(status_code=404, detail="History page unavailable")
    return await _history_page(request, offset)


async def _history_page(request: Request, offset: int):
    scope = _share_scope(request)
    from models import Message

    def load(_project):
        rows = list(Message.select(
            Message.id, Message.role, Message.content, Message.step_key,
            Message.run_status, Message.created_at,
        ).where(
            (Message.task == scope["task_id"])
            & (Message.channel == "execution")
        ).order_by(Message.sequence.desc(), Message.created_at.desc()).limit(101).offset(offset))
        has_more = len(rows) > 100
        messages = [{
            "id": message.id, "role": message.role,
            "content": (message.content or "")[:65536],
            "truncated": len(message.content or "") > 65536,
            "step_key": message.step_key, "run_status": message.run_status,
            "created_at": message.created_at,
        } for message in reversed(rows[:100])]
        return {"messages": messages, "next_offset": offset + 100 if has_more else None}

    from main import project_manager
    if project_manager is None:
        raise HTTPException(status_code=503, detail="Service not initialized")
    return await project_manager.run_db(scope["host_project_id"], load)


@router.get("/events/{message_id}/{cursor}")
async def read_platform_share_events(request: Request, message_id: str, cursor: int):
    scope = _share_scope(request)
    if not _MESSAGE_ID.fullmatch(message_id) or not 0 <= cursor <= 999999999:
        raise HTTPException(status_code=404, detail="Message events unavailable")
    from main import project_manager
    from models import Message
    from services.history import get_message_events
    from services.share import _scrub_events

    if project_manager is None:
        raise HTTPException(status_code=503, detail="Service not initialized")

    def load(project):
        message = Message.get_or_none(
            (Message.id == message_id)
            & (Message.task == scope["task_id"])
            & (Message.channel == "execution")
        )
        if message is None:
            raise HTTPException(status_code=404, detail="Message events unavailable")
        page = get_message_events(
            scope["task_id"], message_id, project.workstep_dir,
            cursor=cursor, limit=100,
        )
        page["events"] = _scrub_events(page["events"], mode=scope["mode"])
        return page

    return await project_manager.run_db(scope["host_project_id"], load)
