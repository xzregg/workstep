"""Serialize local mutations and bind them to the state the user reviewed."""
import asyncio
import os
import re
import tempfile
import time
from urllib.parse import urlsplit

import httpx

from .command import text
from pathlib import Path

from .command import GitError
from .query import read_file, safe_file

COMMIT_MESSAGE_SYSTEM_PROMPT = """你是 Git 提交说明生成器。根据用户提供的已选文件状态和 diff，生成一条准确、简洁的 Conventional Commits 提交说明。
要求：
1. 第一行必须是 <type>(可选 scope): 中文简述；type 只能是 feat、fix、refactor、perf、docs、test、build、ci、chore、style、revert。
2. 第一行尽量不超过 72 个字符，使用祈使语气，描述行为和目的，不罗列文件名。
3. 变更较复杂时，空一行后添加精炼的项目符号正文；简单变更只输出第一行。
4. 只能依据输入内容，不得虚构功能、问题编号或影响范围。
5. 只返回提交说明正文，不要 Markdown 代码块、解释或候选项。"""


def normalize_commit_message(value):
    value = value.strip()
    if value.startswith('```'):
        lines = value.splitlines()
        value = '\n'.join(lines[1:-1] if len(lines) > 2 and lines[-1].strip() == '```' else lines[1:]).strip()
    lines = [line.rstrip() for line in value.splitlines()]
    value = '\n'.join(lines).strip()
    if not value or not re.match(r'^(feat|fix|refactor|perf|docs|test|build|ci|chore|style|revert)(\([^)\n]+\))?!?: .+', lines[0] if lines else ''):
        raise GitError('供应商返回的提交说明不符合 Conventional Commits 规范，请重试。', 502)
    if len(value) > 10000:
        raise GitError('供应商返回的提交说明过长，请重试。', 502)
    return value


def delete_worktree_file(root, value):
    target = safe_file(root, value)
    if target.is_dir() and not target.is_symlink():
        raise GitError('只能撤销文件，不能删除目录。')
    target.unlink(missing_ok=True)


def append_gitignore(root, value):
    if '\n' in value or '\r' in value:
        raise GitError('包含换行符的文件名不能加入 Git 忽略。')
    target = safe_file(root, '.gitignore')
    if target.is_symlink() or (target.exists() and not target.is_file()):
        raise GitError('.gitignore 不是可安全写入的普通文件。')
    escaped = value.replace('\\', '\\\\')
    for token in ('*', '?', '['):
        escaped = escaped.replace(token, '\\' + token)
    pattern = '/' + escaped
    current = target.read_text(encoding='utf-8', errors='surrogateescape') if target.exists() else ''
    if pattern in current.splitlines():
        return
    with target.open('a', encoding='utf-8', errors='surrogateescape') as stream:
        if current and not current.endswith('\n'):
            stream.write('\n')
        stream.write(pattern + '\n')


def replace_worktree_file(root, value, content):
    target = safe_file(root, value)
    if target.is_symlink() or (target.exists() and not target.is_file()):
        raise GitError('只能编辑工作目录中的普通文本文件。')
    if not target.parent.exists():
        raise GitError('文件所在目录已不存在，请刷新后重试。', 409)
    mode = target.stat().st_mode if target.exists() else 0o644
    fd, temporary = tempfile.mkstemp(prefix='.workstep-edit-', dir=target.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(content.encode('utf-8', 'surrogateescape'))
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def message_file(message):
    fd, name = tempfile.mkstemp(prefix='workstep-commit-')
    with os.fdopen(fd, 'w') as stream:
        stream.write(message)
    return name


class GitWrites:
    async def set_global_identity(self, id, name, email):
        directory = await self.directory(id)
        await self.command(directory['path'], 'config', '--global', 'user.name', name)
        await self.command(directory['path'], 'config', '--global', 'user.email', email)
        return await self.global_identity(id)

    @staticmethod
    def credential_host(url):
        parsed = urlsplit(url)
        if parsed.scheme.lower() != 'https' or not parsed.hostname:
            return None
        return parsed.hostname.lower() + (f':{parsed.port}' if parsed.port else '')

    @classmethod
    def normalize_credential_host(cls, host):
        host = host.strip()
        if not re.fullmatch(r'[A-Za-z0-9.-]+(?::[0-9]{1,5})?', host):
            raise GitError('请输入 HTTPS 远程地址中的主机名。')
        try:
            normalized = cls.credential_host('https://' + host)
        except ValueError as exc:
            raise GitError('HTTPS 主机名无效。') from exc
        if not normalized:
            raise GitError('HTTPS 主机名无效。')
        return normalized

    async def credential_hosts(self):
        return {'hosts': sorted(self.remote_credentials)}

    async def save_host_credentials(self, host, username, token):
        host = self.normalize_credential_host(host)
        self.remote_credentials[host] = {'username': username, 'token': token}
        return await self.credential_hosts()

    async def clear_host_credentials(self, host):
        self.remote_credentials.pop(self.normalize_credential_host(host), None)
        return await self.credential_hosts()

    async def remote_url(self, path, remote, *, push=False):
        args = ('remote', 'get-url', '--push', '--', remote) if push else ('remote', 'get-url', '--', remote)
        url, _ = await self.command(path, *args)
        return text(url).strip()

    async def credentials(self, id):
        remotes = await self.remotes(id)
        return {'remotes': [{'name': item['name'], 'url': item['url'],
            'push_url': item['push_url'],
            'configured': self.credential_host(item['url']) in self.remote_credentials}
            for item in remotes['remotes']], 'hosts': sorted(self.remote_credentials)}

    async def save_credentials(self, id, remote, username, token):
        directory = await self.directory(id)
        await self.validate_remote(directory['path'], remote)
        fetch_url = await self.remote_url(directory['path'], remote)
        host = self.credential_host(fetch_url)
        if not host:
            raise GitError('用户名和访问令牌仅用于 HTTPS 远程源。')
        self.remote_credentials[host] = {'username': username, 'token': token}
        return await self.credentials(id)

    async def clear_credentials(self, id, remote):
        directory = await self.directory(id)
        await self.validate_remote(directory['path'], remote)
        host = self.credential_host(await self.remote_url(directory['path'], remote))
        if host:
            self.remote_credentials.pop(host, None)
        return await self.credentials(id)

    async def credential_for(self, directory, remote, *, push=False):
        current = await self.remote_url(directory['path'], remote, push=push)
        return self.remote_credentials.get(self.credential_host(current))

    async def set_identity(self, id, name, email):
        directory = await self.directory(id)
        async with self.locks.setdefault(directory['common_dir'], asyncio.Lock()):
            await self.command(directory['path'], 'config', '--local', 'user.name', name)
            await self.command(directory['path'], 'config', '--local', 'user.email', email)
            await self.command(directory['path'], 'config', '--local', 'extensions.worktreeConfig', 'true')
            repository = await self.discover_repository(Path(directory['path']))
            for worktree in repository['worktrees']:
                if worktree['available']:
                    await self.command(worktree['path'], 'config', '--worktree', 'user.name', name)
                    await self.command(worktree['path'], 'config', '--worktree', 'user.email', email)
            return await self.identity(id)

    async def reviewed(self, id, snapshot):
        state = await self.status(id)
        if state['snapshot'] != snapshot:
            raise GitError('文件或分支已变化，请刷新并重新审阅后再操作。', 409)
        if state['operation'] or any(f['conflict'] for f in state['files']):
            raise GitError('仓库存在冲突或未完成的 Git 操作，请先在本地处理。', 409)
        return state

    async def commit(self, id, paths, message, snapshot):
        directory = await self.directory(id)
        async with self.locks.setdefault(directory['common_dir'], asyncio.Lock()):
            state = await self.reviewed(id, snapshot)
            files = {f['path']: f for f in state['files']}
            if not paths or len(set(paths)) != len(paths) or any(p not in files for p in paths):
                raise GitError('提交文件已变化，请重新选择。', 409)
            if any(files[p]['submodule'] for p in paths):
                raise GitError('子模块变更请在本地 Git 中处理。')
            names = list(dict.fromkeys(n for p in paths for n in [p, files[p]['old_path']] if n))
            pathspec = b''.join(os.fsencode(p) + b'\0' for p in names)
            # --only writes selected working-file versions and preserves other index entries.
            # add is required for untracked files; never stage the entire repository.
            new_files = b''.join(os.fsencode(p) + b'\0' for p in paths if files[p]['untracked'])
            if new_files:
                await self.command(directory['path'], 'add', '--pathspec-from-file=-', '--pathspec-file-nul', stdin=new_files)
            name = await asyncio.to_thread(message_file, message)
            try:
                await self.command(directory['path'], 'commit', '--only', '--file=' + name,
                    '--pathspec-from-file=-', '--pathspec-file-nul', stdin=pathspec, timeout=120)
            except GitError as exc:
                actual_head = await self.revision(directory['path'])
                if actual_head != state['head']:
                    raise GitError(str(exc) + '\nHEAD 已变化，可能已生成提交，请先检查提交历史，不要直接重复提交。', 409) from exc
                if 'Author identity unknown' in str(exc) or 'unable to auto-detect email address' in str(exc):
                    raise GitError('Git 未配置提交作者。请在此仓库设置真实姓名和邮箱：\n'
                        'git config user.name "你的姓名"\n'
                        'git config user.email "你的邮箱"\n'
                        '然后刷新状态并重试；已暂存的选中文件会保留。', exc.status) from exc
                raise GitError(str(exc) + '\n提交未完成，请刷新状态；已暂存的选中文件会保留。', exc.status) from exc
            finally:
                await asyncio.to_thread(Path(name).unlink, missing_ok=True)
            return {'head': await self.revision(directory['path'])}

    async def discard(self, id, value, snapshot):
        directory = await self.directory(id)
        root = directory['path']
        async with self.locks.setdefault(directory['common_dir'], asyncio.Lock()):
            state = await self.reviewed(id, snapshot)
            file = next((item for item in state['files'] if item['path'] == value), None)
            if not file:
                raise GitError('文件状态已变化，请刷新后重试。', 409)
            if file['conflict'] or file['submodule']:
                raise GitError('冲突文件和子模块需要在本地 Git 中处理。', 409)
            names = list(dict.fromkeys(name for name in (file['old_path'], file['path']) if name))
            for name in names:
                raw, code = await self.command(root, 'ls-tree', '--name-only', '-z', 'HEAD', '--', name, check=False)
                if not code and raw:
                    await self.command(root, 'restore', '--source=HEAD', '--staged', '--worktree', '--', name)
                else:
                    await self.command(root, 'rm', '--cached', '-f', '--ignore-unmatch', '--', name)
                    await asyncio.to_thread(delete_worktree_file, root, name)
            return await self.status(id)

    async def ignore(self, id, value, snapshot):
        directory = await self.directory(id)
        root = directory['path']
        async with self.locks.setdefault(directory['common_dir'], asyncio.Lock()):
            state = await self.reviewed(id, snapshot)
            file = next((item for item in state['files'] if item['path'] == value), None)
            if not file:
                raise GitError('文件状态已变化，请刷新后重试。', 409)
            if not file['untracked'] or file['submodule']:
                raise GitError('只有未跟踪文件可以加入 Git 忽略。', 409)
            await asyncio.to_thread(append_gitignore, root, value)
            return await self.status(id)

    async def save_file(self, id, value, content, snapshot):
        directory = await self.directory(id)
        root = directory['path']
        async with self.locks.setdefault(directory['common_dir'], asyncio.Lock()):
            state = await self.reviewed(id, snapshot)
            file = next((item for item in state['files'] if item['path'] == value), None)
            if not file:
                raise GitError('文件状态已变化，请刷新后重试。', 409)
            if file['conflict'] or file['submodule']:
                raise GitError('冲突文件和子模块不能在对比窗口中编辑。', 409)
            await asyncio.to_thread(replace_worktree_file, root, value, content)
            return await self.status(id)

    async def generate_commit_message(self, id, paths, snapshot):
        directory = await self.directory(id)
        root = directory['path']
        state = await self.reviewed(id, snapshot)
        files = {item['path']: item for item in state['files']}
        if not paths or len(set(paths)) != len(paths) or any(path not in files for path in paths):
            raise GitError('用于生成提交说明的文件已变化，请重新选择。', 409)
        if any(files[path]['conflict'] or files[path]['submodule'] for path in paths):
            raise GitError('冲突文件和子模块不能用于生成提交说明。', 409)
        names = list(dict.fromkeys(name for path in paths for name in (files[path]['old_path'], path) if name))
        status_lines = [f"{files[path]['index_status']}{files[path]['worktree_status']} {path}" for path in paths]
        patch = ''
        if state['head']:
            try:
                raw, _ = await self.command(root, 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--find-renames', '-U2', 'HEAD', '--', *names, limit=512 * 1024)
                patch = text(raw)
            except GitError as exc:
                if exc.status != 413:
                    raise
                raw, _ = await self.command(root, 'diff', '--stat', 'HEAD', '--', *names)
                patch = text(raw) + '\n[详细 diff 过大，已省略]'
        untracked_parts = []
        for path in paths:
            if not files[path]['untracked']:
                continue
            data, truncated = await asyncio.to_thread(read_file, root, path)
            if b'\0' in data:
                untracked_parts.append(f"### 新增二进制文件 {path}")
            else:
                body = text(data[:20000])
                suffix = '\n[内容已截断]' if truncated or len(data) > 20000 else ''
                untracked_parts.append(f"### 新增文件 {path}\n{body}{suffix}")
        context = '已选文件状态：\n' + '\n'.join(status_lines) + '\n\nGit diff：\n' + (patch or '[无已跟踪文件 diff]')
        if untracked_parts:
            context += '\n\n' + '\n\n'.join(untracked_parts)
        context = context[:120000]
        from services.config import config_store
        from services import providers as provider_service
        config = await asyncio.to_thread(config_store.get_prompt_enhance_config)
        if not config.get('provider_id') or not config.get('model'):
            raise GitError('请先在设置中配置“提示词增强”的供应商和模型。', 409)
        provider = await asyncio.to_thread(config_store.get_provider, config['provider_id'])
        if provider is None:
            raise GitError('提示词增强的供应商不存在，请在设置中重新配置。', 409)
        try:
            result = await provider_service.text_completion(provider, config['model'], [
                {'role': 'system', 'content': COMMIT_MESSAGE_SYSTEM_PROMPT},
                {'role': 'user', 'content': context},
            ], max_tokens=800, timeout=180, thinking='disabled', protocol=config.get('protocol') or None)
        except httpx.TimeoutException as exc:
            raise GitError('生成提交说明超时（180 秒），请检查供应商连接或稍后重试。', 504) from exc
        except Exception as exc:
            detail = str(exc).strip() or type(exc).__name__
            raise GitError(f'生成提交说明失败：{detail}', 502) from exc
        return {'message': normalize_commit_message(result)}

    async def switch(self, id, branch, snapshot, remote=None):
        directory = await self.directory(id)
        async with self.locks.setdefault(directory['common_dir'], asyncio.Lock()):
            state = await self.reviewed(id, snapshot)
            if state['active']:
                raise GitError('此项目有正在运行的任务或对话，请结束后再切换分支。', 409)
            _, code = await self.command(directory['path'], 'check-ref-format', '--branch', branch, check=False)
            if code:
                raise GitError('分支名称无效。')
            branch_data = await self.branches(id)
            branches = branch_data['branches']
            target = next((b for b in branches if b['name'] == branch), None)
            if remote:
                await self.validate_remote(directory['path'], remote)
                remote_target = next((item for item in branch_data['remote_branches']
                    if item['remote'] == remote and item['branch'] == branch), None)
                if not remote_target:
                    raise GitError('远程分支不存在，请重新拉取分支。', 404)
            elif not target:
                raise GitError('本地分支不存在，请刷新。', 404)
            if target and target['worktree_id'] and target['worktree_id'] != id:
                raise GitError('该分支已在其他工作目录中检出，请定位到该目录。', 409)
            if branch != state['branch']:
                if target:
                    await self.command(directory['path'], 'switch', '--no-guess', '--', branch)
                else:
                    await self.command(directory['path'], 'switch', '--no-guess', '--track', '-c', branch, remote + '/' + branch)
            return await self.status(id)

    async def advance(self, id, branch, snapshot):
        directory = await self.directory(id)
        path = directory['path']
        async with self.locks.setdefault(directory['common_dir'], asyncio.Lock()):
            state = await self.reviewed(id, snapshot)
            if state['active']:
                raise GitError('项目有正在运行的任务或对话，请结束后再更新分支。', 409)
            if state['branch'] == branch:
                raise GitError('当前分支请使用拉取操作更新。', 409)
            target = next((item for item in (await self.branches(id))['branches'] if item['name'] == branch), None)
            if not target:
                raise GitError('本地分支不存在，请刷新。', 404)
            if target['worktree_id']:
                raise GitError('该分支已在工作目录中检出，请定位到对应目录后拉取。', 409)
            if not target['remote'] or target['remote'] == '.' or not target['upstream_ref']:
                raise GitError('该分支没有可拉取的远程上游。', 409)
            auth = await self.credential_for(directory, target['remote'])
            await self.command(path, 'fetch', '--prune', '--no-recurse-submodules', '--', target['remote'], timeout=120, auth=auth)
            self.fetched_at[directory['common_dir']] = time.time()
            state = await self.reviewed(id, snapshot)
            if state['active']:
                raise GitError('项目有正在运行的任务或对话，请结束后再更新分支。', 409)
            target = next((item for item in (await self.branches(id))['branches'] if item['name'] == branch), None)
            if not target or target['worktree_id'] or not target['upstream_ref']:
                raise GitError('分支状态已变化，请刷新后重试。', 409)
            remote_head, code = await self.command(path, 'rev-parse', '--verify', '--end-of-options', target['upstream_ref'] + '^{commit}', check=False)
            if code:
                raise GitError('上游分支已不存在，请重新拉取分支。', 409)
            remote_sha = text(remote_head).strip()
            counts, _ = await self.command(path, 'rev-list', '--left-right', '--count', target['head'] + '...' + remote_sha, '--')
            ahead, behind = map(int, counts.split())
            if ahead and behind:
                raise GitError('本地与上游分支已分叉，无法快进更新。', 409)
            if behind:
                await self.command(path, 'update-ref', 'refs/heads/' + branch, remote_sha, target['head'])
            return await self.branches(id)


    async def fetch(self, id):
        directory = await self.directory(id)
        async with self.locks.setdefault(directory['common_dir'], asyncio.Lock()):
            names, _ = await self.command(directory['path'], 'remote')
            for remote in text(names).splitlines():
                auth = await self.credential_for(directory, remote)
                await self.command(directory['path'], 'fetch', '--prune', '--no-recurse-submodules', '--', remote, timeout=120, auth=auth)
            self.fetched_at[directory['common_dir']] = time.time()
            return await self.branches(id)

    async def validate_remote(self, path, remote):
        names_raw, _ = await self.command(path, 'remote')
        if remote not in text(names_raw).splitlines():
            raise GitError('远程源不存在，请刷新远程列表。', 404)
        return remote

    async def remote_target(self, path, branch, remote=None, target_branch=None):
        if bool(remote) != bool(target_branch):
            raise GitError('请选择完整的远程源和远程分支。')
        if not remote:
            raw, _ = await self.command(path, 'for-each-ref',
                '--format=%(upstream:remotename)%00%(upstream:remoteref)', 'refs/heads/' + branch)
            remote, _, remote_ref = text(raw).strip().partition('\0')
            if not remote or remote == '.' or not remote_ref.startswith('refs/heads/'):
                raise GitError('当前分支未配置远程上游，请选择远程源和目标分支。', 409)
            target_branch = remote_ref.removeprefix('refs/heads/')
        await self.validate_remote(path, remote)
        _, code = await self.command(path, 'check-ref-format', '--branch', target_branch, check=False)
        if code:
            raise GitError('远程分支名称无效。')
        return remote, target_branch

    async def fetch_remote(self, id, remote):
        directory = await self.directory(id)
        async with self.locks.setdefault(directory['common_dir'], asyncio.Lock()):
            remote = await self.validate_remote(directory['path'], remote)
            auth = await self.credential_for(directory, remote)
            await self.command(directory['path'], 'fetch', '--prune', '--no-recurse-submodules', '--', remote, timeout=120, auth=auth)
            self.fetched_at[directory['common_dir']] = time.time()
            return await self.remotes(id)

    async def pull(self, id, branch, snapshot, remote=None, target_branch=None, set_upstream=False):
        directory = await self.directory(id)
        path = directory['path']
        async with self.locks.setdefault(directory['common_dir'], asyncio.Lock()):
            state = await self.reviewed(id, snapshot)
            self.require_pullable(state, branch)
            remote, target_branch = await self.remote_target(path, branch, remote, target_branch)
            auth = await self.credential_for(directory, remote)
            await self.command(path, 'fetch', '--prune', '--no-recurse-submodules', '--', remote, timeout=120, auth=auth)
            self.fetched_at[directory['common_dir']] = time.time()
            # Network I/O may take a while: recheck files, branch and active tasks before updating HEAD.
            state = await self.reviewed(id, snapshot)
            self.require_pullable(state, branch)
            remote_ref = f'refs/remotes/{remote}/{target_branch}'
            remote_head, code = await self.command(path, 'rev-parse', '--verify', '--end-of-options', remote_ref + '^{commit}', check=False)
            if code:
                raise GitError('上游分支已不存在，请检查远程分支设置。', 409)
            sha = text(remote_head).strip()
            counts, _ = await self.command(path, 'rev-list', '--left-right', '--count', state['head'] + '...' + sha, '--')
            ahead, behind = map(int, counts.split())
            if ahead and behind:
                raise GitError('本地与上游分支已分叉，无法快进更新。请在本地处理合并或变基。', 409)
            if behind:
                await self.command(path, '-c', 'merge.autoStash=false', 'merge', '--ff-only', '--no-edit', sha, timeout=120)
            if set_upstream:
                await self.command(path, 'branch', '--set-upstream-to=' + remote + '/' + target_branch, '--', branch)
            return await self.status(id)

    @staticmethod
    def require_pullable(state, branch):
        if not state['branch'] or state['branch'] != branch:
            raise GitError('只能拉取当前检出的分支，请先切换或定位到对应工作目录。', 409)
        if state['active']:
            raise GitError('项目有正在运行的任务或对话，请结束后再拉取。', 409)


    async def push(self, id, branch, snapshot, remote=None, target_branch=None, set_upstream=False):
        directory = await self.directory(id)
        path = directory['path']
        async with self.locks.setdefault(directory['common_dir'], asyncio.Lock()):
            state = await self.reviewed(id, snapshot)
            if not state['branch'] or state['branch'] != branch or not state['head']:
                raise GitError('只能推送当前已提交的分支，请刷新状态。', 409)
            if state['files']:
                raise GitError('存在未提交修改或未跟踪文件，请全部处理后再推送。', 409)
            if state['active']:
                raise GitError('项目有正在运行的任务或对话，请结束后再推送。', 409)
            remote, target_branch = await self.remote_target(path, branch, remote, target_branch)
            auth = await self.credential_for(directory, remote, push=True)
            remote_ref = 'refs/heads/' + target_branch
            # Explicit reviewed commit + upstream ref: never use push.default, matching,
            # mirror, automatic tags, force, or another branch's current HEAD.
            await self.command(path, '-c', 'remote.' + remote + '.mirror=false', 'push',
                '--porcelain', '--no-force', '--no-follow-tags', '--recurse-submodules=no',
                '--', remote, state['head'] + ':' + remote_ref, timeout=120, auth=auth)
            if set_upstream:
                await self.command(path, 'branch', '--set-upstream-to=' + remote + '/' + target_branch, '--', branch)
            return await self.status(id)
