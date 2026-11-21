"""Optional channel directories with private, persistent JSON snapshots."""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import tempfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from functools import partial


class DirectoryError(ValueError):
    def __init__(self, code, message, candidates=None):
        super().__init__(message)
        self.code = code
        self.candidates = candidates or []

    def detail(self):
        return {'code': self.code, 'message': str(self), 'candidates': self.candidates}


def _index(rows):
    contacts, names = {}, {}
    for row in rows:
        item = {**row, 'departments': list(row.get('departments', []))}
        key = str(item['contact_id'])
        if not key or not item['name']:
            raise ValueError('Invalid directory member')
        contacts[key] = item
    for item in contacts.values():
        names.setdefault(item['name'].strip(), []).append(item)
    return contacts, names


class ChannelDirectoryService:
    def __init__(self, provider):
        self._provider = provider
        self._snapshots = {}
        self._observed_senders = {}
        self._states = {}
        self._identities = {}
        self._tasks = {}
        self._retired = set()
        self._cleanups = {}
        from services.config import CONFIG_DIR
        self._cache_dir = CONFIG_DIR / 'channels' / 'directories'
        self._limit = asyncio.Semaphore(2)
        self._pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix='channel-directory')

    async def work(self, operation, *args):
        future = asyncio.get_running_loop().run_in_executor(self._pool, partial(operation, *args))
        try:
            return await asyncio.shield(future)
        except asyncio.CancelledError:
            # Finish filesystem work before invalidation/deletion can overtake it.
            await future
            raise

    def _cache_path(self, bot_id):
        return self._cache_dir / (hashlib.sha256(bot_id.encode()).hexdigest() + '.json')

    def _fingerprint(self, bot):
        return hashlib.sha256(json.dumps(self._identity(bot)).encode()).hexdigest()

    def _read_cache(self, bot):
        try:
            value = json.loads(self._cache_path(bot['id']).read_text('utf-8'))
            if value['version'] != 1 or value['identity'] != self._fingerprint(bot):
                return None
            if not isinstance(value['updated_at'], str) or not isinstance(value['contacts'], list):
                return None
            for row in value['contacts']:
                if (not isinstance(row, dict)
                        or not all(isinstance(row.get(key), str) for key in ('contact_id', 'name', 'user_id'))
                        or not isinstance(row.get('departments'), list)
                        or not all(isinstance(name, str) for name in row['departments'])):
                    return None
            return _index(value['contacts']), value['updated_at']
        except (OSError, ValueError, KeyError, TypeError):
            return None

    def _write_cache(self, bot, snapshot, updated_at):
        self._cache_dir.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(dir=self._cache_dir, prefix='.directory-')
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as stream:
                json.dump({'version': 1, 'identity': self._fingerprint(bot),
                           'updated_at': updated_at, 'contacts': list(snapshot[0].values())},
                          stream, ensure_ascii=False)
            os.replace(temporary, self._cache_path(bot['id']))
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    @staticmethod
    def _identity(bot):
        return tuple(bot.get(key) for key in ('platform','app_id','secret','directory_corp_id','directory_secret','directory_agent_id'))

    def configure(self, bot):
        identity = self._identity(bot)
        if (bot['id'] in self._identities and self._identities[bot['id']] != identity
                or not (bot.get('enabled') and bot.get('directory_enabled'))):
            self.remove(bot['id'])
        self._identities[bot['id']] = identity
        if bot.get('enabled') and bot.get('directory_enabled') and bot['id'] not in self._snapshots:
            self.refresh(bot, use_cache=True)

    def remove(self, bot_id):
        task = self._tasks.pop(bot_id, None)
        if task:
            task.cancel()
            self._retired.add(task)
            task.add_done_callback(self._retired.discard)
        self._snapshots.pop(bot_id, None)
        self._observed_senders.pop(bot_id, None)
        self._states.pop(bot_id, None)
        self._identities.pop(bot_id, None)
        previous = self._cleanups.get(bot_id)
        async def cleanup():
            await asyncio.gather(*(item for item in (task, previous) if item), return_exceptions=True)
            await self.work(partial(self._cache_path(bot_id).unlink, missing_ok=True))
        cleanup_task = asyncio.create_task(cleanup())
        self._cleanups[bot_id] = cleanup_task
        self._retired.add(cleanup_task)
        cleanup_task.add_done_callback(self._retired.discard)

    def observe_sender(self, bot_id, sender_id):
        # Only exact IDs received on this bot are usable; names are never evidence.
        if sender_id and bot_id in self._tasks:
            self._observed_senders.setdefault(bot_id, set()).add(sender_id)

    def _recipient(self, bot_id, row):
        if not row.get('user_id') and row['contact_id'] in self._observed_senders.get(bot_id, ()):
            return {**row, 'user_id': row['contact_id']}
        return row

    @staticmethod
    def _check(bot):
        if not bot.get('directory_enabled') or not bot.get('enabled'):
            raise DirectoryError('directory_disabled', 'Please enable the bot and contacts first')

    def status(self, bot_id):
        return {'status': 'idle', 'count': len(self._snapshots.get(bot_id, ({}, {}))[0]),
                'updated_at': None, 'error': '', **self._states.get(bot_id, {})}

    def refresh(self, bot, *, use_cache=False):
        self._check(bot)
        task = self._tasks.get(bot['id'])
        if task and not task.done():
            return self.status(bot['id'])
        fetch = self._provider(bot)
        if fetch is None:
            raise DirectoryError('directory_unsupported', 'This channel does not support the address book')
        self._identities[bot['id']] = self._identity(bot)
        self._states[bot['id']] = {**self.status(bot['id']), 'status': 'loading', 'error': ''}
        self._tasks[bot['id']] = asyncio.create_task(self._refresh(dict(bot), fetch, use_cache))
        return self.status(bot['id'])

    async def _refresh(self, bot, fetch, use_cache):
        try:
            cleanup = self._cleanups.get(bot['id'])
            if cleanup:
                await asyncio.shield(cleanup)
            async with self._limit, asyncio.timeout(120):
                cached = await self.work(self._read_cache, bot) if use_cache else None
                if cached is not None:
                    snapshot, updated_at = cached
                else:
                    rows = await fetch()
                    snapshot = await self.work(_index, rows)
                    updated_at = datetime.now(timezone.utc).isoformat()
                    await self.work(self._write_cache, bot, snapshot, updated_at)
            if self._tasks.get(bot['id']) is not asyncio.current_task():
                return
            self._snapshots[bot['id']] = snapshot
            self._states[bot['id']] = {'status':'ready', 'count':len(snapshot[0]),
                'updated_at':updated_at, 'error':''}
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            if self._tasks.get(bot['id']) is asyncio.current_task():
                # Never publish raw HTTP/SDK errors, which can contain credentials.
                message = str(exc) if isinstance(exc, DirectoryError) else '通讯录更新失败，请检查应用权限或网络后重试'
                self._states[bot['id']] = {**self.status(bot['id']), 'status':'error', 'error':message}

    async def wait(self, bot_id):
        task = self._tasks.get(bot_id)
        if task:
            await task

    def _snapshot(self, bot):
        self._check(bot)
        if self._identities.get(bot['id']) != self._identity(bot) or bot['id'] not in self._snapshots:
            raise DirectoryError('directory_not_ready', 'The contact list has not been fully retrieved. Please check or update it in the bot settings.')
        return self._snapshots[bot['id']]

    async def contacts(self, bot, query='', offset=0, limit=50):
        snapshot = self._snapshot(bot)
        def search():
            term = query.strip().casefold()
            rows = [row for row in snapshot[0].values() if not term or term in row['name'].casefold()
                    or term in row['contact_id'].casefold() or any(term in d.casefold() for d in row['departments'])]
            rows.sort(key=lambda row: (row['name'], row['contact_id']))
            return {'contacts': rows[offset:offset+limit], 'total':len(rows), 'offset':offset}
        result = await self.work(search)
        result['contacts'] = [self._recipient(bot['id'], row) for row in result['contacts']]
        return {**result, **self.status(bot['id'])}

    async def resolve(self, bot, *, user_name=None, contact_id=None):
        snapshot = self._snapshot(bot)
        rows = ([snapshot[0][contact_id]] if contact_id in snapshot[0] else []) if contact_id else snapshot[1].get((user_name or '').strip(), [])
        if not rows:
            raise DirectoryError('recipient_not_found', 'Contact not found. Please check the name or manually update the address book')
        if len(rows) != 1:
            raise DirectoryError('ambiguous_recipient', 'Duplicate contact name found. Please select the contact ID by department.', rows[:50])
        recipient = self._recipient(bot['id'], rows[0])
        if not recipient.get('user_id'):
            raise DirectoryError('identity_unverified', 'The bot\'s sender identity for this contact has not been verified. Please use a known user ID')
        return recipient['user_id']

    async def close(self):
        tasks = set(self._tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, *self._retired, return_exceptions=True)
        self._tasks.clear()
        self._snapshots.clear()
        self._observed_senders.clear()
        self._states.clear()
        self._identities.clear()
        self._cleanups.clear()
        await asyncio.to_thread(self._pool.shutdown, wait=True, cancel_futures=True)
