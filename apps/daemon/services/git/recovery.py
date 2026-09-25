"""Preview and apply history-preserving Git recovery operations."""
import asyncio
import json
import os
import shutil
import tempfile
import uuid
from pathlib import Path

from .command import GitError, text


def _read_records(common_dir):
    file = Path(common_dir) / 'workstep-merge-operations.json'
    if file.is_symlink():
        raise GitError('合并记录文件不能是符号链接。', 409)
    if not file.exists():
        return []
    try:
        value = json.loads(file.read_text(encoding='utf-8'))
    except (OSError, ValueError) as exc:
        raise GitError('合并记录无法读取，请检查仓库元数据。', 409) from exc
    if not isinstance(value, list):
        raise GitError('合并记录格式无效。', 409)
    return value


def _write_records(common_dir, records):
    file = Path(common_dir) / 'workstep-merge-operations.json'
    if file.is_symlink():
        raise GitError('合并记录文件不能是符号链接。', 409)
    fd, temporary = tempfile.mkstemp(prefix='workstep-merge-', dir=common_dir)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(records, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, file)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class GitRecoveries:
    async def record_merge(self, directory, *, target, source, before, base, after):
        if before == after:
            return
        records = await asyncio.to_thread(_read_records, directory['common_dir'])
        records.append({'id': uuid.uuid4().hex, 'target': target, 'source': source,
                        'before': before, 'base': base, 'after': after, 'undone_by': None})
        await asyncio.to_thread(_write_records, directory['common_dir'], records)

    async def recoveries(self, id):
        directory = await self.directory(id)
        records = await asyncio.to_thread(_read_records, directory['common_dir'])
        return {'merges': list(reversed(records))}

    async def _recovery_target(self, id, target):
        directory = await self.directory(id)
        branches = (await self.branches(id))['branches']
        branch = next((item for item in branches if item['name'] == target), None)
        if not branch:
            raise GitError('目标分支不存在，请刷新。', 404)
        target_id = branch['worktree_id']
        target_path = (await self.directory(target_id))['path'] if target_id else None
        if target_path:
            status = await self.status(target_id)
            if status['branch'] != target or status['active'] or status['operation']:
                raise GitError('目标分支正在使用或有未完成的 Git 操作。', 409)
        return directory, branch, target_path

    async def _prepare_recovery(self, path, common_dir, mode, target, commit, operation_id, head):
        if mode == 'undo_merge':
            if not operation_id:
                raise GitError('请选择要撤销的合并记录。')
            records = await asyncio.to_thread(_read_records, common_dir)
            record = next((item for item in records if item['id'] == operation_id and item['target'] == target), None)
            if not record or record.get('undone_by'):
                raise GitError('合并记录不存在或已撤销。', 404)
            commit = record['after']
            base = record['base']
            if base == commit:
                raise GitError('合并没有引入新内容。', 409)
        elif mode == 'undo_commit':
            base = None
        elif mode == 'restore_tree':
            base = None
        else:
            raise GitError('未知的恢复操作。')
        if not commit:
            raise GitError('请选择历史提交。')
        raw, code = await self.command(path, 'rev-parse', '--verify', '--end-of-options', commit + '^{commit}', check=False)
        if code:
            raise GitError('历史提交不存在。', 404)
        commit = text(raw).strip()
        _, code = await self.command(path, 'merge-base', '--is-ancestor', commit, head, check=False)
        if code:
            raise GitError('所选提交不在目标分支历史中。', 409)
        if mode == 'undo_merge':
            parents, _ = await self.command(path, 'rev-list', '--parents', '-n', '1', commit)
            parent_count = len(text(parents).split()) - 1
            strategy = 'merge' if parent_count == 2 and base == text(parents).split()[1] else 'fast_forward'
        elif mode == 'undo_commit':
            parents, _ = await self.command(path, 'rev-list', '--parents', '-n', '1', commit)
            if len(text(parents).split()) != 3:
                raise GitError('请选择双亲合并提交。', 409)
            strategy = 'merge'
        else:
            strategy = 'restore'
        return commit, base, strategy

    async def _run_recovery(self, path, common_dir, head, mode, target, commit, operation_id, *, apply, identity=None):
        commit, base, strategy = await self._prepare_recovery(path, common_dir, mode, target, commit, operation_id, head)
        temporary = await asyncio.to_thread(tempfile.mkdtemp, prefix='workstep-git-recovery-')
        added = False
        try:
            await self.command(path, 'worktree', 'add', '--detach', temporary, head, timeout=120)
            added = True
            try:
                if strategy == 'merge':
                    await self.command(temporary, 'revert', '--no-commit', '-m', '1', commit, timeout=120)
                elif strategy == 'fast_forward':
                    patch, _ = await self.command(temporary, 'diff', '--binary', base, commit, '--', limit=64 * 1024 * 1024)
                    await self.command(temporary, 'apply', '--reverse', '--3way', '--index', stdin=patch, timeout=120)
                else:
                    await self.command(temporary, 'restore', '--source=' + commit, '--staged', '--worktree', '--', '.', timeout=120)
            except GitError as exc:
                raise GitError('恢复内容发生冲突，目标分支未改变。\n' + str(exc), 409) from exc
            diff, _ = await self.command(temporary, 'diff', '--cached', '--name-only', '-z', '--')
            files = [text(item) for item in diff.split(b'\0') if item]
            if not files:
                raise GitError('恢复后内容没有变化。', 409)
            numstat, _ = await self.command(temporary, 'diff', '--cached', '--numstat', '--no-renames', '-z', '--')
            changes = []
            for entry in numstat.split(b'\0'):
                if entry:
                    added, deleted, filename = text(entry).split('\t', 2)
                    changes.append({'path': filename, 'added': added, 'deleted': deleted})
            request = {'mode': mode, 'target': target}
            if operation_id:
                request['operation_id'] = operation_id
            else:
                request['commit'] = commit
            if not apply:
                return {'head': head, 'files': files, 'changes': changes, 'request': request, 'strategy': strategy}
            message = ('revert: 撤销合并 ' if mode != 'restore_tree' else 'revert: 还原到提交 ') + commit[:8]
            config = ('-c', 'user.name=' + identity['name'], '-c', 'user.email=' + identity['email']) if identity and identity['name'] and identity['email'] else ()
            await self.command(temporary, *config, 'commit', '-m', message, timeout=120)
            raw, _ = await self.command(temporary, 'rev-parse', 'HEAD')
            return {'head': head, 'new_head': text(raw).strip(), 'files': files, 'request': request}
        finally:
            if added:
                await self.command(path, 'worktree', 'remove', '--force', temporary, timeout=120)
            await asyncio.to_thread(shutil.rmtree, temporary, ignore_errors=True)

    async def recovery_preview(self, id, mode, target, commit=None, operation_id=None):
        directory = await self.directory(id)
        async with self.locks.setdefault(directory['common_dir'], asyncio.Lock()):
            _, branch, _ = await self._recovery_target(id, target)
            if (await self.status(id))['active']:
                raise GitError('项目有正在运行的任务或对话，请结束后再恢复。', 409)
            return await self._run_recovery(directory['path'], directory['common_dir'], branch['head'],
                                            mode, target, commit, operation_id, apply=False)

    async def recovery_apply(self, id, mode, target, expected_head, commit=None, operation_id=None):
        directory = await self.directory(id)
        async with self.locks.setdefault(directory['common_dir'], asyncio.Lock()):
            _, branch, target_path = await self._recovery_target(id, target)
            if branch['head'] != expected_head or (await self.status(id))['active']:
                raise GitError('目标分支已变化，请重新预览。', 409)
            if branch.get('remote') and branch['remote'] != '.' and branch.get('upstream_ref'):
                auth = await self.credential_for(directory, branch['remote'])
                await self.command(directory['path'], 'fetch', '--prune', '--no-recurse-submodules',
                                   '--', branch['remote'], timeout=120, auth=auth)
                remote_head, code = await self.command(directory['path'], 'rev-parse', '--verify',
                                                        branch['upstream_ref'] + '^{commit}', check=False)
                if code:
                    raise GitError('目标分支的远程上游已不存在，请刷新。', 409)
                _, behind = await self.command(directory['path'], 'merge-base', '--is-ancestor',
                                               text(remote_head).strip(), expected_head, check=False)
                if behind:
                    raise GitError('目标分支的远程上游已有新提交，请先更新目标分支再预览。', 409)
            identity = await self.identity(branch['worktree_id'] or id)
            result = await self._run_recovery(directory['path'], directory['common_dir'], expected_head,
                                              mode, target, commit, operation_id, apply=True, identity=identity)
            if target_path:
                latest = await self.status(branch['worktree_id'])
                if latest['branch'] != target or latest['head'] != expected_head or latest['active'] or latest['operation']:
                    raise GitError('目标分支已变化，请重新预览。', 409)
                try:
                    await self.command(target_path, '-c', 'merge.autoStash=false', 'merge', '--ff-only', result['new_head'], timeout=120)
                except GitError as exc:
                    raise GitError('目标工作目录与恢复结果冲突，未改变分支。\n' + str(exc), 409) from exc
            else:
                await self.command(directory['path'], 'update-ref', 'refs/heads/' + target,
                                   result['new_head'], expected_head)
            if mode == 'undo_merge':
                records = await asyncio.to_thread(_read_records, directory['common_dir'])
                for record in records:
                    if record['id'] == operation_id:
                        record['undone_by'] = result['new_head']
                await asyncio.to_thread(_write_records, directory['common_dir'], records)
            return {'target': target, 'head': result['new_head'], 'files': result['files'],
                    'push_available': bool(branch.get('remote') and branch['remote'] != '.' and branch.get('upstream_ref'))}
