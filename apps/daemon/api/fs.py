"""Directory browser API — for project path selection."""

import asyncio
import mimetypes
import os
import platform
import shutil
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel

from services.config import CONFIG_DIR

router = APIRouter(prefix="/api/fs")

# Root-level router for project-relative upload URLs:
# /{project_name}/.workstep/uploads/{filename} (as stored in markdown).
uploads_router = APIRouter()


class OpenDirectoryRequest(BaseModel):
    path: str
    opener: str = "file_manager"


class MkdirRequest(BaseModel):
    parent: str
    name: str


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


class UploadImageRequest(BaseModel):
    filename: str = "image.png"
    data_url: str  # data:image/png;base64,...
    prefix: str = ""


class UploadFileRequest(BaseModel):
    filename: str = "attachment.bin"
    data_url: str
    prefix: str = ""


class MemoryWriteRequest(BaseModel):
    content: str


@router.get("/memory")
async def read_memory(pid: str = Query(..., alias="project_id")):
    """Read the project's .workstep/MEMORY.md (empty string when missing)."""
    from main import project_manager
    if not project_manager:
        raise HTTPException(status_code=503, detail="Service not initialized")
    try:
        project = project_manager.bind_project_by_id(pid)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    memory_path = project.workstep_dir / "MEMORY.md"
    content = memory_path.read_text(encoding="utf-8") if memory_path.is_file() else ""
    return {"path": str(memory_path), "content": content}


@router.put("/memory")
async def write_memory(
    req: MemoryWriteRequest,
    pid: str = Query(..., alias="project_id"),
):
    """Overwrite the project's .workstep/MEMORY.md."""
    from main import project_manager
    if not project_manager:
        raise HTTPException(status_code=503, detail="Service not initialized")
    try:
        project = project_manager.bind_project_by_id(pid)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    if len(req.content) > 500_000:
        raise HTTPException(status_code=400, detail="记忆内容超过 500KB 上限")
    memory_path = project.workstep_dir / "MEMORY.md"
    memory_path.parent.mkdir(parents=True, exist_ok=True)
    memory_path.write_text(req.content, encoding="utf-8")
    return {"path": str(memory_path), "saved": True}


@router.post("/upload/image")
async def upload_image(
    req: UploadImageRequest,
    pid: str = Query("", alias="project_id"),
):
    """Upload an image (as base64 data URL) to an uploads directory.

    Project uploads go to ``<project>/.workstep/uploads/``; an empty
    ``project_id`` (e.g. flow-template editing) uses the daemon-global
    ``~/.workstep/data/uploads/`` directory.
    """
    project = None
    if pid:
        from main import project_manager
        if not project_manager:
            raise HTTPException(status_code=503, detail="Service not initialized")
        try:
            project = project_manager.bind_project_by_id(pid)
        except ValueError as e:
            raise HTTPException(status_code=404, detail=str(e))

    import base64
    import re as _re

    data_url = req.data_url
    # Parse data URL: data:image/png;base64,xxxx
    match = _re.match(r'data:(image/[^;]+);base64,(.+)', data_url)
    if not match:
        raise HTTPException(status_code=400, detail="Invalid data URL format")

    content_type = match.group(1)
    b64data = match.group(2)
    try:
        content = base64.b64decode(b64data)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid base64 data")

    ext_map = {"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif",
               "image/webp": ".webp", "image/svg+xml": ".svg", "image/bmp": ".bmp"}
    ext = ext_map.get(content_type, ".png")

    # Short flow/task prefix so uploads can be bulk-cleared later.
    prefix = req.prefix.strip()
    if len(prefix) > 32 or not _re.fullmatch(r"[A-Za-z0-9_-]*", prefix):
        raise HTTPException(status_code=400, detail="前缀仅允许字母、数字、下划线和连字符，长度不超过 32")

    filename = f"{prefix}-{uuid.uuid4().hex}{ext}" if prefix else f"{uuid.uuid4().hex}{ext}"
    if project is not None:
        upload_dir = Path(project.workstep_dir) / "uploads"
        rel_path = f".workstep/uploads/{filename}"
    else:
        upload_dir = CONFIG_DIR / "data" / "uploads"
        rel_path = f"data/uploads/{filename}"
    upload_dir.mkdir(parents=True, exist_ok=True)

    filepath = upload_dir / filename
    filepath.write_bytes(content)

    # Relative path kept in markdown as-is so it stays meaningful for LLM
    # prompts; the frontend maps it back to /api/fs/serve/... for preview.
    return {"url": rel_path, "filename": filename, "size": len(content)}


@router.post("/upload/file")
async def upload_file(
    req: UploadFileRequest,
    pid: str = Query("", alias="project_id"),
):
    """Upload an ordinary attachment and return its Markdown-safe relative path."""
    project = None
    if pid:
        from main import project_manager
        if not project_manager:
            raise HTTPException(status_code=503, detail="Service not initialized")
        try:
            project = project_manager.bind_project_by_id(pid)
        except ValueError as e:
            raise HTTPException(status_code=404, detail=str(e))

    import base64
    import re as _re

    match = _re.match(r"data:([^;,]+);base64,(.+)", req.data_url)
    if not match:
        raise HTTPException(status_code=400, detail="Invalid data URL format")
    content_type, b64data = match.groups()
    try:
        content = base64.b64decode(b64data, validate=True)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid base64 data")
    if len(content) > 25_000_000:
        raise HTTPException(status_code=400, detail="文件超过 25MB 上限")

    prefix = req.prefix.strip()
    if len(prefix) > 32 or not _re.fullmatch(r"[A-Za-z0-9_-]*", prefix):
        raise HTTPException(status_code=400, detail="前缀仅允许字母、数字、下划线和连字符，长度不超过 32")

    ext = Path(req.filename).suffix.lower()
    if not _re.fullmatch(r"\.[a-z0-9]{1,10}", ext):
        guessed = mimetypes.guess_extension(content_type) or ".bin"
        ext = guessed if _re.fullmatch(r"\.[a-z0-9]{1,10}", guessed) else ".bin"
    filename = f"{prefix}-{uuid.uuid4().hex}{ext}" if prefix else f"{uuid.uuid4().hex}{ext}"
    if project is not None:
        upload_dir = Path(project.workstep_dir) / "uploads"
        rel_path = f".workstep/uploads/{filename}"
    else:
        upload_dir = CONFIG_DIR / "data" / "uploads"
        rel_path = f"data/uploads/{filename}"
    upload_dir.mkdir(parents=True, exist_ok=True)
    (upload_dir / filename).write_bytes(content)
    return {"url": rel_path, "filename": filename, "size": len(content)}


def _serve_upload_file(upload_dir: Path, filename: str) -> FileResponse:
    """Serve an uploaded file from an uploads directory."""
    filepath = upload_dir / filename

    # Security: prevent traversal
    try:
        filepath.resolve().relative_to(upload_dir.resolve())
    except ValueError:
        raise HTTPException(status_code=403, detail="Access denied")

    if not filepath.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    return FileResponse(str(filepath))


@router.get("/serve/{filename}")
async def serve_upload(
    filename: str,
    pid: str = Query("", alias="project_id"),
):
    """Serve an uploaded file from a project or the global uploads dir."""
    if not pid:
        return _serve_upload_file(CONFIG_DIR / "data" / "uploads", filename)
    from main import project_manager
    if not project_manager:
        raise HTTPException(status_code=503, detail="Service not initialized")
    try:
        project = project_manager.bind_project_by_id(pid)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return _serve_upload_file(Path(project.workstep_dir) / "uploads", filename)


@uploads_router.get("/{project_name}/.workstep/uploads/{filename}")
async def serve_upload_by_project_name(project_name: str, filename: str):
    """Serve an uploaded file via its project-relative markdown path.

    Matches the format stored in markdown (e.g. 测试项目/.workstep/uploads/abc.png)
    so the URL works as-is in the browser.
    """
    from main import project_manager
    if not project_manager:
        raise HTTPException(status_code=503, detail="Service not initialized")
    project = project_manager.get_project_by_name(project_name)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return _serve_upload_file(Path(project.workstep_dir) / "uploads", filename)


def _assert_project_path(path: Path, project_id: str | None) -> None:
    if not project_id:
        return
    from main import project_manager

    project = project_manager.get_project_by_id(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    try:
        path.relative_to(project.path.resolve())
    except ValueError as exc:
        raise HTTPException(status_code=403, detail="Path is outside the project") from exc


@router.get("/browse")
async def browse_directory(path: str | None = None, project_id: str | None = Query(None)):
    """List directory contents for the file picker."""
    if path is None:
        target = Path.home()
    else:
        target = Path(path).expanduser().resolve()
    _assert_project_path(target, project_id)

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
    return {"path": str(target), "name": name}


@router.get("/file")
async def serve_file(path: str, project_id: str | None = Query(None)):
    """Serve a raw file over HTTP (used for HTML preview links / downloads)."""
    file_path = Path(path).expanduser().resolve()
    _assert_project_path(file_path, project_id)
    if not file_path.exists():
        raise HTTPException(status_code=404, detail=f"File not found: {file_path}")
    if not file_path.is_file():
        raise HTTPException(status_code=400, detail=f"Not a file: {file_path}")
    content_type, _ = mimetypes.guess_type(str(file_path))
    return FileResponse(file_path, media_type=content_type or "application/octet-stream")


@router.get("/raw/{full_path:path}")
async def serve_raw_file(full_path: str, project_id: str | None = Query(None)):
    """Serve a file at a URL mirroring its filesystem path so relative assets
    inside HTML resolve correctly (e.g. /api/fs/raw/Users/me/proj/index.html)."""
    file_path = Path("/" + full_path).expanduser().resolve()
    _assert_project_path(file_path, project_id)
    if not file_path.exists():
        raise HTTPException(status_code=404, detail=f"File not found: {file_path}")
    if not file_path.is_file():
        raise HTTPException(status_code=400, detail=f"Not a file: {file_path}")
    content_type, _ = mimetypes.guess_type(str(file_path))
    return FileResponse(file_path, media_type=content_type or "application/octet-stream")


@router.get("/preview")
async def preview_file(path: str, project_id: str | None = Query(None)):
    """Preview a file content for display."""
    file_path = Path(path).expanduser().resolve()
    _assert_project_path(file_path, project_id)

    if not file_path.exists():
        raise HTTPException(status_code=404, detail=f"File not found: {file_path}")

    if not file_path.is_file():
        raise HTTPException(status_code=400, detail=f"Not a file: {file_path}")

    content_type, _ = mimetypes.guess_type(str(file_path))
    file_size = file_path.stat().st_size
    max_size = 1024 * 1024
    if file_size > max_size:
        raise HTTPException(
            status_code=413,
            detail=f"File is too large to preview ({file_size} bytes; limit {max_size})",
        )

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
