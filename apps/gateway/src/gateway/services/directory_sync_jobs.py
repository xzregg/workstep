"""Selected directory imports with durable progress and owned background tasks."""
import asyncio
from collections import defaultdict
import json
from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import select
from gateway.models import PlatformSetting
from gateway.services.errors import GatewayError
from gateway.services.external_identity import ExternalIdentityService

ACTIVE = {'queued', 'fetching', 'applying'}


class DirectorySyncJobs:
    def __init__(self, database, connectors):
        self.database, self.connectors = database, connectors
        self.tasks = {}
        self.lock = asyncio.Lock()
        self.source_locks = defaultdict(asyncio.Lock)
        self.closed = False

    async def latest(self, source_id):
        async with self.database.session() as session:
            row = await session.get(PlatformSetting, 'directory-job:' + source_id)
            job = json.loads(row.value_json) if row else {'status': 'idle'}
            job.pop('snapshot', None)
            return job

    async def _save(self, source_id, job):
        async with self.database.session() as session:
            async with session.begin():
                row = await session.get(PlatformSetting, 'directory-job:' + source_id)
                if row:
                    previous = json.loads(row.value_json)
                    if job.get('trigger') != 'automatic' or previous.get('status') != 'preview':
                        row.value_json = json.dumps(job)
                else: session.add(PlatformSetting(key='directory-job:' + source_id, value_json=json.dumps(job)))
                if job['status'] in ('completed', 'failed'):
                    history_key = 'directory-history:' + source_id
                    history_row = await session.get(PlatformSetting, history_key)
                    history = json.loads(history_row.value_json) if history_row else []
                    history = [item for item in history if item['id'] != job['id']]
                    history.insert(0, {key: value for key, value in job.items() if key != 'snapshot'})
                    if history_row: history_row.value_json = json.dumps(history[:30])
                    else: session.add(PlatformSetting(key=history_key, value_json=json.dumps(history[:30])))

    async def recover(self):
        async with self.database.session() as session:
            async with session.begin():
                rows = (await session.scalars(select(PlatformSetting).where(PlatformSetting.key.like('directory-job:%')))).all()
                for row in rows:
                    job = json.loads(row.value_json)
                    if job['status'] in ACTIVE:
                        job.update(status='failed', error_code='interrupted')
                        row.value_json = json.dumps(job)

    async def start(self, source_id, selected, *, preview=False):
        async with self.lock:
            if self.closed: raise GatewayError('unavailable', 'Directory sync shutting down')
            if source_id in self.tasks and not self.tasks[source_id].done():
                raise GatewayError('conflict', 'Directory sync already running')
            source = await ExternalIdentityService(self.database).source(source_id, purpose='sync')
            if source.provider not in self.connectors:
                raise GatewayError('unavailable', 'Identity connector unavailable')
            job = {'id': str(uuid4()), 'status': 'queued', 'department_ids': list(dict.fromkeys(selected)),
                   'completed': 0, 'total': len(set(selected)), 'current_department': None,
                   'preview_requested': preview, 'started_at': datetime.now(timezone.utc).isoformat(), 'error_code': None, 'result': None}
            await self._save(source_id, job)
            self.tasks[source_id] = asyncio.create_task(self._run(source, job))
            return job.copy()

    async def _run(self, source, job):
        async with self.source_locks[source.id]:
            await self._execute(source, job)

    async def _execute(self, source, job):
        async def progress(stage, completed, total, current):
            job.update(status=stage, completed=completed, total=total, current_department=current)
            await self._save(source.id, job)
        service = ExternalIdentityService(self.database)
        try:
            await progress('fetching', 0, job['total'], None)
            snapshot = job.pop('snapshot', None)
            if snapshot is None:
                snapshot = await self.connectors[source.provider].fetch_directory(
                    source, selected_department_ids=job['department_ids'], progress=progress,
                )
            job['department_ids'] = snapshot.get('selected_department_ids', job['department_ids'])
            await progress('applying', job['total'], job['total'], None)
            result = await service.full_sync(source.id, snapshot['departments'], snapshot['people'],
                snapshot.get('cursor'), selected_department_ids=job['department_ids'], snapshot_complete=snapshot.get("complete", False), dry_run=job.get("preview_requested", False), excluded_subjects=job.get("excluded_subjects"))
            job.update(status='preview' if job.get('preview_requested') else 'completed', result=result, completed=job['total'])
            if job.get('preview_requested'): job['snapshot'] = snapshot
            await self._save(source.id, job)
        except asyncio.CancelledError:
            job.update(status='failed', error_code='interrupted')
            await self._save(source.id, job)
            raise
        except Exception:
            job.update(status='failed', error_code='sync_failed')
            await service.record_sync_failure(source.id, 'selected_sync_failed')
            await self._save(source.id, job)
        finally:
            self.tasks.pop(source.id, None)

    async def confirm(self, source_id, job_id, selected_subjects=None):
        async with self.lock:
            if self.closed: raise GatewayError('unavailable', 'Directory sync shutting down')
            if source_id in self.tasks:
                raise GatewayError('conflict', 'Directory sync already running')
            async with self.database.session() as session:
                row = await session.get(PlatformSetting, 'directory-job:' + source_id)
                job = json.loads(row.value_json) if row else {}
            if job.get('status') != 'preview' or job.get('id') != job_id:
                raise GatewayError('conflict', 'Directory preview expired')
            if (datetime.now(timezone.utc) - datetime.fromisoformat(job['started_at'])).total_seconds() > 900:
                raise GatewayError('conflict', 'Directory preview expired')
            if selected_subjects is not None:
                candidates = job.get('result', {}).get('user_candidates', [])
                available = {row['subject'] for row in candidates if not row.get('skipped')}
                if not set(selected_subjects) <= available:
                    raise GatewayError('invalid', 'User selection is outside the preview')
                job['excluded_subjects'] = sorted(available - set(selected_subjects))
            source = await ExternalIdentityService(self.database).source(source_id, purpose='sync')
            job.update(status='queued', preview_requested=False)
            await self._save(source_id, job)
            self.tasks[source_id] = asyncio.create_task(self._run(source, job))
            return {key: value for key, value in job.items() if key != 'snapshot'}

    async def close(self):
        self.closed = True
        tasks = list(self.tasks.values())
        for task in tasks: task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self.tasks.clear()
