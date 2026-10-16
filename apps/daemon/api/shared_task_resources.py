"""Project-backed resources used by the common task-detail controller."""

import asyncio
import re
from pathlib import Path

from fastapi import HTTPException


async def prepare_task_resource(path, method, query, body, project_id, task_id, workflow_id):
    from main import project_manager
    from services.git import git_service
    from services.git.task_workspace import TaskGitWorkspace
    project = project_manager.get_project_by_id(project_id)
    if path == '/git/repositories' and method == 'GET':
        return f'/git/projects/{project_id}/repositories'
    if re.fullmatch(r'/git/projects/[^/]+/initialize', path) and method == 'POST':
        return f'/git/projects/{project_id}/initialize'
    prefix = re.match(r'/git/projects/[^/]+/tasks/([^/]+)/(.*)', path)
    if prefix:
        if prefix[1] != task_id:
            raise HTTPException(403, 'Task scope denied')
        if prefix[2] == 'workspace' and method in {'GET', 'POST', 'DELETE'} or (
            prefix[2] == 'worktrees' and method == 'POST'
        ) or (re.fullmatch(r'worktrees/[A-Za-z0-9_.-]+', prefix[2]) and method == 'DELETE'):
            return f'/git/projects/{project_id}/tasks/{task_id}/{prefix[2]}'
    tree = re.fullmatch(r'/git/worktrees/([0-9a-f]{24})/(.+)', path)
    if tree:
        workspace = await TaskGitWorkspace(git_service, workflow_id).list(project.path, task_id)
        ids = {item['id'] for item in workspace['worktrees']}
        metadata = git_service.directories.get(tree[1])
        if tree[1] not in ids:
            if not (method == 'GET' and tree[2] in {'branches', 'status'}
                    and metadata and project_id in metadata.get('project_ids', [])):
                raise HTTPException(403, 'Git directory is outside the shared task')
        if re.fullmatch(r'(?:status|branches|branches/delete|remotes|remotes/[^/]+|identity|history|changes|diff|blame|files/content|discard|commit|commit-message|switch|fetch|fetch-remote|pull|push|push-branch|merge|merge-into|advance|recoveries|recovery/preview|recovery/apply|ignore)', tree[2]):
            return path
    if path in {'/fs/browse', '/fs/preview', '/fs/search', '/fs/mkdir', '/fs/browser-upload', '/fs/entry', '/fs/content'}:
        workspace = await TaskGitWorkspace(git_service, workflow_id).list(project.path, task_id)
        values = [(container, key, container[key]) for container in (query, body)
                  for key in ('path', 'parent', 'root') if container.get(key) is not None]
        if not values:
            raise HTTPException(403, 'Task directory required')
        def targets():
            root = Path(workspace['path']).resolve()
            artifact_root = (Path(project.workstep_dir) / 'artifacts' / (workflow_id or 'default') / task_id).resolve()
            result = []
            for container, key, candidate in values:
                if not isinstance(candidate, str):
                    raise HTTPException(403, 'Task directory required')
                if candidate.startswith('workspace:'):
                    resolved = (root / candidate[len('workspace:'):].lstrip('/')).resolve()
                else:
                    resolved = (Path(candidate) if Path(candidate).is_absolute() else project.path / candidate).resolve()
                result.append((container, key, resolved,
                               resolved.is_relative_to(root) or resolved.is_relative_to(artifact_root)))
            return result
        resolved_values = await asyncio.to_thread(targets)
        for container, key, resolved, within in resolved_values:
            if not within:
                from services.shared_task_scope import is_edited_task_file
                if path != '/fs/preview' or method != 'GET' or not await project_manager.run_db(
                    project_id, lambda project: is_edited_task_file(project, task_id, resolved)
                ):
                    raise HTTPException(403, 'File is outside the shared task')
            container[key] = str(resolved)
        if path == '/fs/preview':
            query['absolute'] = 'true'
        return path
    if path == '/channel-bots' and method == 'GET' or re.fullmatch(r'/channel-bots/[A-Za-z0-9_-]+/recent-groups', path) and method == 'GET':
        return path
    if re.fullmatch(r'/skills(?:/list)?', path) and method == 'GET':
        return path
    return None


def project_resource_response(path, payload, project_id, public_project_id):
    if re.fullmatch(r'/git/projects/[^/]+/tasks/[^/]+/workspace', path) and isinstance(payload, dict):
        return {**payload, 'path': 'workspace:', 'relative_path': 'workspace:', 'worktrees': [
            {**tree, 'path': 'workspace:' + tree['alias'], 'relative_path': 'workspace:' + tree['alias']}
            for tree in payload.get('worktrees', [])]}
    if path == '/channel-bots' and isinstance(payload, list):
        return [{key: value for key, value in item.items() if key in {
            'id', 'name', 'platform', 'enabled', 'status', 'provider_id',
        }} for item in payload]
    if path.endswith('/repositories') and isinstance(payload, dict):
        return {**payload, 'projects': [{**item, 'id': public_project_id, 'path': 'workspace:'}
            for item in payload.get('projects', []) if item['id'] == project_id],
            'repositories': [{**repo, 'projects': [{**item, 'id': public_project_id}
                for item in repo.get('projects', []) if item['id'] == project_id]}
                for repo in payload.get('repositories', [])
                if any(item['id'] == project_id for item in repo.get('projects', []))]}
    return payload
