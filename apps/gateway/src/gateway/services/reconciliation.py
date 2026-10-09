"""Periodic enterprise directory reconciliation."""
from gateway.services.errors import GatewayError

import asyncio
import logging


from sqlalchemy import select, update
import json
from datetime import datetime, timezone, timedelta
from gateway.models import PlatformSetting
from gateway.services.directory_schedule import next_run

from gateway.database import GatewayDatabase
from gateway.services.external_identity import ExternalIdentityService
from gateway.models import DirectoryEventReceipt, IdentitySource

logger = logging.getLogger(__name__)


class DirectoryReconciler:
    def __init__(self, database: GatewayDatabase, connectors: dict):
        self.database = database
        self.connectors = connectors
        from gateway.services.directory_sync_jobs import DirectorySyncJobs
        self.jobs = DirectorySyncJobs(database, connectors)

    async def _reconcile_source(self, source: IdentitySource, connector,
                                service: ExternalIdentityService) -> bool:
        async with self.jobs.source_locks[source.id]:
            return await self._apply_source(source, connector, service)

    async def _apply_source(self, source, connector, service):
        try:
            from gateway.services.organization_settings import source_options
            selected = (await source_options(self.database, source.id)).get('selected_department_ids', [])
            if selected == [] or source.id in self.jobs.tasks or self.jobs.closed: return False
            snapshot = await connector.fetch_directory(source, selected_department_ids=selected) if selected is not None else await connector.fetch_directory(source)
        except Exception:
            await service.record_sync_failure(source.id, "provider_unavailable")
            await self._record_failure(source.id, "provider_unavailable")
            raise
        try:
            result = await service.full_sync(source.id, snapshot["departments"], snapshot["people"],
                                    snapshot.get("cursor"), selected_department_ids=snapshot.get("selected_department_ids", selected), snapshot_complete=snapshot.get("complete", False))
            from uuid import uuid4
            await self.jobs._save(source.id, {'id': str(uuid4()), 'status': 'completed', 'trigger': 'automatic', 'started_at': datetime.now(timezone.utc).isoformat(), 'result': result})
            return True
        except Exception as exc:
            await self._record_failure(source.id, 'snapshot_apply_failed')
            await service.record_sync_failure(source.id, 'snapshot_invalid' if isinstance(exc, GatewayError) and exc.reason == 'invalid' else 'snapshot_apply_failed')
            raise

    async def _record_failure(self, source_id, code):
        from uuid import uuid4
        await self.jobs._save(source_id, {'id': str(uuid4()), 'status': 'failed', 'trigger': 'automatic', 'started_at': datetime.now(timezone.utc).isoformat(), 'error_code': code})

    async def run_once(self, *, scheduled=False) -> None:
        async with self.database.session() as session:
            sources = (await session.scalars(select(IdentitySource).where(
                IdentitySource.enabled == 1,
            ))).all()
        service = ExternalIdentityService(self.database)
        for source in sources:
            from gateway.services.organization_settings import source_options
            options = await source_options(self.database, source.id)
            if not options.get('sync_enabled', True): continue
            now = datetime.now(timezone.utc)
            if scheduled:
                due = options.get('next_sync_at')
                if options.get('sync_schedule', {}).get('frequency', 'off') == 'off' or not due or datetime.fromisoformat(due) > now: continue
            connector = self.connectors.get(source.provider)
            if connector is None:
                await service.record_sync_failure(source.id, "connector_unavailable")
                if scheduled:
                    await self._schedule_next(source.id, options["sync_schedule"], now, failed=True)
                continue
            try:
                applied = await self._reconcile_source(source, connector, service)
                if scheduled and applied and 'sync_schedule' in options:
                    await self._schedule_next(source.id, options['sync_schedule'], now)
            except Exception as exc:
                if scheduled and 'sync_schedule' in options:
                    await self._schedule_next(source.id, options['sync_schedule'], now, failed=True)
                logger.error("Directory reconciliation failed for source %s (%s)",
                             source.id, type(exc).__name__)

    async def _schedule_next(self, source_id, policy, now, failed=False):
        from gateway.services.organization_settings import option_key
        async with self.database.session() as session:
            async with session.begin():
                row = await session.get(PlatformSetting, option_key(source_id))
                options = json.loads(row.value_json)
                if options.get('sync_schedule') != policy: return
                upcoming = now + timedelta(minutes=5) if failed else next_run(policy, now)
                options['next_sync_at'] = upcoming.isoformat() if upcoming else None
                row.value_json = json.dumps(options)

    async def run_pending_callbacks(self) -> None:
        async with self.database.session() as session:
            pending = (await session.scalars(select(DirectoryEventReceipt).where(
                DirectoryEventReceipt.status == "pending",
            ).order_by(DirectoryEventReceipt.received_at, DirectoryEventReceipt.id).limit(1000))).all()
            sources = {source.id: source for source in (await session.scalars(select(IdentitySource).where(
                IdentitySource.id.in_({receipt.source_id for receipt in pending}),
            ))).all()}
        by_source: dict[str, list[str]] = {}
        for receipt in pending:
            by_source.setdefault(receipt.source_id, []).append(receipt.id)
        service = ExternalIdentityService(self.database)
        for source_id, receipt_ids in by_source.items():
            source = sources.get(source_id)
            from gateway.services.organization_settings import source_options
            if source:
                options = await source_options(self.database, source.id)
                if not options.get('sync_enabled', True) or options.get('selected_department_ids', []) == []: continue
            connector = self.connectors.get(source.provider) if source and source.enabled else None
            if source and source.enabled and connector is None:
                await service.record_sync_failure(source_id, "connector_unavailable")
                continue
            if connector is not None:
                try:
                    if not await self._reconcile_source(source, connector, service): continue
                except Exception as exc:
                    logger.error("Directory callback reconciliation failed for source %s (%s)",
                                 source_id, type(exc).__name__)
                    continue
            async with self.database.session() as session:
                async with session.begin():
                    await session.execute(update(DirectoryEventReceipt).where(
                        DirectoryEventReceipt.id.in_(receipt_ids),
                        DirectoryEventReceipt.status == "pending",
                    ).values(status="done"))

    async def run_callback_periodic(self, stop: asyncio.Event, wake: asyncio.Event,
                                    *, retry_seconds: float = 60) -> None:
        while not stop.is_set():
            wake.clear()
            try:
                await self.run_pending_callbacks()
            except Exception as exc:
                logger.error("Directory callback queue failed (%s)", type(exc).__name__)
            try:
                await asyncio.wait_for(wake.wait(), timeout=retry_seconds)
            except asyncio.TimeoutError:
                pass

    async def run_periodic(self, stop: asyncio.Event, *, interval_seconds: float) -> None:
        while not stop.is_set():
            try:
                await asyncio.wait_for(stop.wait(), timeout=min(interval_seconds, 60))
            except asyncio.TimeoutError:
                await self.run_once(scheduled=True)
