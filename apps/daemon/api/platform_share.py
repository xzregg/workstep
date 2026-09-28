"""Task-scoped read projection for Gateway public sharing."""

import hashlib
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

from api.task_context import _run_db

router = APIRouter(prefix="/api/platform-share")
_ARTIFACT_ID = re.compile(r"[0-9a-f]{64}\Z")


def _share_scope(request: Request) -> dict:
    scope = request.scope.get("gateway_share_scope")
    if not isinstance(scope, dict):
        raise HTTPException(status_code=403, detail="Gateway share ticket required")
    return scope


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
    return FileResponse(path, media_type="application/octet-stream",
                        filename=Path(path).name,
                        content_disposition_type="attachment")


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
    return {key: task.get(key) for key in (
        "id", "title", "description", "status", "created_at", "updated_at",
        "creator_name",
    )}


@router.get("/history")
async def read_platform_share_history(request: Request):
    scope = _share_scope(request)
    from models import Message

    def load(_project):
        rows = list(Message.select(
            Message.id, Message.role, Message.content, Message.step_key,
            Message.run_status, Message.created_at,
        ).where(
            (Message.task == scope["task_id"])
            & (Message.channel == "execution")
        ).order_by(Message.sequence.desc(), Message.created_at.desc()).limit(100))
        return [{
            "id": message.id, "role": message.role,
            "content": (message.content or "")[:65536],
            "truncated": len(message.content or "") > 65536,
            "step_key": message.step_key, "run_status": message.run_status,
            "created_at": message.created_at,
        } for message in reversed(rows)]

    from main import project_manager
    if project_manager is None:
        raise HTTPException(status_code=503, detail="Service not initialized")
    messages = await project_manager.run_db(scope["host_project_id"], load)
    return {"messages": messages}
