"""Directory browser API — for project path selection."""

import os
from pathlib import Path

from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/api/fs")


@router.get("/browse")
async def browse_directory(path: str | None = None):
    """List directory contents for the file picker.

    If path is None, returns the user's home directory.
    Returns: { path, parent, entries: [{name, type, path}] }
    """
    if path is None:
        target = Path.home()
    else:
        target = Path(path).expanduser().resolve()

    if not target.exists():
        raise HTTPException(status_code=404, detail=f"Directory not found: {target}")
    if not target.is_dir():
        raise HTTPException(status_code=400, detail=f"Not a directory: {target}")

    entries = []
    try:
        for item in sorted(target.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())):
            if item.name.startswith('.'):
                continue
            entries.append({
                "name": item.name,
                "type": "directory" if item.is_dir() else "file",
                "path": str(item),
            })
    except PermissionError:
        raise HTTPException(status_code=403, detail=f"Permission denied: {target}")

    return {
        "path": str(target),
        "name": target.name or str(target),
        "parent": str(target.parent) if target.parent != target else None,
        "entries": entries,
    }
