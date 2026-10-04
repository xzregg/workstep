"""Task-scoped read projection for Gateway public sharing."""

import asyncio
import hashlib
import json
import re
import uuid
from pathlib import Path, PureWindowsPath
from urllib.parse import unquote

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, field_validator

from api.task_context import _run_db

router = APIRouter(prefix="/api/platform-share")
_ARTIFACT_ID = re.compile(r"[0-9a-f]{64}\Z")
_MESSAGE_ID = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")
_STEP_KEY = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")
_UPLOAD_NAME = re.compile(r"t[0-9a-f]{24}-[0-9a-f]{32}\.[a-z0-9]{1,10}\Z")
_GIT_TREE_ID = re.compile(r"[0-9a-f]{24}\Z")


class ShareStepMessage(BaseModel):
    content: str = Field(min_length=1, max_length=65536)


class ShareReviewDecision(BaseModel):
    review_run_id: str = Field(min_length=1, max_length=128)
    comment: str | None = Field(default=None, max_length=4096)


class ShareInterventionResponse(BaseModel):
    data: dict


class ShareGitCommit(BaseModel):
    paths: list[str] = Field(min_length=1, max_length=10000)
    message: str = Field(min_length=1, max_length=100000)
    snapshot: str = Field(pattern=r"^[0-9a-f]{64}$")

    @field_validator("message")
    @classmethod
    def valid_message(cls, value: str) -> str:
        if not value.strip() or "\0" in value:
            raise ValueError("Commit message required")
        return value.strip()


class ShareGitSync(BaseModel):
    branch: str = Field(min_length=1, max_length=1024)
    snapshot: str = Field(pattern=r"^[0-9a-f]{64}$")
    remote: str | None = Field(default=None, min_length=1, max_length=1024)
    target_branch: str | None = Field(default=None, min_length=1, max_length=1024)
    set_upstream: bool = False


class ShareGitSwitch(BaseModel):
    branch: str = Field(min_length=1, max_length=1024)
    snapshot: str = Field(pattern=r"^[0-9a-f]{64}$")
    remote: str | None = Field(default=None, min_length=1, max_length=1024)


class ShareGitBranchCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    base_branch: str = Field(min_length=1, max_length=1024)
    base_head: str = Field(pattern=r"^[0-9a-f]{40,64}$")
    snapshot: str = Field(pattern=r"^[0-9a-f]{64}$")
    base_remote: str | None = Field(default=None, min_length=1, max_length=1024)


class ShareGitBranchDelete(BaseModel):
    branch: str = Field(min_length=1, max_length=1024)
    head: str = Field(pattern=r"^[0-9a-f]{40,64}$")
    snapshot: str = Field(pattern=r"^[0-9a-f]{64}$")


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


def _upload_prefix(task_id: str) -> str:
    return f"t{hashlib.sha256(task_id.encode()).hexdigest()[:24]}-"


def _safe_git_path(value: object) -> bool:
    if not isinstance(value, str) or not value or "\0" in value:
        return False
    native = Path(value)
    windows = PureWindowsPath(value)
    return not (native.is_absolute() or windows.is_absolute()
                or ".." in native.parts or ".." in windows.parts)


def _persist_share_upload(workstep_dir: Path, filename: str, content: bytes) -> None:
    root = workstep_dir.resolve()
    upload_dir = workstep_dir / "uploads"
    upload_dir.mkdir(parents=True, exist_ok=True)
    if not upload_dir.resolve().is_relative_to(root):
        raise HTTPException(status_code=403, detail="Attachment storage unavailable")
    path = upload_dir / filename
    created = False
    try:
        with path.open("xb") as output:
            created = True
            output.write(content)
    except BaseException:
        if created:
            path.unlink(missing_ok=True)
        raise


def _serve_share_upload(workstep_dir: Path, filename: str) -> FileResponse:
    from api.fs import _serve_upload_file
    upload_dir = workstep_dir / "uploads"
    if not upload_dir.resolve().is_relative_to(workstep_dir.resolve()):
        raise HTTPException(status_code=404, detail="Attachment unavailable")
    return _serve_upload_file(upload_dir, filename)


@router.post("/uploads")
async def upload_platform_share_attachment(request: Request):
    scope = _interactive_share_scope(request)
    encoded_name = request.headers.get("x-share-filename", "")
    if not encoded_name or len(encoded_name) > 512:
        raise HTTPException(status_code=422, detail="Attachment filename required")
    name = unquote(encoded_name)
    extension = Path(name).suffix.lower()
    if not re.fullmatch(r"\.[a-z0-9]{1,10}", extension):
        extension = ".bin"
    content = bytearray()
    async for chunk in request.stream():
        content.extend(chunk)
        if len(content) > 25_000_000:
            raise HTTPException(status_code=413, detail="Attachment exceeds 25 MB")
    if not content:
        raise HTTPException(status_code=422, detail="Attachment is empty")
    from main import project_manager
    from models import Task
    if project_manager is None:
        raise HTTPException(status_code=503, detail="Service not initialized")
    project = project_manager.get_project_by_id(scope["host_project_id"])
    if project is None:
        raise HTTPException(status_code=404, detail="Task unavailable")
    exists = await _run_db(scope["host_project_id"], lambda: Task.select().where(
        Task.id == scope["task_id"],
    ).exists())
    if not exists:
        raise HTTPException(status_code=404, detail="Task unavailable")
    filename = f"{_upload_prefix(scope['task_id'])}{uuid.uuid4().hex}{extension}"
    await asyncio.to_thread(_persist_share_upload, Path(project.workstep_dir),
                            filename, bytes(content))
    return {"url": f".workstep/uploads/{filename}", "filename": filename,
            "size": len(content)}


@router.get("/uploads/{filename}")
async def read_platform_share_attachment(request: Request, filename: str):
    scope = _share_scope(request)
    if not _UPLOAD_NAME.fullmatch(filename) or not filename.startswith(_upload_prefix(scope["task_id"])):
        raise HTTPException(status_code=404, detail="Attachment unavailable")
    from main import project_manager
    if project_manager is None:
        raise HTTPException(status_code=503, detail="Service not initialized")
    project = project_manager.get_project_by_id(scope["host_project_id"])
    if project is None:
        raise HTTPException(status_code=404, detail="Attachment unavailable")
    response = await asyncio.to_thread(
        _serve_share_upload, Path(project.workstep_dir), filename,
    )
    response.headers["Content-Security-Policy"] = "sandbox"
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


async def _share_git_workspace(scope: dict) -> dict:
    from api import git as git_api
    try:
        project = git_api._task_project(scope["host_project_id"])
        task = await git_api._task_exists(scope["host_project_id"], scope["task_id"])
        return await git_api.result(git_api.TaskGitWorkspace(
            git_api.git_service, task["workflow_id"],
        ).list(project.path, scope["task_id"]))
    except HTTPException as exc:
        raise HTTPException(status_code=exc.status_code, detail="Git workspace unavailable") from exc


async def _share_git_result(operation):
    from api import git as git_api
    try:
        return await git_api.result(operation)
    except HTTPException as exc:
        raise HTTPException(status_code=exc.status_code, detail="Git operation unavailable") from exc


@router.get("/git/workspace")
async def read_platform_share_git_workspace(request: Request):
    workspace = await _share_git_workspace(_share_scope(request))
    return {"path": "workspace:", "relative_path": "workspace:", "worktrees": [{
        **{key: tree.get(key) for key in ("id", "alias", "repository_name", "branch", "head")},
        "path": "workspace:" + str(tree.get("alias", "")),
        "relative_path": "workspace:" + str(tree.get("alias", "")),
        "available": True, "main": False, "locked": False, "prunable": False,
    } for tree in workspace["worktrees"] if _GIT_TREE_ID.fullmatch(str(tree.get("id", "")))]}



@router.get("/git/worktrees/{tree_id}/status")
async def read_platform_share_git_status(request: Request, tree_id: str):
    if not _GIT_TREE_ID.fullmatch(tree_id):
        raise HTTPException(status_code=404, detail="Git worktree unavailable")
    workspace = await _share_git_workspace(_share_scope(request))
    if tree_id not in {tree.get("id") for tree in workspace["worktrees"]}:
        raise HTTPException(status_code=404, detail="Git worktree unavailable")
    from api import git as git_api
    status = await _share_git_result(git_api.git_service.status(tree_id))
    files = []
    for file in status.get("files", []):
        if not _safe_git_path(file.get("path")):
            continue
        public = {key: file.get(key) for key in (
            "path", "index_status", "worktree_status", "untracked",
            "conflict", "staged", "submodule", "digest",
        )}
        public["old_path"] = file.get("old_path") if _safe_git_path(file.get("old_path")) else None
        files.append(public)
    return {**{key: status.get(key) for key in (
        "id", "head", "branch", "snapshot", "operation", "active",
        "upstream", "ahead", "behind",
    )}, "files": files}


@router.get("/git/worktrees/{tree_id}/branches")
async def read_platform_share_git_branches(request: Request, tree_id: str):
    if not _GIT_TREE_ID.fullmatch(tree_id):
        raise HTTPException(status_code=404, detail="Git worktree unavailable")
    workspace = await _share_git_workspace(_share_scope(request))
    task_tree_ids = {tree.get("id") for tree in workspace["worktrees"]}
    if tree_id not in task_tree_ids:
        raise HTTPException(status_code=404, detail="Git worktree unavailable")
    from api import git as git_api
    result = await _share_git_result(git_api.git_service.branches(tree_id))
    return _public_git_branches(result, task_tree_ids)


def _public_git_branches(result: dict, task_tree_ids: set[str]) -> dict:
    branches = []
    for branch in result.get("branches", []):
        item = {key: branch.get(key) for key in (
            "name", "head", "upstream", "remote", "ahead", "behind", "upstream_gone",
        )}
        occupied_id = branch.get("worktree_id")
        item["occupied"] = occupied_id is not None
        item["worktree_id"] = occupied_id if occupied_id in task_tree_ids else None
        branches.append(item)
    remote_branches = [{key: branch.get(key) for key in (
        "name", "remote", "branch", "head",
    )} for branch in result.get("remote_branches", [])]
    return {"branches": branches, "remote_branches": remote_branches,
            "fetched_at": result.get("fetched_at")}


async def _share_git_write_workspace(request: Request, tree_id: str) -> set[str]:
    scope = _interactive_share_scope(request)
    if not _GIT_TREE_ID.fullmatch(tree_id):
        raise HTTPException(status_code=404, detail="Git worktree unavailable")
    workspace = await _share_git_workspace(scope)
    task_tree_ids = {tree.get("id") for tree in workspace["worktrees"]}
    if tree_id not in task_tree_ids:
        raise HTTPException(status_code=404, detail="Git worktree unavailable")
    return task_tree_ids


@router.post("/git/worktrees/{tree_id}/switch")
async def switch_platform_share_git(request: Request, tree_id: str, body: ShareGitSwitch):
    await _share_git_write_workspace(request, tree_id)
    from api import git as git_api
    await _share_git_result(git_api.git_service.switch(
        tree_id, body.branch, body.snapshot, body.remote,
    ))
    return {"completed": True}


@router.post("/git/worktrees/{tree_id}/fetch")
async def fetch_platform_share_git(request: Request, tree_id: str):
    task_tree_ids = await _share_git_write_workspace(request, tree_id)
    from api import git as git_api
    result = await _share_git_result(git_api.git_service.fetch(tree_id))
    return _public_git_branches(result, task_tree_ids)


@router.post("/git/worktrees/{tree_id}/branches")
async def create_platform_share_git_branch(request: Request, tree_id: str,
                                           body: ShareGitBranchCreate):
    task_tree_ids = await _share_git_write_workspace(request, tree_id)
    from api import git as git_api
    result = await _share_git_result(git_api.git_service.create_branch(
        tree_id, body.name, body.base_branch, body.base_head,
        body.snapshot, body.base_remote,
    ))
    return _public_git_branches(result, task_tree_ids)


@router.post("/git/worktrees/{tree_id}/branches/delete")
async def delete_platform_share_git_branch(request: Request, tree_id: str,
                                           body: ShareGitBranchDelete):
    task_tree_ids = await _share_git_write_workspace(request, tree_id)
    from api import git as git_api
    result = await _share_git_result(git_api.git_service.delete_branch(
        tree_id, body.branch, body.head, body.snapshot,
    ))
    return _public_git_branches(result, task_tree_ids)


@router.post("/git/worktrees/{tree_id}/commit")
async def commit_platform_share_git(request: Request, tree_id: str, body: ShareGitCommit):
    scope = _interactive_share_scope(request)
    if not _GIT_TREE_ID.fullmatch(tree_id):
        raise HTTPException(status_code=404, detail="Git worktree unavailable")
    if len(set(body.paths)) != len(body.paths) or not all(_safe_git_path(path) for path in body.paths):
        raise HTTPException(status_code=422, detail="Invalid commit paths")
    workspace = await _share_git_workspace(scope)
    if tree_id not in {tree.get("id") for tree in workspace["worktrees"]}:
        raise HTTPException(status_code=404, detail="Git worktree unavailable")
    from api import git as git_api
    return await _share_git_result(git_api.git_service.commit(
        tree_id, body.paths, body.message, body.snapshot,
    ))


@router.post("/git/worktrees/{tree_id}/{action}")
async def sync_platform_share_git(request: Request, tree_id: str, action: str,
                                  body: ShareGitSync):
    scope = _interactive_share_scope(request)
    if not _GIT_TREE_ID.fullmatch(tree_id) or action not in {"pull", "push"}:
        raise HTTPException(status_code=404, detail="Git operation unavailable")
    workspace = await _share_git_workspace(scope)
    if tree_id not in {tree.get("id") for tree in workspace["worktrees"]}:
        raise HTTPException(status_code=404, detail="Git worktree unavailable")
    from api import git as git_api
    operation = getattr(git_api.git_service, action)
    await _share_git_result(operation(
        tree_id, body.branch, body.snapshot, body.remote, body.target_branch,
        body.set_upstream,
    ))
    return {"completed": True}


@router.get("/task")
async def read_platform_share_task(request: Request):
    scope = _share_scope(request)
    from services.share import load_shared_task
    task = await _run_db(
        scope["host_project_id"],
        lambda: load_shared_task(scope["task_id"]),
    )
    if task is None or task.get("id") != scope["task_id"]:
        raise HTTPException(status_code=404, detail="Task unavailable")
    if task.get('workflow') and isinstance(task['workflow'].get('steps'), dict):
        workflow = task['workflow']['steps']
        # Preserve graph/prompt viewing without exposing engine configuration,
        # credentials, task-dispatch target IDs or host filesystem paths.
        workflow['nodes'] = [{key: node[key] for key in (
            'id', 'key', 'type', 'title', 'label', 'color', 'prompt', 'engine', 'model', 'inputs', 'outputs',
        ) if key in node} for node in workflow.get('nodes', [])]
        workflow.pop('config', None)
    return task


@router.get('/execution-report')
async def read_platform_share_execution_report(request: Request):
    scope = _share_scope(request)
    from main import project_manager
    from services.config import config_store
    from services.task_execution_report import build_task_execution_report
    pricing = await asyncio.to_thread(config_store.get_model_pricing)
    report = await project_manager.run_db(scope['host_project_id'], lambda project:
        build_task_execution_report(scope['task_id'], pricing=pricing, project=project))
    if report is None:
        raise HTTPException(status_code=404, detail='Task unavailable')
    return report


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
            ReviewRun.started_at, ReviewRun.mode, ReviewRun.status,
        ).where(
            (ReviewRun.task == scope["task_id"])
            & (ReviewRun.mode == "manual")
            & (ReviewRun.status == "pending")
        ).order_by(ReviewRun.started_at.desc(), ReviewRun.id.desc()).limit(100))
        return [{"id": row.id, "step_key": row.step_key,
                 "report": json.loads(row.report_json) if row.report_json else None,
                 "started_at": row.started_at, "mode": row.mode, "status": row.status} for row in rows]

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
    from services.share import load_shared_history

    def load(_project):
        messages = load_shared_history(scope['task_id'], limit=101, offset=offset, mode=scope['mode'])
        has_more = len(messages) > 100
        # The loader returns chronological order; the extra row is oldest.
        messages = messages[-100:]
        for message in messages:
            content = message.get('content') or ''
            message['content'] = content[:65536]
            message['truncated'] = len(content) > 65536
            message['events'] = message.get('events', [])[-2000:]
        return {'messages': messages, 'next_offset': offset + 100 if has_more else None}

    from main import project_manager
    if project_manager is None:
        raise HTTPException(status_code=503, detail="Service not initialized")
    result = await project_manager.run_db(scope["host_project_id"], load)
    if scope['mode'] == 'interactive':
        from services.intervention import intervention_manager
        result['interventions'] = intervention_manager.list_pending_for_task(scope['task_id'])
    return result


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

from api.platform_share_git_read import router as git_read_router
# The parent router already supplies /api/platform-share.
router.include_router(git_read_router, prefix='')
