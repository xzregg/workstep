"""File upload, preview, and local directory opening API."""

import asyncio
import mimetypes
import platform
import shutil
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from pydantic import BaseModel

from services.config import CONFIG_DIR
from services.project_memory import read_memory_bytes, write_memory_bytes
from api.fs_browser import router as browser_router
from api.fs_paths import (
    _assert_project_path, _path_error_detail, _project, _project_relative_path,
    _require_actor_project, _resolve_project_file,
)

router = APIRouter(prefix="/api/fs")
router.include_router(browser_router)

# Root-level router for project-relative upload URLs:
# /{project_name}/.workstep/uploads/{filename} (as stored in markdown).
uploads_router = APIRouter()


def _sandbox_file(response):
    """Also protect direct navigation to active uploads/raw files."""
    from workstep_gateway_protocol.html_preview import html_preview_policy, PREVIEW_RESOURCES_HEADER
    response.headers['Content-Security-Policy'] = html_preview_policy('')
    response.headers[PREVIEW_RESOURCES_HEADER] = 'none'
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['Referrer-Policy'] = 'no-referrer'
    return response


class OpenDirectoryRequest(BaseModel):
    path: str
    opener: str = "file_manager"


class OpenFileRequest(BaseModel):
    project_id: str
    path: str
    opener: str = "default"


class OpenSessionJournalRequest(BaseModel):
    project_id: str
    session_id: str | None = None
    message_id: str | None = None


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
            limit=1024 * 256,
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
    command = await asyncio.to_thread(_open_command, directory, "file_manager")
    await _run_open_command(command, directory)


async def _open_with(directory: Path, opener_id: str) -> None:
    command = await asyncio.to_thread(_open_command, directory, opener_id)
    await _run_open_command(command, directory)


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


def _project_upload_dir(data_root: Path) -> Path:
    upload_dir = data_root / "uploads"
    try:
        upload_dir.resolve().relative_to(data_root.resolve())
    except ValueError:
        raise HTTPException(status_code=403, detail="Access denied")
    return upload_dir


@router.get("/memory")
async def read_memory(pid: str = Query(..., alias="project_id")):
    """Read the project's .workstep/MEMORY.md (empty string when missing)."""
    from main import project_manager
    if not project_manager:
        raise HTTPException(status_code=503, detail="Service not initialized")
    try:
        project = _project(pid)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    memory_path = project.workstep_dir / "MEMORY.md"
    def load_memory() -> str:
        try:
            content = read_memory_bytes(project.workstep_dir)
        except PermissionError as exc:
            raise HTTPException(status_code=403, detail="Access denied") from exc
        return content.decode("utf-8").replace("\r\n", "\n").replace("\r", "\n") if content is not None else ""

    content = await asyncio.to_thread(load_memory)
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
        project = _project(pid)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    if len(req.content) > 500_000:
        raise HTTPException(status_code=400, detail="记忆内容超过 500KB 上限")
    memory_path = project.workstep_dir / "MEMORY.md"
    def persist_memory() -> None:
        try:
            write_memory_bytes(project.workstep_dir, req.content.encode("utf-8"))
        except PermissionError as exc:
            raise HTTPException(status_code=403, detail="Access denied") from exc

    await asyncio.to_thread(persist_memory)
    return {"path": str(memory_path), "saved": True}


async def _audit_uploaded_file(project, filename: str, original_name: str, size: int, task_id: str | None = None) -> None:
    from services.project_audit import remote_audit_source, record_remote_project_audit
    if project is None or remote_audit_source() is None:
        return
    from main import project_manager
    name = Path(original_name.replace("\\", "/")).name
    name = "".join(char for char in name if char.isprintable())[:256]
    try:
        await project_manager.run_db(project.id, lambda _project: record_remote_project_audit(
            project_id=project.id, action="file.upload", task_id=task_id, metadata={
                "file_name": name, "file_path": f".workstep/uploads/{filename}", "file_size": size,
            }))
    except Exception:
        await asyncio.to_thread((Path(project.workstep_dir) / "uploads" / filename).unlink, missing_ok=True)
        raise


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
            project = _project(pid)
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
        content = await asyncio.to_thread(base64.b64decode, b64data)
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
    filepath = upload_dir / filename
    def persist_upload() -> None:
        if project is not None:
            _project_upload_dir(Path(project.workstep_dir))
        upload_dir.mkdir(parents=True, exist_ok=True)
        filepath.write_bytes(content)

    await asyncio.to_thread(persist_upload)
    await _audit_uploaded_file(project, filename, req.filename, len(content))

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
            project = _project(pid)
        except ValueError as e:
            raise HTTPException(status_code=404, detail=str(e))

    import base64
    import re as _re

    match = _re.match(r"data:([^;,]+);base64,(.+)", req.data_url)
    if not match:
        raise HTTPException(status_code=400, detail="Invalid data URL format")
    content_type, b64data = match.groups()
    try:
        content = await asyncio.to_thread(
            base64.b64decode, b64data, validate=True
        )
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
    def persist_upload() -> None:
        if project is not None:
            _project_upload_dir(Path(project.workstep_dir))
        upload_dir.mkdir(parents=True, exist_ok=True)
        (upload_dir / filename).write_bytes(content)

    await asyncio.to_thread(persist_upload)
    await _audit_uploaded_file(project, filename, req.filename, len(content))
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

    return _sandbox_file(FileResponse(str(filepath)))


@router.get("/serve/{filename}")
async def serve_upload(
    filename: str,
    pid: str = Query("", alias="project_id"),
):
    """Serve an uploaded file from a project or the global uploads dir."""
    _require_actor_project(pid or None)
    if not pid:
        return await asyncio.to_thread(
            _serve_upload_file, CONFIG_DIR / "data" / "uploads", filename
        )
    from main import project_manager
    if not project_manager:
        raise HTTPException(status_code=503, detail="Service not initialized")
    try:
        project = _project(pid)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return await asyncio.to_thread(
        lambda: _serve_upload_file(_project_upload_dir(Path(project.workstep_dir)), filename)
    )


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
    _require_actor_project(project.id)
    return await asyncio.to_thread(
        lambda: _serve_upload_file(_project_upload_dir(Path(project.workstep_dir)), filename)
    )


@router.get("/file")
async def serve_file(path: str, project_id: str | None = Query(None)):
    """Serve a raw file over HTTP (used for HTML preview links / downloads)."""
    def response() -> FileResponse:
        file_path = _resolve_project_file(path, project_id)
        if not file_path.exists():
            raise HTTPException(status_code=404, detail=_path_error_detail("File not found", file_path))
        if not file_path.is_file():
            raise HTTPException(status_code=400, detail=_path_error_detail("Not a file", file_path))
        content_type, _ = mimetypes.guess_type(str(file_path))
        return _sandbox_file(FileResponse(file_path, media_type=content_type or "application/octet-stream"))

    return await asyncio.to_thread(response)


@router.get("/raw/{full_path:path}")
async def serve_raw_file(full_path: str, project_id: str | None = Query(None)):
    """Serve a file at a URL mirroring its filesystem path so relative assets
    inside HTML resolve correctly (e.g. /api/fs/raw/Users/me/proj/index.html)."""
    def response() -> FileResponse:
        file_path = Path("/" + full_path).expanduser().resolve()
        _assert_project_path(file_path, project_id)
        if not file_path.exists():
            raise HTTPException(status_code=404, detail=_path_error_detail("File not found", file_path))
        if not file_path.is_file():
            raise HTTPException(status_code=400, detail=_path_error_detail("Not a file", file_path))
        content_type, _ = mimetypes.guess_type(str(file_path))
        return _sandbox_file(FileResponse(file_path, media_type=content_type or "application/octet-stream"))

    return await asyncio.to_thread(response)


@router.get("/project-raw/{project_ref}/{full_path:path}")
async def serve_project_raw_file(
    project_ref: str,
    full_path: str,
    project_id: str | None = Query(None),
    absolute: bool = Query(False),
):
    """Serve a project file from a stable URL so HTML relative assets still work."""
    def response() -> FileResponse:
        requested_path = f"/{full_path}" if absolute else full_path
        file_path = _resolve_project_file(
            requested_path,
            project_id or project_ref,
            allow_absolute=absolute,
        )
        if not file_path.exists():
            raise HTTPException(status_code=404, detail=_path_error_detail("File not found", file_path))
        if not file_path.is_file():
            raise HTTPException(status_code=400, detail=_path_error_detail("Not a file", file_path))
        content_type, _ = mimetypes.guess_type(str(file_path))
        return _sandbox_file(FileResponse(file_path, media_type=content_type or "application/octet-stream"))

    return await asyncio.to_thread(response)


@router.get("/preview")
async def preview_file(
    path: str,
    project_id: str | None = Query(None),
    absolute: bool = Query(False),
):
    """Preview a file content for display."""
    def load():
        preview = _preview_file_sync(path, project_id, absolute)
        if preview['content_type'] == 'text/html':
            from services.html_preview import issue_ticket
            preview['html_preview'] = issue_ticket(
                _resolve_project_file(path, project_id, allow_absolute=absolute), project_id,
            )
        return preview
    preview = await asyncio.to_thread(load)
    if 'html_preview' in preview:
        return JSONResponse(preview, headers={
            'X-WorkStep-Preview-Grant': preview['html_preview']['token'], 'Cache-Control': 'no-store',
        })
    return preview


@router.get('/html-resource/{project_ref}/{token}/{resource_path:path}')
async def html_preview_resource(request: Request, project_ref: str, token: str,
                                resource_path: str, project_id: str | None = Query(None)):
    from urllib.parse import quote
    from services.html_preview import resource_file, prepare_html
    from workstep_gateway_protocol.html_preview import html_preview_policy, PREVIEW_RESOURCES_HEADER
    # The query is rewritten by authenticated remote dispatch; the path preserves
    # the client's remote-project routing hint for relative assets.
    effective_project = project_id or (project_ref if project_ref != '_' else None)
    _require_actor_project(effective_project)
    root = f'/api/fs/html-resource/{quote(project_ref, safe="")}/{quote(token, safe="")}/'
    origin = f'{request.url.scheme}://{request.url.netloc}'
    def load():
        target = resource_file(token, effective_project, resource_path)
        media, _ = mimetypes.guess_type(str(target))
        if media == 'text/html':
            response = HTMLResponse(prepare_html(target.read_text(encoding='utf-8')))
        else:
            response = FileResponse(target, media_type=media or 'application/octet-stream')
        response.headers.update({
            'Content-Security-Policy': html_preview_policy(origin, root),
            PREVIEW_RESOURCES_HEADER: root,
            'Access-Control-Allow-Origin': 'null',
            'Access-Control-Allow-Credentials': 'true',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer',
        })
        return response
    return await asyncio.to_thread(load)


def _preview_file_sync(path: str, project_id: str | None, absolute: bool):
    file_path = _resolve_project_file(path, project_id, allow_absolute=absolute)

    if not file_path.exists():
        raise HTTPException(status_code=404, detail=_path_error_detail("File not found", file_path))

    if not file_path.is_file():
        raise HTTPException(status_code=400, detail=_path_error_detail("Not a file", file_path))

    content_type, _ = mimetypes.guess_type(str(file_path))
    file_size = file_path.stat().st_size
    relative_path = _project_relative_path(file_path, project_id)
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
                "extension": file_path.suffix,
                "relative_path": relative_path,
            }
        except Exception as e:
            raise HTTPException(status_code=500, detail=_path_error_detail("Failed to read image", e))

    try:
        content = file_path.read_text(encoding='utf-8')
        return {
            "type": "text",
            "content_type": content_type or "text/plain",
            "content": content,
            "file_size": file_size,
            "extension": file_path.suffix,
            "relative_path": relative_path,
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
            "extension": file_path.suffix,
            "relative_path": relative_path,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=_path_error_detail("Failed to read file", e))


@router.post("/open-directory")
async def open_directory(req: OpenDirectoryRequest):
    """Open the directory containing a local artifact."""
    def resolve_directory() -> Path:
        target = Path(req.path).expanduser().resolve()
        if not target.exists():
            raise HTTPException(status_code=404, detail=f"Path not found: {target}")
        return target if target.is_dir() else target.parent

    directory = await asyncio.to_thread(resolve_directory)
    if req.opener == "file_manager":
        await _open_directory(directory)
    else:
        await _open_with(directory, req.opener)
    return {"opened": True, "path": str(directory)}


@router.post("/open-file")
async def open_file(req: OpenFileRequest):
    from services.remote_access import get_current_actor

    if get_current_actor() is not None:
        raise HTTPException(status_code=403, detail="Host file opening is local only")

    def prepare() -> tuple[Path, list[str]]:
        target = _resolve_project_file(req.path, req.project_id)
        if not target.is_file():
            raise HTTPException(status_code=404, detail="File not found")
        system = platform.system()
        if req.opener == "default":
            command = {"Darwin": ["open", str(target)], "Windows": ["explorer", str(target)]}.get(system, ["xdg-open", str(target)])
        elif req.opener == "file_manager":
            command = {"Darwin": ["open", "-R", str(target)], "Windows": ["explorer", f"/select,{target}"]}.get(system, ["xdg-open", str(target.parent)])
        else:
            command = _open_command(target.parent if req.opener in {"terminal", "iterm"} else target, req.opener)
        return target, command

    target, command = await asyncio.to_thread(prepare)
    await _run_open_command(command, target)
    return {"opened": True, "path": str(target)}


@router.post("/open-session-journal")
async def open_session_journal(req: OpenSessionJournalRequest):
    """Open the folder holding one session's JSONL event journal (dev tool).

    ``message_id`` wins when provided: task turns journal under
    ``event_logs/task-{task_id}/`` rather than under the session id the UI
    displays, so scanning for ``{message_id}.jsonl`` finds the real folder.
    """
    from agent_assistants.event_journal import _SAFE_SEGMENT

    project = _project(req.project_id)
    event_logs = project.workstep_dir / "event_logs"
    directory: Path | None = None
    message_id = (req.message_id or "").strip()
    if message_id and _SAFE_SEGMENT.fullmatch(message_id):
        matches = await asyncio.to_thread(
            lambda: sorted(event_logs.rglob(f"{message_id}.jsonl"))
        )
        if matches:
            directory = matches[0].parent
    session_id = (req.session_id or "").strip()
    if directory is None and session_id and _SAFE_SEGMENT.fullmatch(session_id):
        candidate = event_logs / session_id
        if await asyncio.to_thread(candidate.is_dir):
            directory = candidate
    if directory is None:
        raise HTTPException(status_code=404, detail="Session journal not found")
    await _open_directory(directory)
    return {"opened": True, "path": str(directory)}


@router.get("/directory-openers")
async def directory_openers():
    """List supported applications that can open a project directory."""
    return {
        "platform": platform.system(),
        "openers": await asyncio.to_thread(_directory_openers),
    }
