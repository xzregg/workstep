"""Selected directory imports with durable progress and owned background tasks."""
import asyncio
from collections import defaultdict
import json
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from sqlalchemy import select
from gateway.models import DirectoryDepartment, PlatformSetting
from gateway.services.errors import GatewayError
from gateway.services.external_identity import ExternalIdentityService
from gateway.services.directory_preview_cache import DirectoryPreviewCache
from gateway.services.directory_maintenance import MaintenancePolicy, apply_maintenance, descendants

ACTIVE = {'queued', 'fetching', 'applying'}


class DirectorySyncJobs:
    def __init__(self, database, connectors):
        self.database, self.connectors = database, connectors
        self.tasks = {}
        self.lock = asyncio.Lock()
        self.source_locks = defaultdict(asyncio.Lock)
        self.closed = False
        self.preview_cache = DirectoryPreviewCache(database, connectors)

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

    async def start(self, source_id, selected, *, preview=False, refresh=False, selection=None, full_directory=False):
        async with self.lock:
            if self.closed: raise GatewayError('unavailable', 'Directory sync shutting down')
            if source_id in self.tasks and not self.tasks[source_id].done():
                raise GatewayError('conflict', 'Directory sync already running')
            source = await ExternalIdentityService(self.database).source(source_id, purpose='sync')
            if source.provider not in self.connectors:
                raise GatewayError('unavailable', 'Identity connector unavailable')
            known=set()
            if full_directory:
                async with self.database.session() as session:
                    known=set((await session.scalars(select(DirectoryDepartment.external_id).where(DirectoryDepartment.source_id==source_id))).all())
            if selection is not None and not set(selection) <= set(selected)|known:
                raise GatewayError('invalid', 'Organization selection is outside the preview')
            job = {'id': str(uuid4()), 'status': 'queued', 'department_ids': list(dict.fromkeys(selected)),
                   'completed': 0, 'total': len(set(selected)), 'current_department': None,
                   'preview_requested': preview, 'refresh_requested': refresh, 'started_at': datetime.now(timezone.utc).isoformat(), 'error_code': None, 'result': None}
            job['selection_department_ids'] = list(dict.fromkeys(selection if selection is not None else selected))
            job['full_directory'] = full_directory
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
                if job.get('preview_requested'):
                    snapshot, remaining = await self.preview_cache.fetch(source, job['department_ids'], progress,
                        refresh=job.get('refresh_requested', False),full_directory=job.get('full_directory',False))
                    job['cache_expires_at'] = (datetime.now(timezone.utc) + timedelta(seconds=remaining)).isoformat()
                else:
                    snapshot = await self.connectors[source.provider].fetch_directory(
                        source, selected_department_ids=job['department_ids'], progress=progress,
                    )
            job['department_ids'] = snapshot.get('selected_department_ids', job['department_ids'])
            await progress('applying', job['total'], job['total'], None)
            if job.get('maintenance_policy') and not job.get('preview_requested'):
                result=await apply_maintenance(service,source.id,snapshot,job['maintenance_policy'],
                    restore_subjects=job.get('restore_subjects'),restore_departments=True,persist=True,groups_only=job.get('groups_only',False))
            else:
                preview_exclusions=job.get('excluded_subjects')
                if job.get('full_directory') and job.get('preview_requested'):
                    from gateway.services.organization_settings import source_options
                    options=await source_options(self.database,source.id)
                    if options.get('maintenance_policy'):
                        preview_exclusions=options['maintenance_policy'].get('excluded_subjects',[])
                result = await service.full_sync(source.id, snapshot['departments'], snapshot['people'],
                    snapshot.get('cursor'), selected_department_ids=None if job.get('full_directory') else job['department_ids'],
                    snapshot_complete=bool(snapshot.get('complete',False) and (snapshot.get('whole_company',True) if job.get('full_directory') else True)),
                    dry_run=job.get("preview_requested", False), excluded_subjects=preview_exclusions, restore_subjects=job.get('restore_subjects'), restore_department_ids=job.get('restore_department_ids'), selection_department_ids=job.get('selection_department_ids'))
            job.update(status='preview' if job.get('preview_requested') else 'completed', result=result, completed=job['total'])
            if job.get('preview_requested'):
                job['snapshot'] = snapshot
                if job.get('full_directory'):
                    async with self.database.session() as session:
                        local=(await session.scalars(select(DirectoryDepartment).where(DirectoryDepartment.source_id==source.id))).all()
                        known=[row.external_id for row in local]
                    job['department_ids']=list(dict.fromkeys([*job['department_ids'],*known]))
                    present={row['external_id'] for row in snapshot['departments']}
                    job['departments']=[*snapshot['departments'],*[{'external_id':row.external_id,
                        'display_name':row.display_name,'parent_external_id':row.parent_external_id,'local_only':True,
                        'source_status':'deleted' if snapshot.get('complete') and snapshot.get('whole_company',True) else 'unverified'}
                        for row in local if row.external_id not in present]]
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

    async def confirm(self, source_id, job_id, selected_subjects=None, *, department_ids=None, maintenance_policy=None,groups_only=False):
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
                selected_set=set(selected_subjects)
                candidates = job.get('result', {}).get('user_candidates', [])
                available = {row['subject'] for row in candidates}
                if not set(selected_subjects) <= available:
                    raise GatewayError('invalid', 'User selection is outside the preview')
                job['excluded_subjects'] = sorted(available - set(selected_subjects))
                job['restore_subjects'] = sorted(set(selected_subjects) & {row['subject'] for row in candidates if row.get('skipped')})
            if maintenance_policy is not None:
                if not job.get('full_directory'):
                    raise GatewayError('invalid','Read the full directory before saving a maintenance range')
                policy=MaintenancePolicy.model_validate(maintenance_policy)
                if selected_subjects is None:
                    raise GatewayError('invalid','Explicit user selection required')
                if not set(policy.department_ids) <= set(job['department_ids']):
                    raise GatewayError('invalid','Organization selection is outside the preview')
                if policy.mode=='users' and set(policy.subjects)!=set(selected_subjects):
                    raise GatewayError('invalid','User maintenance range does not match the checked selection')
                if policy.mode=='departments':
                    scope=descendants(job.get('departments',job['snapshot']['departments']),policy.department_ids)
                    scoped={row['subject'] for row in candidates if scope.intersection(row['department_ids'])}
                    if not set(selected_subjects) <= scoped:
                        raise GatewayError('invalid','Checked users are outside the maintained departments')
                if groups_only and (selected_subjects or policy.mode=='users'):
                    raise GatewayError('invalid','Organization-only sync requires an organization range and no checked users')
                if not groups_only:
                    policy.excluded_subjects=sorted(available-set(selected_subjects)) if policy.mode!='users' else []
                job['maintenance_policy']=policy.model_dump()
                job['groups_only']=groups_only
            if department_ids is not None and maintenance_policy is None:
                covered = set(job['department_ids'])
                if not set(department_ids) <= covered:
                    raise GatewayError('invalid', 'Organization selection is outside the preview')
                scope = set(department_ids)
                if selected_subjects is not None:
                    scope.update(id for row in candidates if row['subject'] in selected_set for id in row['department_ids'] if id in covered)
                snapshot = job['snapshot']
                job['selection_department_ids'] = [id for id in job['department_ids'] if id in scope]
                parents = {row['external_id']:row.get('parent_external_id') for row in snapshot['departments']}
                pending = list(scope)
                while pending:
                    parent = parents.get(pending.pop())
                    if parent in covered and parent not in scope:
                        scope.add(parent); pending.append(parent)
                job['department_ids'] = [id for id in job['department_ids'] if id in scope]
                job['total'] = len(job['department_ids'])
                job['snapshot'] = {**snapshot, 'selected_department_ids':job['department_ids'],
                    'departments':[row for row in snapshot['departments'] if row['external_id'] in scope],
                    'people':[{**row, 'department_ids':[id for id in row['department_ids'] if id in scope]}
                              for row in snapshot['people'] if scope.intersection(row['department_ids'])]}
            source = await ExternalIdentityService(self.database).source(source_id, purpose='sync')
            job['restore_department_ids'] = job['department_ids']
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
