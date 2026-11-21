"""Task deletion and archival use the same registered Git workspace cleanup."""

import asyncio

from fastapi import HTTPException

from api.task_context import _project, _run_db
from services.git.command import GitError
from services.git.task_workspace import TaskGitWorkspace
from services.task_owned_storage import task_artifact_root
from services.task_queries import task_workspace_state


async def clean_task_workspaces(pid, task_id, choice, *, force=False, operation="deleted"):
    from api.git import git_service

    project = _project(pid)
    task = await _run_db(pid, lambda: task_workspace_state(task_id))
    if task is None:
        raise HTTPException(404, "Task not found")
    if task["has_active_execution"] or task["status"] == "queued":
        raise HTTPException(409, f"Running tasks cannot be {operation}")
    if choice is False:
        return
    workflow_id = task["workflow_id"]

    def occupied_roots():
        artifacts = task_artifact_root(project.workstep_dir, workflow_id, task_id)
        legacy = project.workstep_dir / "worktrees"
        roots = [legacy / task_id, artifacts / ".worktrees"]
        if legacy.is_symlink() or any(root.is_symlink() for root in roots):
            raise ValueError("Task workspace directories cannot be symbolic links")
        return [root for root in roots if root.is_dir() and any(root.iterdir())]

    try:
        roots = await asyncio.to_thread(occupied_roots)
        if roots and choice is None:
            raise HTTPException(409, "Please choose whether to delete the task Git workspace.")
        if roots:
            from api.fs_paths import _assert_preview_path
            await asyncio.to_thread(_assert_preview_path, project.path)
        workspace = TaskGitWorkspace(git_service, workflow_id)
        for _ in roots:
            result = await workspace.delete(project.path, task_id, force=force)
            if result["outcome"] == "partial":
                raise GitError("Git workspace only partially deleted:" + result["failure"], 409)
    except GitError as exc:
        raise HTTPException(exc.status, str(exc)) from exc
    except (OSError, ValueError) as exc:
        raise HTTPException(409, str(exc)) from exc
