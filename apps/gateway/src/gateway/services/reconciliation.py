"""Periodic enterprise directory reconciliation."""

import asyncio
import logging

from fastapi import HTTPException
from sqlalchemy import select, update

from gateway.database import GatewayDatabase
from gateway.services.external_identity import ExternalIdentityService
from gateway.models import DirectoryEventReceipt, IdentitySource

logger = logging.getLogger(__name__)


class DirectoryReconciler:
    def __init__(self, database: GatewayDatabase, connectors: dict):
        self.database = database
        self.connectors = connectors

    async def _reconcile_source(self, source: IdentitySource, connector,
                                service: ExternalIdentityService) -> None:
        try:
            snapshot = await connector.fetch_directory(source)
        except Exception:
            await service.record_sync_failure(source.id, "provider_unavailable")
            raise
        try:
            await service.full_sync(source.id, snapshot["departments"], snapshot["people"],
                                    snapshot.get("cursor"))
        except Exception as exc:
            await service.record_sync_failure(source.id,
                                              "snapshot_invalid" if isinstance(exc, HTTPException)
                                              and exc.status_code == 422 else "snapshot_apply_failed")
            raise

    async def run_once(self) -> None:
        async with self.database.session() as session:
            sources = (await session.scalars(select(IdentitySource).where(
                IdentitySource.enabled == 1,
            ))).all()
        service = ExternalIdentityService(self.database)
        for source in sources:
            connector = self.connectors.get(source.provider)
            if connector is None:
                await service.record_sync_failure(source.id, "connector_unavailable")
                continue
            try:
                await self._reconcile_source(source, connector, service)
            except Exception as exc:
                logger.error("Directory reconciliation failed for source %s (%s)",
                             source.id, type(exc).__name__)

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
            connector = self.connectors.get(source.provider) if source and source.enabled else None
            if source and source.enabled and connector is None:
                await service.record_sync_failure(source_id, "connector_unavailable")
                continue
            if connector is not None:
                try:
                    await self._reconcile_source(source, connector, service)
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
                await asyncio.wait_for(stop.wait(), timeout=interval_seconds)
            except asyncio.TimeoutError:
                await self.run_once()
