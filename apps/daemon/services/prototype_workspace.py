"""Persistent prototype copies and recoverable publication. Call in an I/O worker."""
from hashlib import sha256
import json
import os
import shutil
import difflib
from pathlib import Path
import threading
import time
import uuid

from services.prototype_source import HtmlSource, SourceConflict

EDITABLE = frozenset({'.html', '.htm', '.css', '.js', '.mjs'})
RESOURCES = EDITABLE | {'.json', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.otf'}
EXCLUDED = {'node_modules', '.git', '.workstep', '__pycache__', 'dist', 'build', '.venv'}
MAX_FILE = 25 * 1024 * 1024
MAX_TOTAL = 500 * 1024 * 1024
_locks: dict[str, threading.RLock] = {}
_guard = threading.RLock()
PROCESS_ID = uuid.uuid4().hex


def digest(content: bytes):
    return sha256(content).hexdigest()


def atomic_write(path: Path, content: bytes):
    if path.is_symlink():
        raise ValueError('不允许符号链接')
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f'.{path.name}.{uuid.uuid4().hex}.tmp')
    try:
        with temporary.open('xb') as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def safe_path(root: Path, relative: str, *, allow_hidden=False):
    candidate = Path(relative)
    if candidate.is_absolute() or not candidate.parts or any(part in {'.', '..'} or (part.startswith('.') and not allow_hidden) for part in candidate.parts):
        raise ValueError('文件路径无效')
    target = root
    for part in candidate.parts:
        target = target / part
        if target.is_symlink():
            raise ValueError('不允许符号链接')
    if not target.resolve().is_relative_to(root.resolve()):
        raise ValueError('文件超出工作区')
    return target


def resource_contains(root: Path, target: Path):
    """Match the same directory exclusions used when copying resources."""
    if not target.is_relative_to(root):
        return False
    return not any(part in EXCLUDED or part.startswith('.') for part in target.relative_to(root).parts)


def resource_paths(root):
    paths, total = [], 0
    for current, dirs, names in os.walk(root, followlinks=False):
        dirs[:] = [d for d in dirs if d not in EXCLUDED and not d.startswith('.') and not (Path(current) / d).is_symlink()]
        for name in names:
            path = Path(current) / name
            if name.startswith('.') or path.suffix.lower() not in RESOURCES:
                continue
            if path.is_symlink():
                raise ValueError('原型资源不能包含符号链接')
            size = path.stat().st_size
            total += size
            if size > MAX_FILE or total > MAX_TOTAL:
                raise ValueError('原型资源超过限制（单文件 25 MB，工作区 500 MB）')
            paths.append(path)
    return paths


class PrototypeWorkspace:
    def __init__(self, project_root: Path, data_root: Path, workspace_id: str):
        if len(workspace_id) != 32 or any(c not in '0123456789abcdef' for c in workspace_id):
            raise ValueError('工作区标识无效')
        self.project_root = project_root.resolve()
        self.data_root = data_root.resolve()
        self.id = workspace_id
        self.directory = data_root / 'prototype-editor' / workspace_id
        with _guard:
            self.lock = _locks.setdefault(str(self.directory), threading.RLock())

    @classmethod
    def open(cls, project_root: Path, data_root: Path, entry: Path, root: Path | None = None):
        with _guard:
            return cls._open(project_root, data_root, entry, root)

    @classmethod
    def _open(cls, project_root: Path, data_root: Path, entry: Path, root: Path | None = None):
        project_root = project_root.resolve()
        entry = entry.absolute()
        data_root = data_root.resolve()
        domain = project_root if entry.is_relative_to(project_root) else data_root
        if not entry.is_relative_to(domain) or entry.suffix.lower() not in {'.html', '.htm'} or entry.is_relative_to(data_root / 'prototype-editor'):
            raise ValueError('请选择项目内的 HTML 文件')
        safe_path(domain, entry.relative_to(domain).as_posix(), allow_hidden=True)
        root = (root or entry.parent).resolve()
        if not root.is_relative_to(domain) or not entry.is_relative_to(root):
            raise ValueError('原型目录必须位于项目内并包含当前文件')
        base = data_root / 'prototype-editor'
        with _guard:
            for record in base.glob('*/journal.json'):
                metadata = json.loads(record.read_text())
                registered = (data_root if metadata.get('root_kind') == 'data' else project_root) / metadata['root']
                if resource_contains(registered, entry):
                    work = cls(project_root, data_root, record.parent.name)
                    work.refresh_sources()
                    if entry.relative_to(registered).as_posix() not in work.load()['documents']:
                        raise SourceConflict('工作区有未完成修改，请处理后再打开新文件')
                    return work
                if resource_contains(root, registered):
                    raise ValueError('原型目录与已有工作区重叠')
            workspace_id = uuid.uuid4().hex
        work = cls(project_root, data_root, workspace_id)
        paths = resource_paths(root)
        with work.lock:
            try:
                files = {}
                for path in paths:
                    relative = path.relative_to(root).as_posix()
                    content = path.read_bytes()
                    files[relative] = work.store_blob(content)
                    atomic_write(work.directory / 'workspace' / relative, content)
                if entry.relative_to(root).as_posix() not in files:
                    raise ValueError('HTML 文件不存在')
                work.save({'root': root.relative_to(domain).as_posix(), 'root_kind': 'project' if domain == project_root else 'data', 'files': files,
                           'documents': {path: uuid.uuid4().hex for path in files if Path(path).suffix.lower() in {'.html', '.htm'}},
                           'status': 'idle', 'history': [], 'pending': None})
            except BaseException:
                if work.directory.exists():
                    shutil.rmtree(work.directory)
                raise
        return work

    def load(self):
        with self.lock:
            data = json.loads((self.directory / 'journal.json').read_text())
            if data['status'] == 'running' and data.get('process_id') != PROCESS_ID:
                data.update(status='interrupted', error='服务中断，工作副本已保留')
                self.save(data)
            return data

    def original(self, data=None):
        data = data or self.load()
        base = self.data_root if data.get('root_kind') == 'data' else self.project_root
        root = base if data['root'] == '.' else safe_path(base, data['root'], allow_hidden=True)
        return root

    def save(self, value):
        atomic_write(self.directory / 'journal.json', json.dumps(value, ensure_ascii=False).encode())

    def store_blob(self, content):
        key = digest(content)
        path = self.directory / 'history' / key
        if not path.exists():
            atomic_write(path, content)
        return key

    def blob(self, key):
        return (self.directory / 'history' / key).read_bytes()

    def state(self):
        with self.lock:
            data = self.load()
            return {'id': self.id, 'root': data['root'], 'status': data['status'],
                    'documents': [{'path': path, 'id': key} for path, key in data['documents'].items()],
                    'files': list(data['files']), 'history': data['history'],
                    'error': data.get('error', ''), 'pending': data.get('pending') is not None,
                    'bytes': sum(p.stat().st_size for p in self.directory.rglob('*') if p.is_file() and not p.is_symlink())}

    def document(self, path):
        data = self.load()
        if path not in data['documents']:
            raise ValueError('HTML 未登记')
        target = safe_path(self.directory / 'workspace', path)
        if target.stat().st_size > MAX_FILE:
            raise ValueError('文件过大')
        return HtmlSource(target.read_bytes().decode('utf-8'))

    def refresh_sources(self):
        with self.lock:
            data = self.load()
            if data['status'] != 'idle':
                return
            original = self.original(data)
            paths = resource_paths(original)
            files = {}
            for path in paths:
                relative = path.relative_to(original).as_posix()
                content = path.read_bytes()
                files[relative] = self.store_blob(content)
                atomic_write(safe_path(self.directory / 'workspace', relative), content)
                if path.suffix.lower() in {'.html', '.htm'}:
                    data['documents'].setdefault(relative, uuid.uuid4().hex)
            for removed in set(data['files']) - set(files):
                safe_path(self.directory / 'workspace', removed).unlink(missing_ok=True)
                data['documents'].pop(removed, None)
            data['files'] = files
            self.save(data)
            self.prune()

    def begin(self, label):
        with self.lock:
            data = self.load()
            if data['status'] != 'idle':
                raise SourceConflict('工作区有运行中或未处理的修改')
            self.refresh_sources()
            data = self.load()
            data.update(status='running', process_id=PROCESS_ID, pending={'label': label, 'before': dict(data['files']), 'changes': {}}, error='')
            self.save(data)

    def interrupt(self, message='执行中断，工作副本已保留'):
        with self.lock:
            data = self.load()
            if data['status'] == 'running':
                data.update(status='interrupted', error=message)
                self.save(data)

    def publish(self):
        with self.lock:
            try:
                return self._publish()
            except (ValueError, OSError) as exc:
                data = self.load()
                if data['status'] != 'publishing':
                    data['status'] = 'conflict'
                data['error'] = str(exc)
                self.save(data)
                raise SourceConflict(str(exc)) from exc

    def _publish(self):
        with self.lock:
            data = self.load()
            pending = data.get('pending')
            if not pending:
                return self.state()
            original = self.original(data)
            if data['status'] != 'publishing':
                changes = {}
                copied = {p.relative_to(self.directory / 'workspace').as_posix()
                          for p in resource_paths(self.directory / 'workspace')}
                if copied != set(pending['before']):
                    data.update(status='conflict', error='工作副本新增或删除了文件；本版仅支持修改已有文件，请保留副本检查或放弃修改')
                    self.save(data)
                    raise SourceConflict(data['error'])
                for path, before in pending['before'].items():
                    target = safe_path(self.directory / 'workspace', path)
                    if not target.is_file():
                        raise SourceConflict('工作副本删除了文件，请处理后再保存')
                    if target.stat().st_size > MAX_FILE:
                        raise ValueError('文件过大')
                    content = target.read_bytes()
                    after = digest(content)
                    if after != before:
                        if Path(path).suffix.lower() not in EDITABLE:
                            data.update(status='conflict', error='本版只发布 HTML、CSS 和 JS 修改')
                            self.save(data)
                            raise SourceConflict(data['error'])
                        if digest(safe_path(original, path).read_bytes()) != before:
                            data.update(status='conflict', error=f'原文件已变化：{path}')
                            self.save(data)
                            raise SourceConflict(data['error'])
                        changes[path] = {'before': before, 'after': self.store_blob(content)}
                pending['changes'] = changes
                data['status'] = 'publishing'
                self.save(data)
            for path, change in pending['changes'].items():
                destination = safe_path(original, path)
                current = digest(destination.read_bytes())
                if current not in {change['before'], change['after']}:
                    raise SourceConflict(f'回写冲突：{path}')
                if current != change['after']:
                    atomic_write(destination, self.blob(change['after']))
                data['files'][path] = change['after']
            if pending['changes']:
                if pending.get('undo_id'):
                    for item in data['history']:
                        if item['id'] == pending['undo_id']:
                            item['undone'] = True
                data['history'].append({'undo_id': pending.get('undo_id'), 'id': uuid.uuid4().hex, 'label': pending['label'],
                                        'time': time.time(), 'changes': pending['changes']})
            data.update(status='idle', pending=None, error='')
            data['history'] = data['history'][-30:]
            self.save(data)
            self.prune()
            return self.state()

    def edit(self, path, node_id, operation, values, version):
        with self.lock:
            document = self.document(path)
            result = document.edit(node_id, operation, values, version)
            self.begin(f'{operation}: {path}')
            # begin refreshed external state: never apply an old source range.
            if self.document(path).version != version:
                self.discard()
                raise SourceConflict('原文件已更新，请刷新预览')
            atomic_write(safe_path(self.directory / 'workspace', path), result.encode())
            return self.publish()

    def discard(self):
        with self.lock:
            data = self.load()
            if data['status'] == 'publishing':
                raise SourceConflict('回写未完成，请先恢复回写')
            copied = self.directory / 'workspace'
            for extra in copied.rglob('*'):
                if (extra.is_file() or extra.is_symlink()) and extra.relative_to(copied).as_posix() not in data['files']:
                    extra.unlink()
            for path in data['files']:
                content = safe_path(self.original(data), path).read_bytes()
                data['files'][path] = self.store_blob(content)
                atomic_write(safe_path(self.directory / 'workspace', path), content)
            data.update(status='idle', pending=None, error='')
            self.save(data)
            return self.state()

    def undo(self):
        with self.lock:
            data = self.load()
            if data['status'] != 'idle' or not data['history']:
                raise SourceConflict('当前无法撤销')
            item = next((item for item in reversed(data['history']) if not item.get('undone') and not item.get('undo_id')), None)
            if item is None:
                raise SourceConflict('没有可撤销的修改')
            original = self.original(data)
            for path, change in item['changes'].items():
                if digest(safe_path(original, path).read_bytes()) != change['after']:
                    raise SourceConflict('文件已有其他修改，不能覆盖撤销')
            self.begin('撤销：' + item['label'])
            data = self.load()
            data['pending']['undo_id'] = item['id']
            self.save(data)
            for path, change in item['changes'].items():
                atomic_write(safe_path(self.directory / 'workspace', path), self.blob(change['before']))
            return self.publish()

    def clean_history(self):
        with self.lock:
            data = self.load()
            if data['status'] != 'idle':
                raise SourceConflict('有未完成的修改，不能清理')
            data['history'] = []
            self.save(data)
            self.prune()
            return self.state()

    def diff(self, revision='pending'):
        with self.lock:
            data = self.load()
            if revision == 'pending':
                if not data['pending']:
                    return {'diff': ''}
                changes = {}
                for path, before in data['pending']['before'].items():
                    target = safe_path(self.directory / 'workspace', path)
                    if target.is_file() and target.stat().st_size <= MAX_FILE:
                        changes[path] = (self.blob(before), target.read_bytes())
            else:
                item = next((item for item in data['history'] if item['id'] == revision), None)
                if item is None:
                    raise ValueError('历史版本不存在')
                changes = {path: (self.blob(change['before']), self.blob(change['after'])) for path, change in item['changes'].items()}
            output = []
            for path, (before, after) in changes.items():
                if before == after or Path(path).suffix.lower() not in EDITABLE:
                    continue
                output.extend(difflib.unified_diff(before.decode('utf-8', errors='replace').splitlines(True),
                    after.decode('utf-8', errors='replace').splitlines(True), fromfile=path, tofile=path))
                if sum(map(len, output)) > 200000:
                    break
            return {'diff': ''.join(output)[:200000]}

    def prune(self):
        data = self.load()
        if data['pending']:
            return
        def references():
            return set(data['files'].values()) | {key for item in data['history'] for change in item['changes'].values() for key in change.values()}
        while len(data['history']) > 1 and sum((self.directory / 'history' / key).stat().st_size for key in references()) > 200 * 1024 * 1024:
            data['history'].pop(0)
        self.save(data)
        keep = references()
        for path in (self.directory / 'history').iterdir():
            if path.name not in keep and path.is_file() and not path.is_symlink():
                path.unlink()
