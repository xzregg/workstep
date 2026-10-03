"""Bounded, task-owned Git reads for the canonical public task viewer."""
import asyncio
import json
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

router = APIRouter(prefix='/git')


def _parameters(encoded: str) -> dict:
    try:
        if not re.fullmatch(r'[0-9a-f]{2,16384}', encoded):
            raise ValueError()
        data = json.loads(bytes.fromhex(encoded))
        if not isinstance(data, dict) or set(data) - {'tree_id', 'path', 'ref', 'commit', 'offset'}:
            raise ValueError()
        if any(not isinstance(value, str) or len(value) > 2048 or '\0' in value for value in data.values()):
            raise ValueError()
        return data
    except (ValueError, UnicodeError):
        raise HTTPException(404, 'Git view unavailable')


def _workspace_file(root: Path, virtual: str) -> Path:
    from api.platform_share import _safe_git_path
    if not virtual.startswith('workspace:'):
        raise HTTPException(404, 'File unavailable')
    relative = virtual[len('workspace:'):]
    if relative and (not _safe_git_path(relative) or any(part.startswith('.') for part in Path(relative).parts)):
        raise HTTPException(404, 'File unavailable')
    resolved_root = root.resolve()
    target = (resolved_root / relative).resolve()
    if not target.is_relative_to(resolved_root):
        raise HTTPException(404, 'File unavailable')
    return target


def _browse(root: Path, virtual: str) -> dict:
    target = _workspace_file(root, virtual)
    if not target.is_dir():
        raise HTTPException(404, 'Directory unavailable')
    def path(item): return 'workspace:' + item.relative_to(root.resolve()).as_posix().removeprefix('.')
    entries = []
    for item in sorted(target.iterdir(), key=lambda item: (not item.is_dir(), item.name.lower())):
        if item.name.startswith('.') or not item.resolve().is_relative_to(root.resolve()):
            continue
        entries.append({'name': item.name, 'type': 'directory' if item.is_dir() else 'file',
                        'path': path(item), 'relative_path': path(item)})
    parent = path(target.parent) if target != root.resolve() else None
    return {'path': virtual, 'name': target.name, 'relative_path': virtual,
            'parent': parent, 'parent_relative_path': parent, 'entries': entries}


@router.get('/read/{action}/{encoded}')
async def read_git_view(request: Request, action: str, encoded: str):
    from api.platform_share import _share_scope, _share_git_workspace, _share_git_result, _safe_git_path
    from api import git as git_api
    scope = _share_scope(request)
    data = _parameters(encoded)
    if action not in {'repositories', 'history', 'changes', 'diff', 'blame', 'remotes', 'browse', 'preview', 'content'}:
        raise HTTPException(404, 'Git view unavailable')
    workspace = await _share_git_workspace(scope)
    if action == 'repositories':
        return {'projects': [{'id': 'shared', 'name': 'Shared task', 'path': 'workspace:'}],
                'repositories': [], 'depth': 0, 'scanned_at': None, 'errors': []}
    if action in {'browse', 'preview', 'content'}:
        root = Path(workspace['path'])
        virtual = data.get('path', 'workspace:')
        if action == 'browse': return await asyncio.to_thread(_browse, root, virtual)
        def file():
            target = _workspace_file(root, virtual)
            if not target.is_file(): raise HTTPException(404, 'File unavailable')
            if action == 'content': return FileResponse(target)
            from api.fs import _preview_file_sync
            preview = _preview_file_sync(str(target), None, True)
            if isinstance(preview, dict):
                preview['path'] = virtual; preview['relative_path'] = virtual
            return preview
        try:
            response = await asyncio.to_thread(file)
        except HTTPException as exc:
            raise HTTPException(exc.status_code, 'File preview unavailable') from exc
        if isinstance(response, FileResponse):
            response.headers['Content-Security-Policy'] = 'sandbox'
            response.headers['X-Content-Type-Options'] = 'nosniff'
        return response
    tree = data.get('tree_id')
    if tree not in {item['id'] for item in workspace['worktrees']}:
        raise HTTPException(404, 'Git worktree unavailable')
    ref, commit = data.get('ref'), data.get('commit')
    if any(value is not None and (value.startswith('-') or '\n' in value) for value in (ref, commit)):
        raise HTTPException(404, 'Git ref unavailable')
    service = git_api.git_service
    if action == 'remotes':
        result = await _share_git_result(service.remotes(tree))
        return {'remotes': [{'name': item['name'], 'url': '', 'push_url': '',
                             'branches': item.get('branches', [])} for item in result['remotes']],
                'upstream': result.get('upstream'), 'fetched_at': result.get('fetched_at')}
    if action == 'history':
        offset = data.get('offset', '0')
        if not offset.isdecimal() or not 0 <= int(offset) <= 1000000:
            raise HTTPException(404, 'History unavailable')
        return await _share_git_result(service.history(tree, ref, int(offset)))
    if action == 'changes':
        result = await _share_git_result(service.changes(tree, ref, commit))
        return {'files': [item for item in result['files'] if _safe_git_path(item.get('path'))]}
    path = data.get('path')
    if not _safe_git_path(path) or any(part.startswith('.') for part in Path(path).parts):
        raise HTTPException(404, 'Git file unavailable')
    if action == 'blame': return await _share_git_result(service.blame(tree, path, ref))
    return await _share_git_result(service.diff(tree, path, ref, commit))
