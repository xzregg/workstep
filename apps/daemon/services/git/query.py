"""Read-side Git projections, including review tokens tied to actual file contents."""
import asyncio
import difflib
import hashlib
import json
import os
import re
from urllib.parse import urlsplit, urlunsplit
from pathlib import Path, PurePosixPath

from .command import GitError, text

PREVIEW_LIMIT = 2 * 1024 * 1024
EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'


def safe_file(root: str, value: str):
    path = PurePosixPath(value)
    if not value or '\0' in value or path.is_absolute() or '..' in path.parts or '.git' in path.parts:
        raise GitError('无效的仓库相对路径。')
    target = Path(root) / value
    if not target.parent.resolve().is_relative_to(Path(root).resolve()):
        raise GitError('文件路径越过仓库边界。')
    return target


def file_digest(root, value):
    path = safe_file(root, value)
    if path.is_symlink():
        return hashlib.sha256(os.fsencode(os.readlink(path))).hexdigest()
    if not path.exists():
        return 'deleted'
    if path.is_dir():
        return 'directory'
    digest = hashlib.sha256(str(path.stat().st_mode).encode())
    with path.open('rb') as stream:
        while chunk := stream.read(262144):
            digest.update(chunk)
    return digest.hexdigest()


def read_file(root, value):
    path = safe_file(root, value)
    if path.is_symlink():
        return os.fsencode(os.readlink(path)), False
    if not path.exists():
        return b'', False
    if path.is_dir():
        return b'', True
    with path.open('rb') as stream:
        data = stream.read(PREVIEW_LIMIT + 1)
    return data[:PREVIEW_LIMIT], len(data) > PREVIEW_LIMIT


class GitQueries:
    async def global_identity(self, id):
        directory = await self.directory(id)
        path = directory['path']
        name, _ = await self.command(path, 'config', '--global', '--get', 'user.name', check=False)
        email, _ = await self.command(path, 'config', '--global', '--get', 'user.email', check=False)
        return {'name': text(name).strip(), 'email': text(email).strip()}

    async def identity(self, id):
        directory = await self.directory(id)
        path = directory['path']
        name, _ = await self.command(path, 'config', '--get', 'user.name', check=False)
        email, _ = await self.command(path, 'config', '--get', 'user.email', check=False)
        return {'name': text(name).strip(), 'email': text(email).strip()}

    async def revision(self, path, ref=None):
        if ref and ref != 'HEAD' and not re.fullmatch(r'[0-9a-fA-F]{7,64}', ref):
            _, code = await self.command(path, 'show-ref', '--verify', '--quiet', 'refs/heads/' + ref, check=False)
            if code:
                raise GitError('分支不存在，请刷新列表。', 404)
            ref = 'refs/heads/' + ref
        raw, code = await self.command(path, 'rev-parse', '--verify', '--end-of-options', (ref or 'HEAD') + '^{commit}', check=False)
        if code:
            if ref and ref != 'HEAD':
                raise GitError('提交不存在。', 404)
            return None
        return text(raw).strip()

    async def status(self, id):
        directory = await self.directory(id)
        path = directory['path']
        raw, _ = await self.command(path, 'status', '--porcelain=v1', '-z', '--untracked-files=all')
        records = iter(raw.split(b'\0'))
        files = []
        for record in records:
            if not record:
                continue
            xy, name = text(record[:2]), text(record[3:])
            old = text(next(records)) if 'R' in xy or 'C' in xy else None
            await asyncio.to_thread(safe_file, path, name)
            files.append({'path': name, 'old_path': old, 'index_status': xy[0], 'worktree_status': xy[1],
                'untracked': xy == '??', 'conflict': xy in {'DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'},
                'staged': xy[0] not in {' ', '?'}, 'submodule': False})
        index, _ = await self.command(path, 'ls-files', '--stage', '-z')
        submodules = {text(row.split(b'\t', 1)[1]) for row in index.split(b'\0') if row.startswith(b'160000 ') and b'\t' in row}
        for file in files:
            file['submodule'] = file['path'] in submodules
            file['digest'] = await asyncio.to_thread(file_digest, path, file['path'])
        head = await self.revision(path)
        branch_raw, _ = await self.command(path, 'symbolic-ref', '--quiet', '--short', 'HEAD', check=False)
        branch = text(branch_raw).strip() or None
        gitdir_raw, _ = await self.command(path, 'rev-parse', '--absolute-git-dir')
        gitdir = Path(text(gitdir_raw).strip())
        operation = await asyncio.to_thread(lambda: next((n for n in ('MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG') if (gitdir / n).exists()), None))
        upstream_raw, upstream_code = await self.command(path, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}', check=False)
        ahead = behind = None
        if not upstream_code and head:
            count_raw, code = await self.command(path, 'rev-list', '--left-right', '--count', 'HEAD...@{upstream}', check=False)
            if not code:
                ahead, behind = map(int, count_raw.split())
        # Index hashes and complete content digests catch edits even when status codes do not change.
        token = hashlib.sha256(json.dumps([head, branch, operation, files], sort_keys=True).encode() + raw + index).hexdigest()
        active = any(self.active_provider(pid) for pid in directory['project_ids'])
        return {'id': id, 'path': path, 'head': head, 'branch': branch, 'files': files, 'snapshot': token,
            'operation': operation, 'active': active, 'upstream': text(upstream_raw).strip() if not upstream_code else None,
            'ahead': ahead, 'behind': behind}

    async def branches(self, id):
        directory = await self.directory(id)
        path = directory['path']
        repo = await self.discover_repository(Path(path))
        raw, _ = await self.command(path, 'for-each-ref',
            '--format=%(refname:short)%00%(objectname)%00%(upstream:short)%00%(upstream)%00%(upstream:remotename)%00', 'refs/heads/')
        result = []
        fields = raw.split(b'\0')
        for i in range(0, len(fields) - 1, 5):
            name = text(fields[i]).lstrip('\n')
            head = text(fields[i + 1])
            upstream = text(fields[i + 2]) or None
            upstream_ref = text(fields[i + 3]) or None
            remote = text(fields[i + 4]) or None
            ahead = behind = None
            gone = False
            if upstream_ref:
                remote_head, code = await self.command(path, 'rev-parse', '--verify', '--end-of-options', upstream_ref + '^{commit}', check=False)
                gone = bool(code)
                if not gone:
                    counts, _ = await self.command(path, 'rev-list', '--left-right', '--count', head + '...' + text(remote_head).strip(), '--')
                    ahead, behind = map(int, counts.split())
            occupied = next((w for w in repo['worktrees'] if w['branch'] == name), None)
            result.append({'name': name, 'head': head, 'worktree_id': occupied['id'] if occupied else None,
                'path': occupied['path'] if occupied else None, 'upstream': upstream, 'upstream_ref': upstream_ref,
                'remote': remote, 'ahead': ahead, 'behind': behind, 'upstream_gone': gone})
        remotes_raw, _ = await self.command(path, 'remote')
        remote_names = sorted(text(remotes_raw).splitlines(), key=len, reverse=True)
        remote_raw, _ = await self.command(path, 'for-each-ref',
            '--format=%(refname:short)%00%(objectname)%00', 'refs/remotes/')
        remote_branches = []
        remote_fields = remote_raw.split(b'\0')
        for index in range(0, len(remote_fields) - 1, 2):
            name = text(remote_fields[index]).lstrip('\n')
            remote = next((candidate for candidate in remote_names if name.startswith(candidate + '/')), None)
            if remote and not name.endswith('/HEAD'):
                remote_branches.append({'name': name, 'remote': remote,
                    'branch': name[len(remote) + 1:], 'head': text(remote_fields[index + 1])})
        return {'branches': result, 'remote_branches': remote_branches,
            'fetched_at': self.fetched_at.get(directory['common_dir'])}

    @staticmethod
    def public_remote_url(value):
        """Keep a useful location label without exposing credentials in HTTP responses."""
        value = value.strip()
        if '://' in value:
            parsed = urlsplit(value)
            host = parsed.hostname or ''
            if parsed.port:
                host += f':{parsed.port}'
            return urlunsplit((parsed.scheme, host, parsed.path, '', ''))
        if '@' in value and ':' in value.partition('@')[2]:
            return value.partition('@')[2]
        return value

    async def remotes(self, id):
        directory = await self.directory(id)
        path = directory['path']
        names_raw, _ = await self.command(path, 'remote')
        names = sorted(name for name in text(names_raw).splitlines() if name)
        refs_raw, _ = await self.command(path, 'for-each-ref',
            '--format=%(refname:short)%00%(objectname)%00', 'refs/remotes/')
        refs = []
        fields = refs_raw.split(b'\0')
        for index in range(0, len(fields) - 1, 2):
            name = text(fields[index]).lstrip('\n')
            if name and not name.endswith('/HEAD'):
                refs.append((name, text(fields[index + 1])))
        result = []
        for name in names:
            fetch_url, _ = await self.command(path, 'remote', 'get-url', '--', name)
            push_url, _ = await self.command(path, 'remote', 'get-url', '--push', '--', name)
            prefix = name + '/'
            branches = [{'name': ref[len(prefix):], 'head': head} for ref, head in refs if ref.startswith(prefix)]
            result.append({'name': name, 'url': self.public_remote_url(text(fetch_url)),
                'push_url': self.public_remote_url(text(push_url)), 'branches': branches})
        upstream = None
        branch_raw, branch_code = await self.command(path, 'symbolic-ref', '--quiet', '--short', 'HEAD', check=False)
        if not branch_code:
            current = text(branch_raw).strip()
            raw, _ = await self.command(path, 'for-each-ref',
                '--format=%(upstream:remotename)%00%(upstream:remoteref)', 'refs/heads/' + current)
            remote, _, remote_ref = text(raw).strip().partition('\0')
            if remote and remote != '.' and remote_ref.startswith('refs/heads/'):
                upstream = {'remote': remote, 'branch': remote_ref.removeprefix('refs/heads/')}
        return {'remotes': result, 'upstream': upstream,
            'fetched_at': self.fetched_at.get(directory['common_dir'])}

    async def history(self, id, ref=None, offset=0):
        directory = await self.directory(id)
        sha = await self.revision(directory['path'], ref)
        if not sha:
            return {'commits': [], 'has_more': False}
        raw, _ = await self.command(directory['path'], 'log', '--max-count=51', f'--skip={offset}',
            '--format=%H%x00%an%x00%at%x00%s%x00%P%x00', sha, '--')
        fields = raw.split(b'\0')
        commits = [{'hash': text(fields[i]).lstrip('\n'), 'author': text(fields[i + 1]),
            'time': int(fields[i + 2]), 'message': text(fields[i + 3]),
            'parents': text(fields[i + 4]).split()} for i in range(0, len(fields) - 1, 5)]
        return {'commits': commits[:50], 'has_more': len(commits) > 50}

    async def comparison(self, path, ref=None, commit=None):
        if commit:
            target = await self.revision(path, commit)
            raw, code = await self.command(path, 'rev-parse', '--verify', target + '^1', check=False)
            return text(raw).strip() if not code else None, target
        return await self.revision(path), await self.revision(path, ref) if ref else None

    async def changes(self, id, ref=None, commit=None):
        directory = await self.directory(id)
        base, target = await self.comparison(directory['path'], ref, commit)
        if not target:
            raise GitError('请选择分支或历史提交。')
        raw, _ = await self.command(directory['path'], 'diff', '--name-status', '-z', '--find-renames', base or EMPTY_TREE, target, '--')
        fields = iter(raw.split(b'\0'))
        files = []
        for kind in fields:
            if not kind:
                continue
            name = text(next(fields))
            old = None
            if kind.startswith((b'R', b'C')):
                old, name = name, text(next(fields))
            files.append({'path': name, 'old_path': old, 'index_status': text(kind[:1]), 'worktree_status': ' ', 'untracked': False, 'staged': False, 'conflict': False, 'submodule': False})
        return {'files': files, 'base': base, 'target': target}

    async def blob(self, path, rev, name):
        if not rev:
            return b'', False
        raw, code = await self.command(path, 'cat-file', '-s', rev + ':' + name, check=False)
        if code:
            return b'', False
        if int(raw) > PREVIEW_LIMIT:
            return b'', True
        raw, code = await self.command(path, 'cat-file', 'blob', rev + ':' + name, check=False, limit=PREVIEW_LIMIT + 1024)
        return raw if not code else b'', bool(code)

    async def diff(self, id, name, ref=None, commit=None):
        directory = await self.directory(id)
        path = directory['path']
        await asyncio.to_thread(safe_file, path, name)
        base, target = await self.comparison(path, ref, commit)
        changes = await self.changes(id, ref, commit) if target else await self.status(id)
        file = next((f for f in changes['files'] if f['path'] == name), None)
        if not file:
            raise GitError('文件状态已变化，请刷新文件列表。', 409)
        old = file['old_path'] or name
        before, before_large = await self.blob(path, base, old)
        after, after_large = await self.blob(path, target, name) if target else await asyncio.to_thread(read_file, path, name)
        binary = b'\0' in before or b'\0' in after
        truncated = before_large or after_large
        patch = ''
        if not binary and not truncated and not file['submodule']:
            if file['untracked'] or not base:
                patch = await asyncio.to_thread(lambda: ''.join(difflib.unified_diff(text(before).splitlines(True), text(after).splitlines(True), fromfile='a/' + old, tofile='b/' + name)))
            else:
                raw, _ = await self.command(path, 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--find-renames', '-U3', base, *([target] if target else []), '--', *dict.fromkeys([old, name]))
                patch = text(raw)
            if len(patch.splitlines()) > 20000:
                patch = '\n'.join(patch.splitlines()[:20000])
                truncated = True
        return {'path': name, 'old_path': old, 'base': base, 'target': target, 'patch': patch,
            'before': '' if binary else text(before), 'after': '' if binary else text(after),
            'binary': binary, 'truncated': truncated, 'submodule': file['submodule'], 'snapshot': changes.get('snapshot')}

    async def blame(self, id, name, ref=None):
        directory = await self.directory(id)
        await asyncio.to_thread(safe_file, directory['path'], name)
        sha = await self.revision(directory['path'], ref)
        if not sha:
            return {'lines': []}
        data, large = await self.blob(directory['path'], sha, name)
        if large or b'\0' in data:
            return {'lines': [], 'truncated': large}
        raw, code = await self.command(directory['path'], 'blame', '--line-porcelain', sha, '--', name, check=False)
        if code:
            return {'lines': []}
        lines, current = [], {}
        for line in text(raw).splitlines():
            if re.match(r'^[0-9a-f]{40,64} \d+ \d+', line):
                parts = line.split()
                current = {'hash': parts[0], 'line': int(parts[2])}
            elif line.startswith('author '):
                current['author'] = line[7:]
            elif line.startswith('author-time '):
                current['time'] = int(line[12:])
            elif line.startswith('summary '):
                current['message'] = line[8:]
            elif line.startswith('\t'):
                lines.append(current.copy())
        return {'lines': lines}
