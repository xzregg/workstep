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
from services.prototype_resources import EDITABLE, RESOURCES, EXCLUDED, collect_resources

MAX_FILE = 25 * 1024 * 1024
MAX_TOTAL = 500 * 1024 * 1024
_locks: dict[str, threading.RLock] = {}
_guard = threading.RLock()
PROCESS_ID = uuid.uuid4().hex


def digest(content: bytes):
    return sha256(content).hexdigest()


def atomic_write(path: Path, content: bytes):
    if path.is_symlink():
        raise ValueError('Symbolic links are not allowed')
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
        raise ValueError('Invalid file path')
    target = root
    for part in candidate.parts:
        target = target / part
        if target.is_symlink():
            raise ValueError('Symbolic links are not allowed')
    if not target.resolve().is_relative_to(root.resolve()):
        raise ValueError('File exceeds workspace')
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
                raise ValueError('Prototype resources cannot contain symbolic links')
            size = path.stat().st_size
            total += size
            if size > MAX_FILE or total > MAX_TOTAL:
                raise ValueError('Prototype resources exceed the limit (single file 25 MB, workspace 500 MB)')
            paths.append(path)
    return paths


class PrototypeWorkspace:
    def __init__(self, project_root: Path, data_root: Path, workspace_id: str):
        if len(workspace_id) != 32 or any(c not in '0123456789abcdef' for c in workspace_id):
            raise ValueError('Invalid workspace identifier')
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
            raise ValueError('Please select an HTML file within the project')
        safe_path(domain, entry.relative_to(domain).as_posix(), allow_hidden=True)
        if not entry.is_file():
            raise FileNotFoundError(entry)
        root = (root or entry.parent).resolve()
        if not root.is_relative_to(domain) or not entry.is_relative_to(root):
            raise ValueError('The prototype directory must be located within the project and contain the current file')
        base = data_root / 'prototype-editor'
        with _guard:
            for record in base.glob('*/journal.json'):
                metadata = json.loads(record.read_text())
                registered = (data_root if metadata.get('root_kind') == 'data' else project_root) / metadata['root']
                if resource_contains(registered, entry):
                    work = cls(project_root, data_root, record.parent.name)
                    work.refresh_sources(entry.relative_to(registered).as_posix())
                    if entry.relative_to(registered).as_posix() not in work.load()['documents']:
                        raise SourceConflict('Workspace has uncommitted changes; please resolve them before opening a new file')
                    return work
                if resource_contains(root, registered):
                    raise ValueError('Prototype directory overlaps with existing workspace')
            workspace_id = uuid.uuid4().hex
        work = cls(project_root, data_root, workspace_id)
        selected_entry = entry.relative_to(root).as_posix()
        paths = collect_resources(root, [selected_entry], max_file=MAX_FILE, max_total=MAX_TOTAL)
        with work.lock:
            try:
                files = {}
                for path in paths:
                    relative = path.relative_to(root).as_posix()
                    content = path.read_bytes()
                    files[relative] = work.store_blob(content)
                    atomic_write(work.directory / 'workspace' / relative, content)
                if entry.relative_to(root).as_posix() not in files:
                    raise ValueError('HTML file does not exist')
                work.save({'entries': [selected_entry], 'root': root.relative_to(domain).as_posix(), 'root_kind': 'project' if domain == project_root else 'data', 'files': files,
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
                data.update(status='interrupted', error='The service stopped unexpectedly. The working copy was kept.')
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
            raise ValueError('HTML not registered')
        target = safe_path(self.directory / 'workspace', path)
        if target.stat().st_size > MAX_FILE:
            raise ValueError('File too large')
        return HtmlSource(target.read_bytes().decode('utf-8'))

    def refresh_sources(self, entry=None):
        with self.lock:
            data = self.load()
            if data['status'] != 'idle':
                return
            original = self.original(data)
            entries = [path for path in data.get('entries', data['documents'])
                       if safe_path(original, path).is_file()]
            if entry and entry not in entries:
                entries.append(entry)
            paths = collect_resources(original, entries or ['index.html'], max_file=MAX_FILE, max_total=MAX_TOTAL)
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
            data['entries'] = entries
            self.save(data)
            self.prune()

    def begin(self, label):
        with self.lock:
            data = self.load()
            if data['status'] != 'idle':
                raise SourceConflict('Workspace has running or unprocessed modifications')
            self.refresh_sources()
            data = self.load()
            data.update(status='running', process_id=PROCESS_ID, pending={'label': label, 'before': dict(data['files']), 'changes': {}}, error='')
            self.save(data)

    def interrupt(self, message='Execution was interrupted. The working copy was kept.'):
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
                    data.update(status='conflict', error='The working copy contains new or deleted files. Keep it for inspection or discard the changes. This version can only edit existing files.')
                    self.save(data)
                    raise SourceConflict(data['error'])
                for path, before in pending['before'].items():
                    target = safe_path(self.directory / 'workspace', path)
                    if not target.is_file():
                        raise SourceConflict('The working copy has deleted the file. Please handle it before saving.')
                    if target.stat().st_size > MAX_FILE:
                        raise ValueError('File too large')
                    content = target.read_bytes()
                    after = digest(content)
                    if after != before:
                        if Path(path).suffix.lower() not in EDITABLE:
                            data.update(status='conflict', error='This version only publishes changes to HTML, CSS, and JavaScript.')
                            self.save(data)
                            raise SourceConflict(data['error'])
                        if digest(safe_path(original, path).read_bytes()) != before:
                            data.update(status='conflict', error=f'The original file has changed: {path}')
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
                    raise SourceConflict(f'Write-back conflict: {path}')
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
            if document.runtime_rendered:
                raise ValueError('Please modify and generate scripts for dynamic pages through the prototype assistant')
            result = document.edit(node_id, operation, values, version)
            self.begin(f'{operation}: {path}')
            # begin refreshed external state: never apply an old source range.
            if self.document(path).version != version:
                self.discard()
                raise SourceConflict('The original file has been updated. Please refresh the preview.')
            atomic_write(safe_path(self.directory / 'workspace', path), result.encode())
            return self.publish()

    def discard(self):
        with self.lock:
            data = self.load()
            if data['status'] == 'publishing':
                raise SourceConflict('Write-back incomplete, please restore write-back first')
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
                raise SourceConflict('Cannot undo')
            item = next((item for item in reversed(data['history']) if not item.get('undone') and not item.get('undo_id')), None)
            if item is None:
                raise SourceConflict('No modifications to revert')
            original = self.original(data)
            for path, change in item['changes'].items():
                if digest(safe_path(original, path).read_bytes()) != change['after']:
                    raise SourceConflict('The file has other modifications and cannot be overwritten or reverted.')
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
                raise SourceConflict('Unsaved changes, cannot clean')
            data['history'] = []
            self.save(data)
            self.prune()
            return self.state()

    def diff(self, revision='pending'):
        with self.lock:
            data = self.load()
            if revision == 'pending':
                if not data['pending']:
                    return {'diff': '', 'files': []}
                changes = {}
                for path, before in data['pending']['before'].items():
                    target = safe_path(self.directory / 'workspace', path)
                    if target.is_file() and target.stat().st_size <= MAX_FILE:
                        changes[path] = (self.blob(before), target.read_bytes())
            else:
                item = next((item for item in data['history'] if item['id'] == revision), None)
                if item is None:
                    raise ValueError('Historical version does not exist')
                changes = {path: (self.blob(change['before']), self.blob(change['after'])) for path, change in item['changes'].items()}
            output, files, remaining = [], [], 200000
            for path, (before, after) in changes.items():
                if before == after or Path(path).suffix.lower() not in EDITABLE:
                    continue
                lines = difflib.unified_diff(before.decode('utf-8', errors='replace').splitlines(True),
                    after.decode('utf-8', errors='replace').splitlines(True), fromfile=path, tofile=path)
                patch = ''.join(line if line.endswith('\n') else line + '\n\\ No newline at end of file\n' for line in lines)[:remaining]
                output.append(patch)
                files.append({'path': path, 'patch': patch})
                remaining -= len(patch)
                if remaining <= 0:
                    break
            return {'diff': ''.join(output), 'files': files}

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
