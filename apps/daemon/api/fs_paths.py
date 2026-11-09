"""Project-scoped path resolution for file APIs."""

from pathlib import Path

from fastapi import HTTPException
from settings import settings
from services.remote_access import get_current_actor


def _file_access_root() -> Path | None:
    """Configured root for user-facing file operations; call in an I/O worker."""
    from services.config import config_store
    if not config_store.get('restrict_file_access_root', True):
        return None
    configured = config_store.get('default_project_directory', '').strip()
    return (Path(configured).expanduser() if configured else Path.home()).resolve()


def _assert_preview_path(path: Path) -> Path:
    """Enforce the configured file boundary in an I/O worker, for every actor."""
    from services.project_scope import projects_root
    from services.customization_workspace import workspace_root

    try:
        root = _file_access_root()
        target = path.resolve()
        container_root = projects_root()
        if (root is not None and not target.is_relative_to(root)
                and not target.is_relative_to(workspace_root().resolve())) or (
            container_root is not None and not target.is_relative_to(container_root)
        ):
            raise ValueError('outside preview directory')
    except (ValueError, OSError, RuntimeError):
        raise HTTPException(status_code=403, detail='File is outside the allowed preview directory')
    return target


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
    if not (path.is_relative_to(project.path.resolve()) or path.is_relative_to(project.workstep_dir.resolve())):
        raise HTTPException(status_code=403, detail="Path is outside the project")


def _resolve_project_file(
    path: str,
    project_id: str | None,
    *,
    allow_absolute: bool = False,
) -> Path:
    """Resolve file links; absolute paths never bypass the global read boundary."""
    _require_actor_project(project_id)
    actor = get_current_actor()
    if actor is not None and actor.project_id is not None:
        allow_absolute = False
    candidate = Path(path).expanduser()
    if not project_id:
        return _assert_preview_path(candidate)

    project = _project(project_id)
    project_root = project.path.resolve()
    if candidate.as_posix() == f"{settings.workstep_dir}/project.json":
        target = (project_root / candidate).resolve()
    elif not candidate.is_absolute() and candidate.parts and candidate.parts[0] == settings.workstep_dir:
        target = (project.workstep_dir / Path(*candidate.parts[1:])).resolve()
        if not target.is_relative_to(project.workstep_dir.resolve()):
            raise HTTPException(status_code=403, detail="Path is outside the project")
    else:
        target = candidate.resolve() if candidate.is_absolute() else (project_root / candidate).resolve()
    if not (allow_absolute and candidate.is_absolute()):
        _assert_project_path(target, project_id)
    return _assert_preview_path(target)


def _project_relative_path(path: Path, project_id: str | None) -> str | None:
    if not project_id:
        return None
    project = _project(project_id)
    try:
        return path.relative_to(project.path.resolve()).as_posix()
    except ValueError:
        try:
            return (Path(settings.workstep_dir) / path.relative_to(project.workstep_dir.resolve())).as_posix()
        except ValueError:
            return None
