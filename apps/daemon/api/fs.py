"""Directory browser API — for project path selection."""

import asyncio
import mimetypes
import os
import platform
import shutil
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/api/fs")


class OpenDirectoryRequest(BaseModel):
    path: str
    opener: str = "file_manager"


OPENERS = (
    {"id": "vscode", "label": "VS Code", "mac_app": "Visual Studio Code", "commands": ("code",)},
    {"id": "sublime", "label": "Sublime Text", "mac_app": "Sublime Text", "commands": ("subl",)},
    {"id": "file_manager", "label": "Finder", "commands": ()},
    {"id": "terminal", "label": "Terminal", "mac_app": "Terminal", "commands": ("wt", "x-terminal-emulator")},
    {"id": "iterm", "label": "iTerm2", "mac_app": "iTerm", "commands": ()},
    {"id": "intellij", "label": "IntelliJ IDEA", "mac_app": "IntelliJ IDEA", "commands": ("idea",)},
    {"id": "pycharm", "label": "PyCharm", "mac_app": "PyCharm", "commands": ("pycharm",)},
)


def _mac_app_exists(app_name: str) -> bool:
    return any(
        (root / f"{app_name}.app").exists()
        for root in (
            Path("/Applications"),
            Path.home() / "Applications",
            Path("/System/Applications"),
            Path("/System/Applications/Utilities"),
        )
    )


def _directory_openers() -> list[dict]:
    """Return known directory openers and whether they are installed."""
    system = platform.system()
    result = []
    for opener in OPENERS:
        opener_id = opener["id"]
        label = opener["label"]
        if opener_id == "file_manager":
            label = {"Darwin": "Finder", "Windows": "文件资源管理器"}.get(
                system, "文件管理器"
            )
            available = True
        elif system == "Darwin":
            available = _mac_app_exists(opener.get("mac_app", ""))
        else:
            available = any(shutil.which(command) for command in opener["commands"])
            if opener_id == "terminal" and system == "Windows":
                label = "Windows Terminal"
        result.append({"id": opener_id, "label": label, "available": available})
    return result


def _opener_by_id(opener_id: str) -> dict:
    opener = next((item for item in OPENERS if item["id"] == opener_id), None)
    if opener is None:
        raise HTTPException(status_code=400, detail=f"Unknown directory opener: {opener_id}")
    availability = next(item for item in _directory_openers() if item["id"] == opener_id)
    if not availability["available"]:
        raise HTTPException(
            status_code=404,
            detail=f"{availability['label']} is not installed",
        )
    return opener


def _open_command(directory: Path, opener_id: str) -> list[str]:
    """Build a shell-free command for a validated directory opener."""
    system = platform.system()
    opener = _opener_by_id(opener_id)
    if opener_id == "file_manager":
        if system == "Darwin":
            return ["open", str(directory)]
        if system == "Windows":
            return ["explorer", str(directory)]
        return ["xdg-open", str(directory)]
    if system == "Darwin":
        return ["open", "-a", opener["mac_app"], str(directory)]

    command = next(
        (candidate for candidate in opener["commands"] if shutil.which(candidate)),
        None,
    )
    if command is None:
        raise HTTPException(status_code=404, detail=f"{opener['label']} is not installed")
    if opener_id == "terminal":
        if system == "Windows" and command == "wt":
            return [command, "-d", str(directory)]
        return [command, "--working-directory", str(directory)]
    return [command, str(directory)]


async def _run_open_command(command: list[str], directory: Path) -> None:
    try:
        process = await asyncio.create_subprocess_exec(
            *command,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        return_code = await process.wait()
    except FileNotFoundError as exc:
        raise HTTPException(
            status_code=501,
            detail="Requested application command is not available",
        ) from exc
    if return_code != 0:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to open directory: {directory}",
        )


async def _open_directory(directory: Path) -> None:
    """Open a directory in the host operating system's file manager."""
    await _run_open_command(_open_command(directory, "file_manager"), directory)


async def _open_with(directory: Path, opener_id: str) -> None:
    await _run_open_command(_open_command(directory, opener_id), directory)


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


@router.get("/preview")
async def preview_file(path: str):
    """Preview a file content for display.

    Returns content based on file type:
    - Text/Markdown: HTML content
    - Code: syntax-highlighted HTML
    - Images: base64 encoded
    - Other: plain text or error
    """
    file_path = Path(path).expanduser().resolve()

    if not file_path.exists():
        raise HTTPException(status_code=404, detail=f"File not found: {file_path}")

    if not file_path.is_file():
        raise HTTPException(status_code=400, detail=f"Not a file: {file_path}")

    content_type, _ = mimetypes.guess_type(str(file_path))
    file_size = file_path.stat().st_size
    max_size = 1024 * 1024  # 1MB limit
    if file_size > max_size:
        raise HTTPException(
            status_code=413,
            detail=f"File is too large to preview ({file_size} bytes; limit {max_size})",
        )

    # Image files - return base64 encoded
    if content_type and content_type.startswith('image/'):
        try:
            import base64
            content = file_path.read_bytes()
            encoded = base64.b64encode(content).decode('utf-8')
            return {
                "type": "image",
                "content_type": content_type,
                "content": f"data:{content_type};base64,{encoded}",
                "file_size": file_size,
            }
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to read image: {str(e)}")

    # Text/Code files - return content
    try:
        content = file_path.read_text(encoding='utf-8')
        return {
            "type": "text",
            "content_type": content_type or "text/plain",
            "content": content,
            "file_size": file_size,
            "extension": file_path.suffix,
        }
    except UnicodeDecodeError:
        # Binary file - return base64
        import base64
        content = file_path.read_bytes()
        encoded = base64.b64encode(content).decode('utf-8')
        return {
            "type": "binary",
            "content_type": content_type or "application/octet-stream",
            "content": encoded,
            "file_size": file_size,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read file: {str(e)}")


@router.post("/open-directory")
async def open_directory(req: OpenDirectoryRequest):
    """Open the directory containing a local artifact."""
    target = Path(req.path).expanduser().resolve()
    if not target.exists():
        raise HTTPException(status_code=404, detail=f"Path not found: {target}")
    directory = target if target.is_dir() else target.parent
    if req.opener == "file_manager":
        await _open_directory(directory)
    else:
        await _open_with(directory, req.opener)
    return {"opened": True, "path": str(directory)}


@router.get("/directory-openers")
async def directory_openers():
    """List supported applications that can open a project directory."""
    return {"platform": platform.system(), "openers": _directory_openers()}
