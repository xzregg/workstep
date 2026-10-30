"""Workflow templates API - browse and apply templates.

Templates are managed globally in `~/.workstep/data/templates/`. On daemon
startup the shipped defaults in `data/templates/` are seeded there — files
with the same name are never overwritten.
"""

import asyncio
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


def _template_document(data: dict, template_id: str) -> dict:
    """Normalize legacy shipped files in memory; never rewrite user assets."""
    shipped_path = TEMPLATES_DIR / f"{template_id}.json"
    shipped = json.loads(shipped_path.read_text()) if shipped_path.is_file() else {}
    document = dict(data)
    if template_id == "dev-workflow" and "steps" not in document and "nodes" in document:
        document = {"steps": document}
    for key in ("id", "name", "description", "locale", "default"):
        if key not in document and key in shipped:
            document[key] = shipped[key]
    document.setdefault("id", template_id)
    document.setdefault("name", template_id)
    document.setdefault("description", "")
    return document


class Template(BaseSchema):
    id: str
    name: str
    description: str
    steps: dict  # The full workflow definition


@router.get("/list")
async def list_templates():
    """List all workflow templates stored in ~/.workstep/data/templates/."""
    return await asyncio.to_thread(_list_templates_sync)


def _list_templates_sync():
    templates = []
    if GLOBAL_TEMPLATES_DIR.exists():
        for f in GLOBAL_TEMPLATES_DIR.glob("*.json"):
            try:
                data = _template_document(json.loads(f.read_text()), f.stem)
                templates.append({
                    "id": data.get("id", f.stem),
                    "name": data.get("name", f.stem),
                    "description": data.get("description", ""),
                    "nodeCount": len(data.get("steps", {}).get("nodes", [])),
                    "custom": True,
                    "default": data.get("default", False),
                    "locale": data.get("locale"),
                })
            except Exception:
                pass

    return {"templates": templates}


@router.get("/{template_id}")
async def get_template(template_id: str):
    """Get a specific template by ID."""
    _validate_template_id(template_id)
    return await asyncio.to_thread(_get_template_sync, template_id)


def _get_template_sync(template_id: str):
    template_path = GLOBAL_TEMPLATES_DIR / f"{template_id}.json"
    if template_path.exists():
        try:
            return _template_document(json.loads(template_path.read_text()), template_id)
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

    return await asyncio.to_thread(_save_template_sync, req)


def _save_template_sync(req: SaveTemplateRequest):
    GLOBAL_TEMPLATES_DIR.mkdir(parents=True, exist_ok=True)
    path = GLOBAL_TEMPLATES_DIR / f"{req.id}.json"
    data = {
        "id": req.id,
        "name": req.name,
        "description": req.description,
        "steps": req.steps,
    }
    try:
        previous = json.loads(path.read_text()) if path.exists() else {}
    except (OSError, ValueError):
        previous = {}
    existing = _template_document(previous, req.id)
    if existing.get("locale"):
        data["locale"] = existing["locale"]
    if existing.get("default"):
        data["default"] = True
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2))
    return {"saved": True, "id": req.id}


@router.delete("/{template_id}")
async def delete_template(template_id: str):
    """Delete a custom template. Default (shipped) templates cannot be deleted."""
    _validate_template_id(template_id)
    return await asyncio.to_thread(_delete_template_sync, template_id)


def _delete_template_sync(template_id: str):
    template_path = GLOBAL_TEMPLATES_DIR / f"{template_id}.json"
    if not template_path.exists():
        raise HTTPException(status_code=404, detail=f"Template not found: {template_id}")
    try:
        data = _template_document(json.loads(template_path.read_text()), template_id)
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
