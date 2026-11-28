"""Serialize local mutations and bind them to the state the user reviewed."""
import asyncio
import os
import re
import shutil
import tempfile
import time
from urllib.parse import urlsplit

import httpx

from services.output_language import output_language_instruction
from services.prompt_sections import prompt_section
from .command import text
from pathlib import Path

from .command import GitError
from .query import read_file, safe_file

COMMIT_MESSAGE_SYSTEM_PROMPT = """You generate accurate, concise Conventional Commits messages from selected file statuses and diffs.
<requirements>
1. The first line must be <type>(optional scope): brief summary; type must be feat, fix, refactor, perf, docs, test, build, ci, chore, style, or revert.
2. Aim for at most 72 characters on the first line. Use imperative wording describing behavior and purpose rather than listing filenames.
3. For complex changes, add a blank line and a concise bulleted body; for simple changes, output only the first line.
4. Use only the supplied evidence. Do not invent features, issue numbers, or impact.
5. Return only the commit message, without Markdown fences, explanations, or alternatives.
</requirements>
"""


def normalize_commit_message(value):
    value = value.strip()
    if value.startswith('```'):
        lines = value.splitlines()
        value = '\n'.join(lines[1:-1] if len(lines) > 2 and lines[-1].strip() == '```' else lines[1:]).strip()
    lines = [line.rstrip() for line in value.splitlines()]
    value = '\n'.join(lines).strip()
    if not value or not re.match(r'^(feat|fix|refactor|perf|docs|test|build|ci|chore|style|revert)(\([^)\n]+\))?!?: .+', lines[0] if lines else ''):
        raise GitError('The commit message returned by the supplier does not conform to the Conventional Commits specification. Please try again.', 502)
    if len(value) > 10000:
        raise GitError('The submission description returned by the supplier is too long. Please try again.', 502)
    return value


def delete_worktree_file(root, value):
    target = safe_file(root, value)
    if target.is_dir() and not target.is_symlink():
        raise GitError('Only files can be undone, not directories.')
    target.unlink(missing_ok=True)


def append_gitignore(root, value):
    if '\n' in value or '\r' in value:
        raise GitError('File names containing newlines cannot be added to Git ignore.')
    target = safe_file(root, '.gitignore')
    if target.is_symlink() or (target.exists() and not target.is_file()):
        raise GitError('.gitignore is not a regular file that can be safely written.')
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
        raise GitError('Only plain text files in the working directory can be edited.')
    if not target.parent.exists():
        raise GitError('The directory containing the file no longer exists. Please refresh and try again.', 409)
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
    async def protect_branch(self, path, branch):
        repository = await self.discover_repository(Path(path))
        if branch in {'main', 'master', 'develop', 'development', 'trunk'} or any(
            tree['main'] and tree['branch'] == branch for tree in repository['worktrees']
        ):
            raise GitError('The main branch cannot be deleted.', 409)

    async def require_preserved_head(self, path, head, branches, branch):
        other_heads = [item['head'] for item in branches if item['name'] != branch]
        target = next((item for item in branches if item['name'] == branch), None)
        if target and target['upstream_ref']:
            upstream, code = await self.command(path, 'rev-parse', '--verify',
                '--end-of-options', target['upstream_ref'] + '^{commit}', check=False)
            if not code:
                other_heads.append(text(upstream).strip())
        for other_head in other_heads:
            _, code = await self.command(path, 'merge-base', '--is-ancestor', head, other_head, check=False)
            if not code:
                break
        else:
            raise GitError('Commits in this branch have not been merged into other local branches or their remote upstreams; the branch has been retained.', 409)

    async def delete_worktree(self, id, snapshot=None, head=None):
        known = self.directories.get(id)
        if not known or not set(known['project_ids']).intersection(p['id'] for p in self.projects_provider()):
            raise GitError('The working directory is unauthorized or has been removed. Please rescan.', 404)
        source_directory = next((w for w in self.directories.values()
            if w['common_dir'] == known['common_dir'] and w['main'] and w['available']), None)
        if not source_directory:
            raise GitError('Home directory unavailable, please rescan.', 409)
        directory = await self.directory(source_directory['id'])
        async with self.locks.setdefault(directory['common_dir'], asyncio.Lock()):
            repository = await self.discover_repository(Path(directory['path']))
            tree = next((tree for tree in repository['worktrees'] if tree['id'] == id), None)
            if not tree or tree['main'] or tree['locked']:
                raise GitError('The home directory or locked working directory cannot be deleted.', 409)
            path = tree['path']
            missing = not await asyncio.to_thread(os.path.lexists, path)
            if tree['branch']:
                await self.protect_branch(directory['path'], tree['branch'])
            if missing:
                if not head or tree['head'] != head:
                    raise GitError('The working directory record has changed. Please rescan before deleting.', 409)
                state = await self.status(directory['id'])
                if state['active'] or state['operation']:
                    raise GitError('There are running tasks or incomplete Git operations. Please clean them up later.', 409)
            else:
                if not snapshot or not tree['available'] or tree['prunable']:
                    raise GitError('Working directory has changed. Please rescan and review before deleting.', 409)
                state = await self.reviewed(id, snapshot)
                if state['active'] or state['files']:
                    raise GitError('There are uncommitted changes or running tasks. Please handle them before deletion.', 409)
            branches = (await self.branches(directory['id']))['branches']
            await self.require_preserved_head(directory['path'], tree['head'], branches, tree['branch'])
            source = next((w['path'] for w in repository['worktrees'] if w['main'] and w['available']), None)
            if not source:
                raise GitError('Home directory unavailable, please rescan.', 409)
            await self.command(source, 'worktree', 'remove', '--', path, timeout=120)
            try:
                if tree['branch']:
                    await self.command(source, 'update-ref', '-d', 'refs/heads/' + tree['branch'], tree['head'])
            finally:
                self.directories.pop(id, None)
                refreshed = (await self.discover_repository(Path(source)))['worktrees']
                for repo in self.snapshot['repositories']:
                    if repo['id'] == directory['repo_id']:
                        repo['worktrees'] = refreshed
            return {'deleted': id}

    async def delete_branch(self, id, branch, head, snapshot):
        directory = await self.directory(id)
        path = directory['path']
        async with self.locks.setdefault(directory['common_dir'], asyncio.Lock()):
            await self.protect_branch(path, branch)
            state = await self.reviewed(id, snapshot)
            if state['active'] or state['operation']:
                raise GitError('There are running tasks or incomplete Git operations in the project. Please delete the branch later.', 409)
            branch_data = await self.branches(id)
            target = next((item for item in branch_data['branches'] if item['name'] == branch), None)
            if not target or target['head'] != head:
                raise GitError('Branch has changed, please refresh and try again.', 409)
            if target['worktree_id']:
                raise GitError('Branch is already checked out in the working directory. Please switch or remove the corresponding working directory first.', 409)
            await self.require_preserved_head(path, head, branch_data['branches'], branch)
            await self.command(path, 'update-ref', '-d', 'refs/heads/' + branch, head)
            return await self.branches(id)

    async def create_branch(self, id, name, base_branch, base_head, snapshot, base_remote=None):
        directory = await self.directory(id)
        path = directory['path']
        async with self.locks.setdefault(directory['common_dir'], asyncio.Lock()):
            state = await self.reviewed(id, snapshot)
            if state['active'] or state['operation']:
                raise GitError('There are running tasks or incomplete Git operations in the project. Please create the branch later.', 409)
            _, code = await self.command(path, 'check-ref-format', '--branch', name, check=False)
            if code:
                raise GitError('Invalid new branch name.')
            _, code = await self.command(path, 'check-ref-format', '--branch', base_branch, check=False)
            if code:
                raise GitError('Invalid source branch name.')
            branch_data = await self.branches(id)
            if any(item['name'] == name for item in branch_data['branches']):
                raise GitError('New branch name already exists.', 409)
            if base_remote:
                await self.validate_remote(path, base_remote)
                base = next((item for item in branch_data['remote_branches']
                             if item['remote'] == base_remote and item['branch'] == base_branch), None)
            else:
                base = next((item for item in branch_data['branches'] if item['name'] == base_branch), None)
            if not base:
                raise GitError('Source branch does not exist, please refresh the branch list.', 404)
            if base['head'] != base_head:
                raise GitError('Source branch has changed, please refresh and retry.', 409)
            await self.command(path, 'branch', '--no-track', '--', name, base_head)
            return await self.branches(id)

    async def set_global_identity(self, id, name, email):
        directory = await self.directory(id)
        await self.command(directory['path'], 'config', '--global', 'user.name', name)
        await self.command(directory['path'], 'config', '--global', 'user.email', email)
        return await self.global_identity(id)

    @staticmethod
    def credential_host(url):
        parsed = urlsplit(url)
        if not parsed.hostname:
            return None
        if parsed.scheme.lower() == 'https':
            return parsed.hostname.lower() + (f':{parsed.port}' if parsed.port else '')
        if parsed.scheme.lower() == 'http' and parsed.port in {None, 80}:
            return parsed.hostname.lower()
        return None

    @classmethod
    def normalize_credential_host(cls, host):
        host = host.strip()
        if not re.fullmatch(r'[A-Za-z0-9.-]+(?::[0-9]{1,5})?', host):
            raise GitError('Please enter the hostname in the HTTPS remote address.')
        try:
            normalized = cls.credential_host('https://' + host)
        except ValueError as exc:
            raise GitError('Invalid HTTPS hostname.') from exc
        if not normalized:
            raise GitError('Invalid HTTPS hostname.')
        return normalized

    async def credential_hosts(self):
        await self.load_credentials()
        return {'hosts': sorted(self.remote_credentials)}

    async def save_host_credentials(self, host, username, token):
        host = self.normalize_credential_host(host)
        await self.change_credentials(host, {'username': username, 'token': token})
        return await self.credential_hosts()

    async def clear_host_credentials(self, host):
        await self.change_credentials(self.normalize_credential_host(host), None)
        return await self.credential_hosts()

    async def remote_url(self, path, remote, *, push=False):
        args = ('remote', 'get-url', '--push', '--', remote) if push else ('remote', 'get-url', '--', remote)
        url, _ = await self.command(path, *args)
        return text(url).strip()

    async def credentials(self, id):
        await self.load_credentials()
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
            raise GitError('User name and access token are only used for HTTPS or HTTP remote sources that can be upgraded to HTTPS.')
        await self.change_credentials(host, {'username': username, 'token': token})
        return await self.credentials(id)

    async def clear_credentials(self, id, remote):
        directory = await self.directory(id)
        await self.validate_remote(directory['path'], remote)
        host = self.credential_host(await self.remote_url(directory['path'], remote))
        if host:
            await self.change_credentials(host, None)
        return await self.credentials(id)

    async def credential_for(self, directory, remote, *, push=False):
        await self.load_credentials()
        current = await self.remote_url(directory['path'], remote, push=push)
        parsed = urlsplit(current)
        host = self.credential_host(current)
        upgrade = None
        if parsed.scheme.lower() == 'http' and parsed.hostname and parsed.port in {None, 80}:
            host = parsed.hostname.lower()
            upgrade = {'upgrade_from': f'http://{parsed.netloc}/',
                       'upgrade_to': f'https://{host}/'}
        saved = self.remote_credentials.get(host)
        return {'username': saved['username'], 'token': saved['token'], 'host': host,
                **(upgrade or {})} if saved else None

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
            raise GitError('File or branch has changed. Please refresh and review again before proceeding.', 409)
        if state['operation'] or any(f['conflict'] for f in state['files']):
            raise GitError('Repository has conflicts or unfinished Git operations; please resolve them locally first.', 409)
        return state

    async def commit(self, id, paths, message, snapshot):
        directory = await self.directory(id)
        async with self.locks.setdefault(directory['common_dir'], asyncio.Lock()):
            state = await self.reviewed(id, snapshot)
            files = {f['path']: f for f in state['files']}
            if not paths or len(set(paths)) != len(paths) or any(p not in files for p in paths):
                raise GitError('The submitted file has changed. Please reselect.', 409)
            if any(files[p]['submodule'] for p in paths):
                raise GitError('Submodule changes should be handled in local Git.')
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
                    raise GitError(str(exc) + '\nHEAD has changed; a commit may have been generated. Please check the commit history first and do not directly repeat the commit.', 409) from exc
                if 'Author identity unknown' in str(exc) or 'unable to auto-detect email address' in str(exc):
                    raise GitError('Git commit author is not configured. Set your name and email for this repository:\n'
                        'git config user.name "Your Name"\n'
                        'git config user.email "Your Email"\n'
                        'Then refresh and try again. Selected files that were staged will stay staged.', exc.status) from exc
                raise GitError(str(exc) + '\nCommit did not complete. Refresh to check the status. Selected files that were staged will stay staged.', exc.status) from exc
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
                raise GitError('File status has changed, please refresh and try again.', 409)
            if file['conflict'] or file['submodule']:
                raise GitError('Conflicting files and submodules need to be handled in local Git.', 409)
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
                raise GitError('File status has changed, please refresh and try again.', 409)
            if not file['untracked'] or file['submodule']:
                raise GitError('Only untracked files can be added to Git ignore.', 409)
            await asyncio.to_thread(append_gitignore, root, value)
            return await self.status(id)

    async def save_file(self, id, value, content, snapshot, expected_content=None):
        directory = await self.directory(id)
        root = directory['path']
        async with self.locks.setdefault(directory['common_dir'], asyncio.Lock()):
            state = await self.reviewed(id, snapshot)
            file = next((item for item in state['files'] if item['path'] == value), None)
            if not file:
                tracked, code = await self.command(root, 'ls-files', '-z', '--error-unmatch', '--', value, check=False)
                if expected_content is None or code or value not in text(tracked).split('\0'):
                    raise GitError('File status has changed, please refresh and try again.', 409)
            if file and (file['conflict'] or file['submodule']):
                raise GitError('Conflicting files and submodules cannot be edited in the comparison window.', 409)
            if expected_content is not None:
                current, truncated = await asyncio.to_thread(read_file, root, value)
                if truncated or text(current) != expected_content:
                    raise GitError('The file has changed during review. Please refresh and try again.', 409)
            await asyncio.to_thread(replace_worktree_file, root, value, content)
            return await self.status(id)

    async def generate_commit_message(self, id, paths, snapshot, locale="zh-CN"):
        directory = await self.directory(id)
        root = directory['path']
        state = await self.reviewed(id, snapshot)
        files = {item['path']: item for item in state['files']}
        if not paths or len(set(paths)) != len(paths) or any(path not in files for path in paths):
            raise GitError('The file used to generate the commit message has changed. Please reselect.', 409)
        if any(files[path]['conflict'] or files[path]['submodule'] for path in paths):
            raise GitError('Conflicting files and submodules cannot be used to generate commit messages.', 409)
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
                patch = text(raw) + '\n[Detailed diff omitted because it is too large]'
        untracked_parts = []
        for path in paths:
            if not files[path]['untracked']:
                continue
            data, truncated = await asyncio.to_thread(read_file, root, path)
            if b'\0' in data:
                untracked_parts.append(("new_binary_file", path))
            else:
                body = text(data[:20000])
                suffix = '\n[Content truncated]' if truncated or len(data) > 20000 else ''
                untracked_parts.append(("new_file", f"{path}\n{body}{suffix}"))
        # Bound content before wrapping so truncation cannot cut a closing tag.
        context = ''
        for tag, body in [
            ('selected_file_statuses', '\n'.join(status_lines)),
            ('git_diff', patch or '[No tracked-file diff]'),
            *untracked_parts,
        ]:
            separator = '\n' if context else ''
            remaining = 120000 - len(context) - len(separator) - len(prompt_section(tag, '')) - 1
            if remaining <= 0:
                break
            context += separator + prompt_section(tag, body[:remaining])
        from services.config import config_store
        from services import providers as provider_service
        from services.gateway_client.usage import snapshot_usage_provider
        from main import gateway_client
        config = await asyncio.to_thread(config_store.get_prompt_enhance_config)
        if not config.get('provider_id') or not config.get('model'):
            raise GitError('Configure a provider and model for prompt enhancement in Settings.', 409)
        provider = await asyncio.to_thread(config_store.get_provider, config['provider_id'])
        if provider is None:
            raise GitError('Prompt enhancement provider not found. Update it in Settings.', 409)
        provider_snapshot = snapshot_usage_provider(provider)
        usage: dict = {}
        try:
            result = await provider_service.text_completion(provider, config['model'], [
                {'role': 'system', 'content': COMMIT_MESSAGE_SYSTEM_PROMPT + '\n' + output_language_instruction(locale)},
                {'role': 'user', 'content': context},
            ], max_tokens=800, timeout=180, thinking='disabled',
                protocol=config.get('protocol') or None, usage_collector=usage)
        except httpx.TimeoutException as exc:
            raise GitError('Generating commit message timed out (180 seconds). Please check the vendor connection or try again later.', 504) from exc
        except Exception as exc:
            detail = str(exc).strip() or type(exc).__name__
            raise GitError(f'Failed to generate commit message: {detail}', 502) from exc
        project_ids = directory['project_ids']
        await gateway_client.record_one_shot_usage(
            project_id=project_ids[0] if len(project_ids) == 1 else None,
            model=config['model'], provider=provider_snapshot, usage=usage or None,
        )
        return {'message': normalize_commit_message(result)}

    async def switch(self, id, branch, snapshot, remote=None):
        directory = await self.directory(id)
        async with self.locks.setdefault(directory['common_dir'], asyncio.Lock()):
            state = await self.reviewed(id, snapshot)
            if state['active']:
                raise GitError('This project has running tasks or conversations. Please end them before switching branches.', 409)
            _, code = await self.command(directory['path'], 'check-ref-format', '--branch', branch, check=False)
            if code:
                raise GitError('Invalid branch name.')
            branch_data = await self.branches(id)
            branches = branch_data['branches']
            target = next((b for b in branches if b['name'] == branch), None)
            if remote:
                await self.validate_remote(directory['path'], remote)
                remote_target = next((item for item in branch_data['remote_branches']
                    if item['remote'] == remote and item['branch'] == branch), None)
                if not remote_target:
                    raise GitError('Remote branch does not exist, please pull the branch again.', 404)
            elif not target:
                raise GitError('Local branch does not exist, please refresh.', 404)
            if target and target['worktree_id'] and target['worktree_id'] != id:
                raise GitError('This branch is already checked out in another working directory. Please navigate to that directory.', 409)
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
                raise GitError('Project has running tasks or conversations. Please end them before updating the branch.', 409)
            if state['branch'] == branch:
                raise GitError('Please use pull to update the current branch.', 409)
            target = next((item for item in (await self.branches(id))['branches'] if item['name'] == branch), None)
            if not target:
                raise GitError('Local branch does not exist, please refresh.', 404)
            if target['worktree_id']:
                raise GitError('This branch is already checked out in the working directory. Please navigate to the corresponding directory and pull.', 409)
            if not target['remote'] or target['remote'] == '.' or not target['upstream_ref']:
                raise GitError('No remote upstream to pull from this branch.', 409)
            auth = await self.credential_for(directory, target['remote'])
            await self.command(path, 'fetch', '--prune', '--no-recurse-submodules', '--', target['remote'], timeout=120, auth=auth)
            self.fetched_at[directory['common_dir']] = time.time()
            state = await self.reviewed(id, snapshot)
            if state['active']:
                raise GitError('Project has running tasks or conversations. Please end them before updating the branch.', 409)
            target = next((item for item in (await self.branches(id))['branches'] if item['name'] == branch), None)
            if not target or target['worktree_id'] or not target['upstream_ref']:
                raise GitError('Branch status has changed, please refresh and try again.', 409)
            remote_head, code = await self.command(path, 'rev-parse', '--verify', '--end-of-options', target['upstream_ref'] + '^{commit}', check=False)
            if code:
                raise GitError('The upstream branch no longer exists. Please pull the branch again.', 409)
            remote_sha = text(remote_head).strip()
            counts, _ = await self.command(path, 'rev-list', '--left-right', '--count', target['head'] + '...' + remote_sha, '--')
            ahead, behind = map(int, counts.split())
            if ahead and behind:
                raise GitError('Local and upstream branches have diverged, cannot fast-forward update.', 409)
            if behind:
                await self.command(path, 'update-ref', 'refs/heads/' + branch, remote_sha, target['head'])
            return await self.branches(id)

    async def merge(self, id, branch, snapshot, source, remote=None):
        directory = await self.directory(id)
        path = directory['path']
        async with self.locks.setdefault(directory['common_dir'], asyncio.Lock()):
            state = await self.reviewed(id, snapshot)
            if state['branch'] != branch or not state['head']:
                raise GitError('Can only merge into the currently submitted branch. Please refresh the status.', 409)
            if state['active']:
                raise GitError('Project has running tasks or conversations, please end them before merging.', 409)
            if state['operation']:
                raise GitError('Please complete the current Git operation.', 409)
            _, code = await self.command(path, 'check-ref-format', '--branch', source, check=False)
            if code:
                raise GitError('Invalid source branch name.')
            if remote:
                await self.validate_remote(path, remote)
                candidates = (await self.branches(id))['remote_branches']
                if not any(item['remote'] == remote and item['branch'] == source for item in candidates):
                    raise GitError('Remote branch does not exist, please refresh the remote status first.', 404)
                ref = f'refs/remotes/{remote}/{source}'
            else:
                candidates = (await self.branches(id))['branches']
                if not any(item['name'] == source for item in candidates):
                    raise GitError('Local branch does not exist, please refresh.', 404)
                ref = f'refs/heads/{source}'
            source_head, code = await self.command(path, 'rev-parse', '--verify', '--end-of-options', ref + '^{commit}', check=False)
            if code:
                raise GitError('Source branch has changed, please refresh.', 409)
            await self.merge_commit(path, text(source_head).strip())
            after = await self.revision(path)
            await self.record_merge(directory, target=branch, source=ref, before=state['head'],
                                    base=state['head'], after=after)
            return await self.status(id)

    async def merge_commit(self, path, source_head):
        try:
            await self.command(path, '-c', 'merge.autoStash=false', 'merge', '--no-edit', source_head, timeout=120)
        except GitError as exc:
            _, merging = await self.command(path, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD', check=False)
            if not merging:
                try:
                    await self.command(path, 'merge', '--abort', timeout=120)
                except GitError as abort_error:
                    raise GitError('Merge failed, and auto-abort also did not complete; please check the current Git status.\n' + str(abort_error), 409) from abort_error
                raise GitError('Merge conflict occurred, automatically aborted; existing uncommitted changes have been preserved.\n' + str(exc), 409) from exc
            raise GitError('Git refuses to merge; existing uncommitted changes have been preserved.\n' + str(exc), 409) from exc

    async def merge_into(self, id, branch, snapshot, target_name):
        directory = await self.directory(id)
        path = directory['path']
        async with self.locks.setdefault(directory['common_dir'], asyncio.Lock()):
            state = await self.reviewed(id, snapshot)
            if state['branch'] != branch or not state['head'] or state['active'] or state['operation']:
                raise GitError('The current branch state has changed, or there are running tasks and incomplete Git operations.', 409)
            _, code = await self.command(path, 'check-ref-format', '--branch', target_name, check=False)
            if code or target_name == branch:
                raise GitError('Please select a different valid target branch.')
            targets = (await self.branches(id))['branches']
            target = next((item for item in targets if item['name'] == target_name), None)
            if not target:
                raise GitError('Target local branch does not exist, please refresh the branch list.', 404)
            target_id = target['worktree_id']
            target_path = (await self.directory(target_id))['path'] if target_id else None
            if target_id:
                target_state = await self.status(target_id)
                if target_state['branch'] != target_name or target_state['active'] or target_state['operation']:
                    raise GitError('The target branch is in use or has unfinished Git operations.', 409)
            updated = False
            merge_base_head = target['head']
            if target['remote'] and target['remote'] != '.' and target['upstream_ref']:
                auth = await self.credential_for(directory, target['remote'])
                await self.command(path, 'fetch', '--prune', '--no-recurse-submodules', '--', target['remote'], timeout=120, auth=auth)
                self.fetched_at[directory['common_dir']] = time.time()
                state = await self.reviewed(id, snapshot)
                if state['branch'] != branch or state['active'] or state['operation']:
                    raise GitError('Current branch changed during update of target branch, please retry.', 409)
                current_head, _ = await self.command(path, 'rev-parse', '--verify', 'refs/heads/' + target_name)
                if text(current_head).strip() != target['head']:
                    raise GitError('The target branch has changed. Please refresh and try again.', 409)
                remote_head, code = await self.command(path, 'rev-parse', '--verify', '--end-of-options', target['upstream_ref'] + '^{commit}', check=False)
                if code:
                    raise GitError('The upstream of the target branch no longer exists. Please check the remote configuration.', 409)
                remote_sha = text(remote_head).strip()
                counts, _ = await self.command(path, 'rev-list', '--left-right', '--count', target['head'] + '...' + remote_sha, '--')
                ahead, behind = map(int, counts.split())
                if ahead and behind:
                    raise GitError('The target branch has diverged from the upstream, so a fast-forward update is not possible.', 409)
                if behind:
                    merge_base_head = remote_sha
                    updated = True
            current_head, _ = await self.command(path, 'rev-parse', '--verify', 'refs/heads/' + target_name)
            if text(current_head).strip() != target['head']:
                raise GitError('The target branch has changed. Please refresh and try again.', 409)
            temporary = await asyncio.to_thread(tempfile.mkdtemp, prefix='workstep-git-merge-')
            added = False
            try:
                await self.command(path, 'worktree', 'add', '--detach', temporary, merge_base_head, timeout=120)
                added = True
                await self.merge_commit(temporary, state['head'])
                head, _ = await self.command(temporary, 'rev-parse', 'HEAD')
                merged_head = text(head).strip()
                state = await self.reviewed(id, snapshot)
                if state['branch'] != branch or state['active'] or state['operation']:
                    raise GitError('The current branch has changed during the merge. Please refresh and try again.', 409)
                if target_path:
                    latest = await self.status(target_id)
                    if (latest['branch'] != target_name or latest['head'] != target['head']
                            or latest['snapshot'] != target_state['snapshot'] or latest['active'] or latest['operation']):
                        raise GitError('The target working directory has changed. Please refresh and try again.', 409)
                    try:
                        await self.command(target_path, '-c', 'merge.autoStash=false', 'merge', '--ff-only', '--no-edit', merged_head, timeout=120)
                    except GitError as exc:
                        if latest['files'] and ('would be overwritten' in str(exc) or 'not uptodate' in str(exc)):
                            raise GitError('Uncommitted changes in the target work directory overlap with merge results; kept as-is. Please handle the corresponding files first.\n' + str(exc), 409) from exc
                        raise
                else:
                    await self.command(path, 'update-ref', 'refs/heads/' + target_name, merged_head, target['head'])
                await self.record_merge(directory, target=target_name, source='refs/heads/' + branch,
                                        before=target['head'], base=merge_base_head, after=merged_head)
                return {'target': target_name, 'head': merged_head, 'updated': updated,
                        'push_available': bool(target['remote'] and target['remote'] != '.' and target['upstream_ref'])}
            finally:
                if added:
                    await self.command(path, 'worktree', 'remove', '--force', temporary, timeout=120)
                await asyncio.to_thread(shutil.rmtree, temporary, ignore_errors=True)

    async def push_branch(self, id, branch, head, remote=None, target_branch=None, set_upstream=False):
        directory = await self.directory(id)
        path = directory['path']
        async with self.locks.setdefault(directory['common_dir'], asyncio.Lock()):
            if (await self.status(id))['active']:
                raise GitError('Project has running tasks or conversations, please end them before pushing.', 409)
            target = next((item for item in (await self.branches(id))['branches'] if item['name'] == branch), None)
            if not target or target['head'] != head:
                raise GitError('The target branch has changed. Please refresh and re-review before pushing.', 409)
            remote, target_branch = await self.remote_target(path, branch, remote, target_branch)
            auth = await self.credential_for(directory, remote, push=True)
            await self.command(path, '-c', 'remote.' + remote + '.mirror=false', 'push',
                '--porcelain', '--no-force', '--no-follow-tags', '--recurse-submodules=no',
                '--', remote, head + ':refs/heads/' + target_branch, timeout=120, auth=auth)
            if set_upstream:
                await self.command(path, 'branch', '--set-upstream-to=' + remote + '/' + target_branch, '--', branch)
            return {'branch': branch, 'head': head}


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
            raise GitError('Remote source does not exist, please refresh the remote list.', 404)
        return remote

    async def remote_target(self, path, branch, remote=None, target_branch=None):
        if bool(remote) != bool(target_branch):
            raise GitError('Please select a complete remote source and remote branch.')
        if not remote:
            raw, _ = await self.command(path, 'for-each-ref',
                '--format=%(upstream:remotename)%00%(upstream:remoteref)', 'refs/heads/' + branch)
            remote, _, remote_ref = text(raw).strip().partition('\0')
            if not remote or remote == '.' or not remote_ref.startswith('refs/heads/'):
                raise GitError('The current branch has no remote upstream configured. Please select a remote source and target branch.', 409)
            target_branch = remote_ref.removeprefix('refs/heads/')
        await self.validate_remote(path, remote)
        _, code = await self.command(path, 'check-ref-format', '--branch', target_branch, check=False)
        if code:
            raise GitError('Invalid remote branch name.')
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
                raise GitError('Upstream branch no longer exists. Please check remote branch settings.', 409)
            sha = text(remote_head).strip()
            counts, _ = await self.command(path, 'rev-list', '--left-right', '--count', state['head'] + '...' + sha, '--')
            ahead, behind = map(int, counts.split())
            if ahead and behind:
                raise GitError('Local and upstream branches have diverged, cannot fast-forward update. Please handle merge or rebase locally.', 409)
            if behind:
                await self.command(path, '-c', 'merge.autoStash=false', 'merge', '--ff-only', '--no-edit', sha, timeout=120)
            if set_upstream:
                await self.command(path, 'branch', '--set-upstream-to=' + remote + '/' + target_branch, '--', branch)
            return await self.status(id)

    @staticmethod
    def require_pullable(state, branch):
        if not state['branch'] or state['branch'] != branch:
            raise GitError('Only the currently checked-out branch can be pulled. Please switch or navigate to the corresponding working directory.', 409)
        if state['active']:
            raise GitError('Project has running tasks or conversations, please end them before pulling.', 409)


    async def push(self, id, branch, snapshot, remote=None, target_branch=None, set_upstream=False):
        directory = await self.directory(id)
        path = directory['path']
        async with self.locks.setdefault(directory['common_dir'], asyncio.Lock()):
            state = await self.reviewed(id, snapshot)
            if not state['branch'] or state['branch'] != branch or not state['head']:
                raise GitError('Only the currently submitted branch can be pushed. Please refresh the status.', 409)
            if state['active']:
                raise GitError('Project has running tasks or conversations, please end them before pushing.', 409)
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
