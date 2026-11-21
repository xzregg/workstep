"""Storage owned by one task. Never follow a symlink into another owner."""

from pathlib import Path
import shutil


def task_artifact_root(data_dir: Path, workflow_id: str | None, task_id: str) -> Path:
    segments = (workflow_id or "default", task_id)
    if any(not isinstance(value, str) or not value or value in {".", ".."}
           or "/" in value or "\\" in value for value in segments):
        raise ValueError("Invalid task artifact directory")
    path = Path(data_dir)
    for segment in ("artifacts", *segments):
        path = path / segment
        if path.is_symlink():
            raise ValueError("Task artifact directories cannot be symbolic links")
    return path


def delete_task_artifacts(data_dir, workflow_id, task_id, *, keep_worktrees=False):
    current = task_artifact_root(data_dir, workflow_id, task_id)
    if not current.parent.parent.is_dir():
        return
    # Artifact discovery includes legacy folders under other workflow IDs.
    # A task ID is unique within the project, so reclaim every matching owner.
    roots = [current]
    for workflow in current.parent.parent.iterdir():
        if workflow == current.parent or not workflow.is_dir() or workflow.is_symlink() or workflow.name == "actions":
            continue
        candidate = workflow / task_id
        if candidate.exists() or candidate.is_symlink():
            roots.append(task_artifact_root(data_dir, workflow.name, task_id))

    for root in roots:
        worktrees = root / ".worktrees"
        if not keep_worktrees and worktrees.is_dir() and any(worktrees.iterdir()):
            raise ValueError("Remove registered Git worktrees before deleting task artifacts")
    for root in roots:
        if not root.exists():
            continue
        for entry in root.iterdir():
            if entry.name == ".worktrees" and keep_worktrees:
                continue
            if entry.is_dir() and not entry.is_symlink():
                shutil.rmtree(entry)
            else:
                entry.unlink()
        if not any(root.iterdir()):
            root.rmdir()
