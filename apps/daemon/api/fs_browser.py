"""Scoped file browser, search, and entry editing routes."""

import asyncio
import os
import shutil
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from api.fs_paths import _assert_project_path, _project

router = APIRouter()

class MkdirRequest(BaseModel):
    parent: str
    name: str


class BrowserEntryCreateRequest(BaseModel):
    project_id: str
    root: str | None = None
    parent: str
    name: str
    kind: Literal["file", "directory"]


class BrowserEntryRenameRequest(BaseModel):
    project_id: str
    root: str | None = None
    path: str
    name: str


class BrowserEntryDeleteRequest(BaseModel):
    project_id: str
    root: str | None = None
    path: str


class BrowserContentWriteRequest(BrowserEntryDeleteRequest):
    content: str
    expected_content: str


def _resolve_browse_directory(path: str | None, project_id: str | None) -> tuple[Path, Path | None]:
    """Resolve a browser directory and return it with its optional project root."""
    project_root: Path | None = None
    if project_id:
        project_root = _project(project_id).path.resolve()
        candidate = Path(path).expanduser() if path is not None else project_root
        target = (
            candidate.resolve()
            if candidate.is_absolute()
            else (project_root / candidate).resolve()
        )
    else:
        target = Path.home() if path is None else Path(path).expanduser().resolve()
    _assert_project_path(target, project_id)
    if not target.exists():
        raise HTTPException(status_code=404, detail=f"Directory not found: {target}")
    if not target.is_dir():
        raise HTTPException(status_code=400, detail=f"Not a directory: {target}")
    return target, project_root


def _browser_edit_target(path: str, project_id: str, root: str | None) -> tuple[Path, Path]:
    """Resolve a mutation target inside this browser's root, without following a target symlink."""
    browse_root, project_root = _resolve_browse_directory(root, project_id)
    assert project_root is not None
    candidate = Path(path).expanduser()
    candidate = candidate if candidate.is_absolute() else project_root / candidate
    if candidate.is_symlink():
        raise HTTPException(status_code=403, detail="Symlink entries cannot be edited")
    target = candidate.resolve()
    if not target.is_relative_to(browse_root):
        raise HTTPException(status_code=403, detail="Path is outside the browser root")
    return target, browse_root


def _browser_entry_name(name: str) -> str:
    if not name.strip() or name in (".", "..") or any(ch in name for ch in ("/", "\\", "\x00")):
        raise HTTPException(status_code=400, detail="Invalid file or directory name")
    return name


@router.get("/browse")
async def browse_directory(
    path: str | None = None,
    project_id: str | None = Query(None),
    include_hidden: bool = Query(False),
):
    """List directory contents for the file picker."""
    def browse() -> dict:
        target, project_root = _resolve_browse_directory(path, project_id)
        entries = []
        try:
            for item in sorted(target.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())):
                if not include_hidden and item.name.startswith('.'):
                    continue
                entries.append({
                    "name": item.name,
                    "type": "directory" if item.is_dir() else "file",
                    "path": str(item),
                    "relative_path": (
                        item.relative_to(project_root).as_posix()
                        if project_root is not None
                        else None
                    ),
                })
        except PermissionError:
            raise HTTPException(status_code=403, detail=f"Permission denied: {target}")
        parent = target.parent if target.parent != target else None
        if project_root is not None and target == project_root:
            parent = None
        return {
            "path": str(target),
            "name": target.name or str(target),
            "relative_path": (
                target.relative_to(project_root).as_posix()
                if project_root is not None and target != project_root
                else "" if project_root is not None else None
            ),
            "parent": str(parent) if parent is not None else None,
            "parent_relative_path": (
                parent.relative_to(project_root).as_posix()
                if project_root is not None and parent is not None and parent != project_root
                else "" if project_root is not None and parent == project_root else None
            ),
            "entries": entries,
        }

    return await asyncio.to_thread(browse)


@router.get("/search")
async def search_files(
    query: str = Query(..., min_length=1, max_length=200),
    root: str | None = Query(None),
    project_id: str | None = Query(None),
    limit: int = Query(200, ge=1, le=500),
    include_hidden: bool = Query(False),
):
    """Search file names recursively below a project-scoped root."""
    def search() -> dict:
        target, project_root = _resolve_browse_directory(root, project_id)
        needle = query.strip().casefold()
        entries: list[dict] = []
        truncated = False
        if not needle:
            return {"query": query, "truncated": False, "entries": []}
        for directory, dirnames, filenames in os.walk(target, followlinks=False):
            current = Path(directory)
            dirnames[:] = sorted(
                (
                    name for name in dirnames
                    if (include_hidden or not name.startswith('.'))
                    and not (current / name).is_symlink()
                ),
                key=str.casefold,
            )
            for filename in sorted(filenames, key=str.casefold):
                if not include_hidden and filename.startswith('.'):
                    continue
                file_path = current / filename
                if file_path.is_symlink():
                    continue
                relative = (
                    file_path.relative_to(project_root).as_posix()
                    if project_root is not None
                    else file_path.relative_to(target).as_posix()
                )
                if needle not in relative.casefold():
                    continue
                if len(entries) >= limit:
                    truncated = True
                    break
                entries.append({
                    "name": filename,
                    "type": "file",
                    "path": str(file_path),
                    "relative_path": relative if project_root is not None else None,
                })
            if truncated:
                break
        return {"query": query, "truncated": truncated, "entries": entries}

    return await asyncio.to_thread(search)


@router.post("/mkdir")
async def mkdir_directory(req: MkdirRequest):
    """Create a new directory (used by the project path picker)."""
    name = req.name.strip()
    if (
        not name
        or name in (".", "..")
        or name.startswith(".")
        or any(ch.isspace() for ch in name)
        or "/" in name
        or "\\" in name
    ):
        raise HTTPException(
            status_code=400,
            detail="Folder name must not be empty, start with '.', or contain whitespace or '/'",
        )
    def create_directory() -> Path:
        parent = Path(req.parent).expanduser().resolve()
        if not parent.exists():
            raise HTTPException(status_code=404, detail=f"Directory not found: {parent}")
        if not parent.is_dir():
            raise HTTPException(status_code=400, detail=f"Not a directory: {parent}")
        target = parent / name
        if target.exists():
            raise HTTPException(status_code=409, detail=f"Already exists: {target}")
        try:
            target.mkdir()
        except (PermissionError, OSError) as exc:
            raise HTTPException(
                status_code=500, detail=f"Failed to create directory: {target}"
            ) from exc
        return target

    target = await asyncio.to_thread(create_directory)
    return {"path": str(target), "name": name}


@router.post("/entry")
async def create_browser_entry(req: BrowserEntryCreateRequest):
    """Create a file or directory inside the open browser root."""
    def create() -> dict:
        name = _browser_entry_name(req.name)
        parent, _ = _browser_edit_target(req.parent, req.project_id, req.root)
        if not parent.is_dir():
            raise HTTPException(status_code=404, detail="Parent directory not found")
        target = parent / name
        try:
            if req.kind == "directory":
                target.mkdir()
            else:
                target.touch(exist_ok=False)
        except FileExistsError as exc:
            raise HTTPException(status_code=409, detail="Entry already exists") from exc
        except OSError as exc:
            raise HTTPException(status_code=403, detail=str(exc)) from exc
        return {"path": str(target), "name": name, "kind": req.kind}

    return await asyncio.to_thread(create)


@router.patch("/entry")
async def rename_browser_entry(req: BrowserEntryRenameRequest):
    """Rename a file or directory without moving it outside the open root."""
    def rename() -> dict:
        name = _browser_entry_name(req.name)
        target, root = _browser_edit_target(req.path, req.project_id, req.root)
        if target == root:
            raise HTTPException(status_code=403, detail="Browser root cannot be renamed")
        if not target.exists():
            raise HTTPException(status_code=404, detail="Entry not found")
        destination = target.with_name(name)
        if destination != target and (destination.exists() or destination.is_symlink()):
            raise HTTPException(status_code=409, detail="Entry already exists")
        try:
            target.rename(destination)
        except OSError as exc:
            raise HTTPException(status_code=403, detail=str(exc)) from exc
        return {"path": str(destination), "name": name}

    return await asyncio.to_thread(rename)


@router.delete("/entry")
async def delete_browser_entry(req: BrowserEntryDeleteRequest):
    """Delete an entry inside the open browser root."""
    def delete() -> dict:
        target, root = _browser_edit_target(req.path, req.project_id, req.root)
        if target == root:
            raise HTTPException(status_code=403, detail="Browser root cannot be deleted")
        if not target.exists():
            raise HTTPException(status_code=404, detail="Entry not found")
        try:
            if target.is_dir():
                shutil.rmtree(target)
            else:
                target.unlink()
        except OSError as exc:
            raise HTTPException(status_code=403, detail=str(exc)) from exc
        return {"deleted": True}

    return await asyncio.to_thread(delete)


@router.put("/content")
async def write_browser_content(req: BrowserContentWriteRequest):
    """Save UTF-8 text only when it still matches the version opened in the editor."""
    def save() -> dict:
        target, root = _browser_edit_target(req.path, req.project_id, req.root)
        if target == root or not target.is_file():
            raise HTTPException(status_code=404, detail="File not found")
        if len(req.content.encode("utf-8")) > 1024 * 1024:
            raise HTTPException(status_code=413, detail="File is too large to save")
        try:
            current = target.read_text(encoding="utf-8")
        except UnicodeDecodeError as exc:
            raise HTTPException(status_code=400, detail="Binary files cannot be edited") from exc
        if current != req.expected_content:
            raise HTTPException(status_code=409, detail="File changed since it was opened")
        try:
            target.write_text(req.content, encoding="utf-8")
        except OSError as exc:
            raise HTTPException(status_code=403, detail=str(exc)) from exc
        return {"saved": True}

    return await asyncio.to_thread(save)


