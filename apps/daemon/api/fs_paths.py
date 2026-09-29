"""Project-scoped path resolution for file APIs."""

from pathlib import Path

from fastapi import HTTPException
from services.remote_access import get_current_actor


def _require_actor_project(project_id: str | None) -> None:
    actor = get_current_actor()
    if actor is not None and actor.project_id is not None and actor.project_id != project_id:
        raise HTTPException(status_code=403, detail="Project scope denied")


def _path_error_detail(label: str, path: object) -> str:
    actor = get_current_actor()
    return label if actor is not None and actor.project_id is not None else f"{label}: {path}"


def _project(project_id: str):
    """Resolve project paths without opening or rebinding its database."""
    from main import project_manager

    _require_actor_project(project_id)

    if not project_manager:
        raise HTTPException(status_code=503, detail="Service not initialized")
    project = project_manager.get_project_by_id(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail=f"Project not found: {project_id}")
    return project


def _assert_project_path(path: Path, project_id: str | None) -> None:
    _require_actor_project(project_id)
    if not project_id:
        return
    project = _project(project_id)
    try:
        path.relative_to(project.path.resolve())
    except ValueError as exc:
        raise HTTPException(status_code=403, detail="Path is outside the project") from exc


def _resolve_project_file(
    path: str,
    project_id: str | None,
    *,
    allow_absolute: bool = False,
) -> Path:
    """Resolve a file link, allowing project escape only for explicit absolute paths."""
    _require_actor_project(project_id)
    actor = get_current_actor()
    if actor is not None and actor.project_id is not None:
        allow_absolute = False
    candidate = Path(path).expanduser()
    if not project_id:
        return candidate.resolve()

    project = _project(project_id)
    project_root = project.path.resolve()
    target = candidate.resolve() if candidate.is_absolute() else (project_root / candidate).resolve()
    if not (allow_absolute and candidate.is_absolute()):
        _assert_project_path(target, project_id)
    return target


def _project_relative_path(path: Path, project_id: str | None) -> str | None:
    if not project_id:
        return None
    project = _project(project_id)
    try:
        return path.relative_to(project.path.resolve()).as_posix()
    except ValueError:
        return None
