"""Global Git endpoints; never forwarded through a remote-project channel."""
from pydantic import BaseModel, Field, field_validator
from fastapi import APIRouter, HTTPException, Query
from services.git import git_service
from services.git.command import GitError

router = APIRouter(prefix='/api/git', tags=['git'])


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


class FileActionRequest(BaseModel):
    path: str = Field(min_length=1, max_length=4096)
    snapshot: str = Field(min_length=64, max_length=64)


class SaveFileRequest(FileActionRequest):
    content: str = Field(max_length=2 * 1024 * 1024)


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
    return await result(git_service.save_file(id, body.path, body.content, body.snapshot))


@router.post('/worktrees/{id}/commit-message')
async def commit_message(id: str, body: CommitMessageRequest):
    return await result(git_service.generate_commit_message(id, body.paths, body.snapshot))


@router.post('/worktrees/{id}/switch')
async def switch(id: str, body: SwitchRequest):
    return await result(git_service.switch(id, body.branch, body.snapshot))


@router.post('/worktrees/{id}/fetch')
async def fetch(id: str):
    return await result(git_service.fetch(id))


@router.post('/worktrees/{id}/pull')
async def pull(id: str, body: SwitchRequest):
    return await result(git_service.pull(id, body.branch, body.snapshot))


@router.post('/worktrees/{id}/push')
async def push(id: str, body: SwitchRequest):
    return await result(git_service.push(id, body.branch, body.snapshot))
