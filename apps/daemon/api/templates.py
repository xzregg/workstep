"""Workflow templates API - browse and apply templates.

Templates are managed globally in `~/.workstep/data/templates/`. On daemon
startup the shipped defaults in `data/templates/` are seeded there — files
with the same name are never overwritten.
"""

import json
import logging
import re
import shutil
from pathlib import Path

from fastapi import APIRouter, HTTPException
from schemas.base import BaseSchema
from services.config import CONFIG_DIR
from services.workflow_definition import (
    WorkflowDefinition,
    WorkflowValidationError,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/templates")

# Shipped default templates (repo seed source, read-only)
TEMPLATES_DIR = Path(__file__).parent.parent / "data" / "templates"

# Global user-writable templates — the runtime source for list/get/save/delete
GLOBAL_TEMPLATES_DIR = CONFIG_DIR / "data" / "templates"

TEMPLATE_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")


def _validate_template_id(template_id: str):
    if not TEMPLATE_ID_PATTERN.fullmatch(template_id):
        raise HTTPException(
            status_code=422,
            detail="Template id must contain only letters, numbers, '_' or '-'",
        )


def ensure_global_templates() -> None:
    """Seed ~/.workstep/data/templates/ from the shipped data/templates/.

    Existing files are never overwritten (user edits are preserved).
    """
    if not TEMPLATES_DIR.exists():
        return
    try:
        GLOBAL_TEMPLATES_DIR.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        logger.warning("Cannot create templates dir %s: %s", GLOBAL_TEMPLATES_DIR, exc)
        return
    for src in TEMPLATES_DIR.glob("*.json"):
        dst = GLOBAL_TEMPLATES_DIR / src.name
        if dst.exists():
            continue  # 同名不覆盖
        try:
            shutil.copy2(src, dst)
        except OSError as exc:
            logger.warning("Failed to seed template %s: %s", src.name, exc)


class Template(BaseSchema):
    id: str
    name: str
    description: str
    steps: dict  # The full workflow definition


@router.get("/list")
async def list_templates():
    """List all workflow templates stored in ~/.workstep/data/templates/."""
    templates = []
    if GLOBAL_TEMPLATES_DIR.exists():
        for f in GLOBAL_TEMPLATES_DIR.glob("*.json"):
            try:
                data = json.loads(f.read_text())
                templates.append({
                    "id": data.get("id", f.stem),
                    "name": data.get("name", f.stem),
                    "description": data.get("description", ""),
                    "nodeCount": len(data.get("steps", {}).get("nodes", [])),
                    "custom": True,
                    "default": data.get("default", False),
                })
            except Exception:
                pass

    return {"templates": templates}


@router.get("/{template_id}")
async def get_template(template_id: str):
    """Get a specific template by ID."""
    _validate_template_id(template_id)
    template_path = GLOBAL_TEMPLATES_DIR / f"{template_id}.json"
    if template_path.exists():
        try:
            return json.loads(template_path.read_text())
        except Exception:
            pass

    raise HTTPException(status_code=404, detail=f"Template not found: {template_id}")


class SaveTemplateRequest(BaseSchema):
    id: str
    name: str
    description: str
    steps: dict


@router.post("/save")
async def save_template(req: SaveTemplateRequest):
    """Save a workflow template to ~/.workstep/data/templates/."""
    _validate_template_id(req.id)
    try:
        WorkflowDefinition.load(req.steps).validate()
    except WorkflowValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    GLOBAL_TEMPLATES_DIR.mkdir(parents=True, exist_ok=True)
    path = GLOBAL_TEMPLATES_DIR / f"{req.id}.json"
    data = {
        "id": req.id,
        "name": req.name,
        "description": req.description,
        "steps": req.steps,
    }
    # Preserve the default flag when overwriting a seeded default template
    default_flag = False
    try:
        existing = json.loads(path.read_text())
        default_flag = bool(existing.get("default"))
    except Exception:
        pass
    if not default_flag:
        # Fall back to the shipped template metadata (e.g. fresh global file)
        try:
            shipped = json.loads((TEMPLATES_DIR / f"{req.id}.json").read_text())
            default_flag = bool(shipped.get("default"))
        except Exception:
            pass
    if default_flag:
        data["default"] = True
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2))
    return {"saved": True, "id": req.id}


@router.delete("/{template_id}")
async def delete_template(template_id: str):
    """Delete a custom template. Default (shipped) templates cannot be deleted."""
    _validate_template_id(template_id)
    template_path = GLOBAL_TEMPLATES_DIR / f"{template_id}.json"
    if not template_path.exists():
        raise HTTPException(status_code=404, detail=f"Template not found: {template_id}")
    try:
        data = json.loads(template_path.read_text())
        if data.get("default"):
            raise HTTPException(
                status_code=400,
                detail="Default templates cannot be deleted",
            )
    except HTTPException:
        raise
    except Exception:
        pass
    template_path.unlink()
    return {"deleted": True, "id": template_id}
