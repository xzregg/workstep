"""Local Git workspace discovery and authorized operations."""
import asyncio
import hashlib
import os
import time
import uuid
from pathlib import Path

from .command import GitError, run_git, text
from .query import GitQueries
from .write import GitWrites


def identity(path):
    return hashlib.sha256(os.fsencode(str(path))).hexdigest()[:24]


def directory_entries(path):
    with os.scandir(path) as entries:
        return [(entry.name, entry.is_dir(follow_symlinks=False)) for entry in entries]


def validate_gitignore(path):
    target = path / '.gitignore'
    if target.is_symlink() or (target.exists() and not target.is_file()):
        raise GitError('.gitignore 不是可安全写入的普通文件。')


def ensure_gitignore(path):
    target = path / '.gitignore'
    current = target.read_text(encoding='utf-8', errors='surrogateescape') if target.exists() else ''
    if '.workstep/' in current.splitlines():
        return
    with target.open('a', encoding='utf-8', errors='surrogateescape') as stream:
        if current and not current.endswith('\n'):
            stream.write('\n')
        stream.write('.workstep/\n')


class GitService(GitQueries, GitWrites):
    def __init__(self, projects_provider, depth_provider, active_provider=lambda _: False):
        self.projects_provider = projects_provider
        self.depth_provider = depth_provider
        self.active_provider = active_provider
        self.snapshot = {'projects': [], 'repositories': [], 'depth': 5, 'scanned_at': None, 'errors': []}
        self.jobs = {}
        self.tasks = set()
        self.generation = 0
        self.directories = {}
        self.locks = {}
        self.fetched_at = {}
        self.read_slots = asyncio.Semaphore(4)

    async def close(self):
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)

    async def command(self, path, *args, **kwargs):
        async with self.read_slots:
            return await run_git(path, *args, **kwargs)

    async def initialize(self, project_id):
        projects = await asyncio.to_thread(lambda: [dict(project) for project in self.projects_provider()])
        project = next((project for project in projects if project['id'] == project_id), None)
        if not project:
            raise GitError('项目不存在或已移除。', 404)
        root = await asyncio.to_thread(Path(project['path']).resolve)
        if not await asyncio.to_thread(root.is_dir):
            raise GitError('项目目录不存在。', 404)
        lock = self.locks.setdefault('project:' + project_id, asyncio.Lock())
        async with lock:
            marker = root / '.git'
            if await asyncio.to_thread(lambda: marker.exists() or marker.is_symlink()):
                raise GitError('项目根目录已经是 Git 仓库。', 409)
            await asyncio.to_thread(validate_gitignore, root)
            await self.command(root, 'init', '-b', 'main')
            await asyncio.to_thread(ensure_gitignore, root)
        return {'project_id': project_id, 'path': str(root)}

    async def start_scan(self):
        self.generation += 1
        generation = self.generation
        job = {'id': uuid.uuid4().hex, 'state': 'running', 'completed_projects': 0, 'total_projects': 0, 'errors': []}
        self.jobs[job['id']] = job
        # Superseded scans may finish, but can never publish over a newer generation.
        task = asyncio.create_task(self.scan(job, generation))
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        for key in list(self.jobs)[:-16]:
            if self.jobs[key]['state'] != 'running':
                self.jobs.pop(key, None)
        return job

    async def scan(self, job, generation):
        try:
            projects = [dict(p) for p in self.projects_provider()]
            depth = await asyncio.to_thread(self.depth_provider)
            job['total_projects'] = len(projects)
            repositories = {}
            verified = {}
            for project in projects:
                if generation != self.generation:
                    job['state'] = 'superseded'
                    return
                root = await asyncio.to_thread(Path(project['path']).resolve)
                project['path'] = str(root)
                stack = [(root, 0)]
                while stack:
                    if generation != self.generation:
                        job['state'] = 'superseded'
                        return
                    path, level = stack.pop()
                    try:
                        entries = await asyncio.to_thread(directory_entries, path)
                        if level < depth:
                            stack.extend((path / name, level + 1) for name, is_dir in entries
                                         if is_dir and name not in {'.git', '.workstep', 'node_modules', '.venv'})
                        if any(name == '.git' for name, _ in entries):
                            if str(path) not in verified:
                                verified[str(path)] = await self.discover_repository(path)
                            found = verified[str(path)]
                            repo = repositories.setdefault(found['id'], {**found, 'projects': []})
                            membership = {'id': project['id'], 'relative_path': str(path.relative_to(root))}
                            if membership not in repo['projects']:
                                repo['projects'].append(membership)
                    except (OSError, GitError) as exc:
                        job['errors'].append({'project_id': project['id'], 'path': str(path), 'message': str(exc)})
                job['completed_projects'] += 1
            if generation == self.generation:
                self.directories = {w['id']: {**w, 'repo_id': r['id'], 'common_dir': r['common_dir'],
                    'project_ids': [p['id'] for p in r['projects']]}
                    for r in repositories.values() for w in r['worktrees']}
                self.snapshot = {'projects': projects, 'repositories': list(repositories.values()),
                    'depth': depth, 'scanned_at': time.time(), 'errors': job['errors']}
                job['state'] = 'complete'
            else:
                job['state'] = 'superseded'
        except asyncio.CancelledError:
            job['state'] = 'cancelled'
            raise
        except Exception as exc:
            job.update(state='failed', error=str(exc))

    async def discover_repository(self, path):
        raw, _ = await self.command(path, 'rev-parse', '--path-format=absolute', '--git-common-dir')
        common = str(await asyncio.to_thread(Path(text(raw).strip()).resolve))
        raw, _ = await self.command(path, 'worktree', 'list', '--porcelain', '-z')
        trees = []
        current = {}
        for field in raw.split(b'\0'):
            if not field:
                if current:
                    tree_path = current['path']
                    current.update(id=identity(tree_path), available=await asyncio.to_thread(Path(tree_path).is_dir))
                    trees.append(current)
                    current = {}
                continue
            key, _, value = field.partition(b' ')
            if key == b'worktree':
                current = {'path': text(value), 'branch': None, 'head': '', 'locked': False, 'prunable': False}
            elif key == b'branch':
                current['branch'] = text(value).removeprefix('refs/heads/')
            elif key == b'HEAD':
                current['head'] = text(value)
            elif key in {b'locked', b'prunable'}:
                current[text(key)] = True
        for index, tree in enumerate(trees):
            tree['main'] = index == 0
        return {'id': identity(common), 'common_dir': common, 'name': path.name, 'worktrees': trees}

    async def directory(self, id):
        directory = self.directories.get(id)
        if not directory or not set(directory['project_ids']).intersection(p['id'] for p in self.projects_provider()):
            raise GitError('工作目录未授权或已移除，请重新扫描。', 404)
        if not await asyncio.to_thread(Path(directory['path']).is_dir):
            raise GitError('工作目录已不存在，请重新扫描。', 404)
        raw, _ = await self.command(directory['path'], 'rev-parse', '--path-format=absolute', '--git-common-dir')
        actual = str(await asyncio.to_thread(Path(text(raw).strip()).resolve))
        if actual != directory['common_dir']:
            raise GitError('仓库位置已变化，请重新扫描。', 409)
        return directory


def local_projects():
    from services.project import project_manager
    return [{'id': p.id, 'name': p.name, 'path': str(p.path)} for p in project_manager.iter_projects()]


def project_active(id):
    from services.concurrency import concurrency_gate
    counts = concurrency_gate.active_count(id)
    return counts['tasks_running'] > 0 or counts['chats_running'] > 0


def scan_depth():
    from services.config import config_store
    return config_store.get_git_scan_depth()


git_service = GitService(local_projects, scan_depth, project_active)
