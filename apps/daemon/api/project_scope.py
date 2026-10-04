"""HTTP translation for project catalog authorization."""

from fastapi import HTTPException
from services.project_scope import require_catalog_project as _require_catalog_project


def require_catalog_project(project_id: str) -> bool:
    try:
        return _require_catalog_project(project_id)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
