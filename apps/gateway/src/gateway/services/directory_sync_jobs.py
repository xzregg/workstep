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
            return json.loads(row.value_json) if row else {'status': 'idle'}

    async def _save(self, source_id, job):
        async with self.database.session() as session:
            async with session.begin():
                row = await session.get(PlatformSetting, 'directory-job:' + source_id)
                if row: row.value_json = json.dumps(job)
                else: session.add(PlatformSetting(key='directory-job:' + source_id, value_json=json.dumps(job)))

    async def recover(self):
        async with self.database.session() as session:
            async with session.begin():
                rows = (await session.scalars(select(PlatformSetting).where(PlatformSetting.key.like('directory-job:%')))).all()
                for row in rows:
                    job = json.loads(row.value_json)
                    if job['status'] in ACTIVE:
                        job.update(status='failed', error_code='interrupted')
                        row.value_json = json.dumps(job)

    async def start(self, source_id, selected):
        async with self.lock:
            if source_id in self.tasks and not self.tasks[source_id].done():
                raise GatewayError('conflict', 'Directory sync already running')
            source = await ExternalIdentityService(self.database).source(source_id, purpose='sync')
            if source.provider not in self.connectors:
                raise GatewayError('unavailable', 'Identity connector unavailable')
            job = {'id': str(uuid4()), 'status': 'queued', 'department_ids': list(dict.fromkeys(selected)),
                   'completed': 0, 'total': len(set(selected)), 'current_department': None,
                   'started_at': datetime.now(timezone.utc).isoformat(), 'error_code': None, 'result': None}
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
            snapshot = await self.connectors[source.provider].fetch_directory(
                source, selected_department_ids=job['department_ids'], progress=progress,
            )
            await progress('applying', job['total'], job['total'], None)
            result = await service.full_sync(source.id, snapshot['departments'], snapshot['people'],
                snapshot.get('cursor'), selected_department_ids=job['department_ids'])
            job.update(status='completed', result=result, completed=job['total'])
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

    async def close(self):
        self.closed = True
        tasks = list(self.tasks.values())
        for task in tasks: task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self.tasks.clear()
