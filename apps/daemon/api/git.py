"""Git endpoints with project ownership checks for remote requests."""
import asyncio
import time
from pydantic import BaseModel, Field, field_validator
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from services.git import git_service
from services.git.command import GitError
from services.git.task_workspace import TaskGitWorkspace

async def project_scope(request: Request, scoped_project: str | None = Query(None, alias='project_id')):
    if not scoped_project:
        return
    path = request.url.path
    if path.startswith('/api/git/projects/'):
        if request.path_params.get('project_id') != scoped_project:
            raise HTTPException(403, 'Git 项目不匹配。')
        return
    if path.startswith('/api/git/worktrees/') and not path.endswith('/identity/global') and '/credentials' not in path:
        directory = git_service.directories.get(request.path_params.get('id'))
        if not directory or scoped_project not in directory['project_ids']:
            raise HTTPException(403, 'Git 工作目录不属于当前项目。')
        return
    raise HTTPException(403, '远程项目不能修改全局 Git 设置。')


router = APIRouter(prefix='/api/git', tags=['git'], dependencies=[Depends(project_scope)])


def _task_project(project_id: str):
    from services.project import project_manager
    project = project_manager.get_project_by_id(project_id)
    if project is None:
        raise HTTPException(404, '项目不存在。')
    return project


async def _task_exists(project_id: str, task_id: str, *, editable: bool = False):
    from services.project import project_manager

    from services.task_queries import task_workspace_state
    task = await project_manager.run_db(project_id, lambda _project: task_workspace_state(task_id))
    if task is None:
        raise HTTPException(404, '任务不存在。')
    if editable and task['status'] in {'running', 'queued'}:
        raise HTTPException(409, '任务运行或排队时不能移除工作目录。')
    return task


class AddTaskWorktreeRequest(BaseModel):
    repository_id: str = Field(min_length=1)
    alias: str = Field(min_length=1, max_length=64)
    base_ref: str = Field(default='HEAD', min_length=1, max_length=1024)
    branch_name: str | None = Field(default=None, min_length=1, max_length=255)


class RecoveryRequest(BaseModel):
    mode: str
    target: str = Field(min_length=1)
    commit: str | None = None
    operation_id: str | None = None
    expected_head: str | None = None


@router.get('/projects/{project_id}/tasks/{task_id}/workspace')
async def task_workspace(project_id: str, task_id: str):
    project = _task_project(project_id)
    task = await _task_exists(project_id, task_id)
    return await result(TaskGitWorkspace(git_service, task['workflow_id']).list(project.path, task_id))


@router.post('/projects/{project_id}/tasks/{task_id}/workspace')
async def open_task_workspace(project_id: str, task_id: str):
    project = _task_project(project_id)
    task = await _task_exists(project_id, task_id)
    return await result(TaskGitWorkspace(git_service, task['workflow_id']).ensure(project.path, task_id, creator_name=task['creator_name']))


@router.delete('/projects/{project_id}/tasks/{task_id}/workspace')
async def delete_task_workspace(project_id: str, task_id: str, force: bool = False):
    project = _task_project(project_id)
    task = await _task_exists(project_id, task_id, editable=True)
    return await result(TaskGitWorkspace(git_service, task['workflow_id']).delete(project.path, task_id, force=force))


@router.post('/projects/{project_id}/tasks/{task_id}/worktrees')
async def add_task_worktree(project_id: str, task_id: str, body: AddTaskWorktreeRequest):
    project = _task_project(project_id)
    task = await _task_exists(project_id, task_id)
    return await result(TaskGitWorkspace(git_service, task['workflow_id']).add(
        project.path, task_id, body.repository_id, body.alias, body.base_ref, body.branch_name,
        creator_name=task['creator_name'],
    ))


@router.delete('/projects/{project_id}/tasks/{task_id}/worktrees/{alias}')
async def remove_task_worktree(project_id: str, task_id: str, alias: str, force: bool = False):
    project = _task_project(project_id)
    task = await _task_exists(project_id, task_id, editable=True)
    return await result(TaskGitWorkspace(git_service, task['workflow_id']).remove(project.path, task_id, alias, force=force))


@router.post('/scans')
async def start_scan():
    return await git_service.start_scan()


@router.get('/scans/{id}')
async def scan_progress(id: str):
    if id not in git_service.jobs:
        raise HTTPException(404, '扫描记录不存在，请重新扫描。')
    return git_service.jobs[id]


@router.get('/repositories')
async def repositories():
    return git_service.snapshot


@router.get('/projects/{project_id}/repositories')
async def project_repositories(project_id: str, refresh: bool = False):
    _task_project(project_id)
    if refresh or git_service.snapshot['scanned_at'] is None or time.time() - git_service.snapshot['scanned_at'] > 30:
        job = await git_service.start_scan()
        while job['state'] == 'running':
            await asyncio.sleep(0.05)
        if job['state'] != 'complete':
            raise HTTPException(503, 'Git 仓库扫描失败，请重试。')
    snapshot = git_service.snapshot
    return {**snapshot, 'projects': [p for p in snapshot['projects'] if p['id'] == project_id],
        'errors': [e for e in snapshot['errors'] if e.get('project_id') == project_id], 'repositories': [
        {**repo, 'projects': [p for p in repo['projects'] if p['id'] == project_id]}
        for repo in git_service.snapshot['repositories']
        if any(item['id'] == project_id for item in repo['projects'])
    ]}


@router.post('/projects/{project_id}/initialize')
async def initialize(project_id: str):
    return await result(git_service.initialize(project_id))


async def result(operation):
    try:
        return await operation
    except GitError as exc:
        raise HTTPException(exc.status, str(exc)) from exc
    except OSError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get('/worktrees/{id}/status')
async def status(id: str):
    return await result(git_service.status(id))


@router.get('/worktrees/{id}/branches')
async def branches(id: str):
    return await result(git_service.branches(id))


@router.get('/worktrees/{id}/remotes')
async def remotes(id: str):
    return await result(git_service.remotes(id))


class GitIdentityRequest(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    email: str = Field(min_length=3, max_length=320)

    @field_validator('name', 'email')
    @classmethod
    def valid_identity(cls, value):
        value = value.strip()
        if not value or any(c in value for c in '\r\n\0'):
            raise ValueError('用户名和邮箱不能为空或包含换行符')
        return value

    @field_validator('email')
    @classmethod
    def valid_email(cls, value):
        if '@' not in value or value.startswith('@') or value.endswith('@'):
            raise ValueError('邮箱格式无效')
        return value


@router.get('/worktrees/{id}/identity')
async def identity(id: str):
    return await result(git_service.identity(id))


@router.put('/worktrees/{id}/identity')
async def set_identity(id: str, body: GitIdentityRequest):
    return await result(git_service.set_identity(id, body.name, body.email))


@router.get('/worktrees/{id}/identity/global')
async def global_identity(id: str):
    return await result(git_service.global_identity(id))


@router.put('/worktrees/{id}/identity/global')
async def set_global_identity(id: str, body: GitIdentityRequest):
    return await result(git_service.set_global_identity(id, body.name, body.email))


@router.get('/worktrees/{id}/history')
async def history(id: str, ref: str | None = None, offset: int = Query(0, ge=0, le=1000000)):
    return await result(git_service.history(id, ref, offset))


@router.get('/worktrees/{id}/changes')
async def changes(id: str, ref: str | None = None, commit: str | None = None):
    return await result(git_service.changes(id, ref, commit))


@router.get('/worktrees/{id}/diff')
async def diff(id: str, path: str, ref: str | None = None, commit: str | None = None):
    return await result(git_service.diff(id, path, ref, commit))


@router.get('/worktrees/{id}/blame')
async def blame(id: str, path: str, ref: str | None = None):
    return await result(git_service.blame(id, path, ref))


class CommitRequest(BaseModel):
    paths: list[str] = Field(min_length=1, max_length=10000)
    message: str = Field(min_length=1, max_length=100000)
    snapshot: str = Field(min_length=64, max_length=64)

    @field_validator('message')
    @classmethod
    def nonempty(cls, value):
        if not value.strip() or '\0' in value:
            raise ValueError('提交说明不能为空或包含空字符')
        return value.strip()


class SwitchRequest(BaseModel):
    branch: str = Field(min_length=1, max_length=1024)
    snapshot: str = Field(min_length=64, max_length=64)


class BranchSwitchRequest(SwitchRequest):
    remote: str | None = Field(default=None, min_length=1, max_length=1024)


class MergeRequest(SwitchRequest):
    source: str = Field(min_length=1, max_length=1024)
    remote: str | None = Field(default=None, min_length=1, max_length=1024)


class MergeIntoRequest(SwitchRequest):
    target: str = Field(min_length=1, max_length=1024)


class PushBranchRequest(BaseModel):
    branch: str = Field(min_length=1, max_length=1024)
    head: str = Field(min_length=40, max_length=64)
    remote: str | None = Field(default=None, min_length=1, max_length=1024)
    target_branch: str | None = Field(default=None, min_length=1, max_length=1024)
    set_upstream: bool = False


class CreateBranchRequest(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    base_branch: str = Field(min_length=1, max_length=1024)
    base_remote: str | None = Field(default=None, min_length=1, max_length=1024)
    base_head: str = Field(min_length=40, max_length=64)
    snapshot: str = Field(min_length=64, max_length=64)


class DeleteBranchRequest(BaseModel):
    branch: str = Field(min_length=1, max_length=1024)
    head: str = Field(min_length=40, max_length=64)
    snapshot: str = Field(min_length=64, max_length=64)


class RemoteSyncRequest(SwitchRequest):
    remote: str | None = Field(default=None, min_length=1, max_length=1024)
    target_branch: str | None = Field(default=None, min_length=1, max_length=1024)
    set_upstream: bool = False


class GitAuth(BaseModel):
    username: str = Field(min_length=1, max_length=200)
    token: str = Field(min_length=1, max_length=4096)

    @field_validator('username', 'token')
    @classmethod
    def no_control_characters(cls, value):
        if any(c in value for c in '\r\n\0'):
            raise ValueError('凭据不能包含换行符或空字符')
        return value


class GitCredentialRequest(GitAuth):
    remote: str = Field(min_length=1, max_length=1024)


class GitHostCredentialRequest(GitAuth):
    host: str = Field(min_length=1, max_length=253)


class RemoteRequest(BaseModel):
    remote: str = Field(min_length=1, max_length=1024)


@router.get('/worktrees/{id}/credentials')
async def credentials(id: str):
    return await result(git_service.credentials(id))


@router.get('/credentials')
async def credential_hosts():
    return await result(git_service.credential_hosts())


@router.put('/credentials')
async def save_host_credentials(body: GitHostCredentialRequest):
    return await result(git_service.save_host_credentials(body.host, body.username, body.token))


@router.delete('/credentials/{host}')
async def clear_host_credentials(host: str):
    return await result(git_service.clear_host_credentials(host))


@router.put('/worktrees/{id}/credentials')
async def save_credentials(id: str, body: GitCredentialRequest):
    return await result(git_service.save_credentials(id, body.remote, body.username, body.token))


@router.delete('/worktrees/{id}/credentials/{remote}')
async def clear_credentials(id: str, remote: str):
    return await result(git_service.clear_credentials(id, remote))


class FileActionRequest(BaseModel):
    path: str = Field(min_length=1, max_length=4096)
    snapshot: str = Field(min_length=64, max_length=64)


class SaveFileRequest(FileActionRequest):
    content: str = Field(max_length=2 * 1024 * 1024)
    expected_content: str | None = Field(default=None, max_length=2 * 1024 * 1024)


class CommitMessageRequest(BaseModel):
    paths: list[str] = Field(min_length=1, max_length=500)
    snapshot: str = Field(min_length=64, max_length=64)


@router.post('/worktrees/{id}/commit')
async def commit(id: str, body: CommitRequest):
    return await result(git_service.commit(id, body.paths, body.message, body.snapshot))


@router.post('/worktrees/{id}/discard')
async def discard(id: str, body: FileActionRequest):
    return await result(git_service.discard(id, body.path, body.snapshot))


@router.post('/worktrees/{id}/ignore')
async def ignore(id: str, body: FileActionRequest):
    return await result(git_service.ignore(id, body.path, body.snapshot))


@router.post('/worktrees/{id}/files/content')
async def save_file(id: str, body: SaveFileRequest):
    return await result(git_service.save_file(id, body.path, body.content, body.snapshot, body.expected_content))


@router.post('/worktrees/{id}/commit-message')
async def commit_message(id: str, body: CommitMessageRequest):
    return await result(git_service.generate_commit_message(id, body.paths, body.snapshot))


@router.post('/worktrees/{id}/switch')
async def switch(id: str, body: BranchSwitchRequest):
    return await result(git_service.switch(id, body.branch, body.snapshot, body.remote))


@router.post('/worktrees/{id}/advance')
async def advance(id: str, body: SwitchRequest):
    return await result(git_service.advance(id, body.branch, body.snapshot))


@router.post('/worktrees/{id}/merge')
async def merge(id: str, body: MergeRequest):
    return await result(git_service.merge(id, body.branch, body.snapshot, body.source, body.remote))


@router.post('/worktrees/{id}/merge-into')
async def merge_into(id: str, body: MergeIntoRequest):
    return await result(git_service.merge_into(id, body.branch, body.snapshot, body.target))


@router.get('/worktrees/{id}/recoveries')
async def recoveries(id: str):
    return await result(git_service.recoveries(id))


@router.post('/worktrees/{id}/recovery/preview')
async def recovery_preview(id: str, body: RecoveryRequest):
    return await result(git_service.recovery_preview(id, body.mode, body.target, body.commit, body.operation_id))


@router.post('/worktrees/{id}/recovery/apply')
async def recovery_apply(id: str, body: RecoveryRequest):
    if not body.expected_head:
        raise HTTPException(422, '缺少预览时的目标提交。')
    return await result(git_service.recovery_apply(id, body.mode, body.target, body.expected_head,
                                                   body.commit, body.operation_id))


@router.post('/worktrees/{id}/branches')
async def create_branch(id: str, body: CreateBranchRequest):
    return await result(git_service.create_branch(id, body.name, body.base_branch, body.base_head,
                                                  body.snapshot, body.base_remote))


@router.post('/worktrees/{id}/branches/delete')
async def delete_branch(id: str, body: DeleteBranchRequest):
    return await result(git_service.delete_branch(id, body.branch, body.head, body.snapshot))


@router.post('/worktrees/{id}/push-branch')
async def push_branch(id: str, body: PushBranchRequest):
    return await result(git_service.push_branch(id, body.branch, body.head,
                                                body.remote, body.target_branch, body.set_upstream))


@router.post('/worktrees/{id}/fetch')
async def fetch(id: str):
    return await result(git_service.fetch(id))


@router.post('/worktrees/{id}/fetch-remote')
async def fetch_remote(id: str, body: RemoteRequest):
    return await result(git_service.fetch_remote(id, body.remote))


@router.post('/worktrees/{id}/pull')
async def pull(id: str, body: RemoteSyncRequest):
    return await result(git_service.pull(id, body.branch, body.snapshot, body.remote, body.target_branch, body.set_upstream))


@router.post('/worktrees/{id}/push')
async def push(id: str, body: RemoteSyncRequest):
    return await result(git_service.push(id, body.branch, body.snapshot, body.remote, body.target_branch, body.set_upstream))
