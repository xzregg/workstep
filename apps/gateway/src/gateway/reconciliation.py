"""Periodic enterprise directory reconciliation."""

import asyncio
import logging

from sqlalchemy import select

from .database import GatewayDatabase
from .external_identity import ExternalIdentityService
from .models import IdentitySource

logger = logging.getLogger(__name__)


class DirectoryReconciler:
    def __init__(self, database: GatewayDatabase, connectors: dict):
        self.database = database
        self.connectors = connectors

    async def run_once(self) -> None:
        async with self.database.session() as session:
            sources = (await session.scalars(select(IdentitySource).where(
                IdentitySource.enabled == 1,
            ))).all()
        service = ExternalIdentityService(self.database)
        for source in sources:
            connector = self.connectors.get(source.provider)
            if connector is None:
                continue
            try:
                snapshot = await connector.fetch_directory(source)
                await service.full_sync(source.id, snapshot["departments"], snapshot["people"])
            except Exception as exc:
                logger.error("Directory reconciliation failed for source %s (%s)",
                             source.id, type(exc).__name__)

    async def run_periodic(self, stop: asyncio.Event, *, interval_seconds: float) -> None:
        while not stop.is_set():
            try:
                await asyncio.wait_for(stop.wait(), timeout=interval_seconds)
            except asyncio.TimeoutError:
                await self.run_once()
