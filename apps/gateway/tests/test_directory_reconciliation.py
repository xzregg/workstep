import asyncio

import pytest
from sqlalchemy import select

from gateway.config import GatewaySettings
from gateway.database import GatewayDatabase
from gateway.services.external_identity import ExternalIdentityService
from gateway.models import DirectoryEventReceipt, DirectoryPerson, DirectorySyncState
from gateway.services.reconciliation import DirectoryReconciler


@pytest.mark.asyncio
async def test_scheduled_reconciliation_reads_enabled_source(tmp_path):
    database = GatewayDatabase(GatewaySettings(data_dir=tmp_path))
    await database.start()
    try:
        service = ExternalIdentityService(database)
        source = await service.create_source("wecom", "corp-a", "app", "SECRET_ENV", "1001")
        called = asyncio.Event()

        class Connector:
            async def fetch_directory(self, current):
                assert current.id == source.id
                called.set()
                return {"departments": [], "people": [{
                    "subject": "employee-1", "display_name": "张三", "department_ids": [],
                }]}

        reconciler = DirectoryReconciler(database, {"wecom": Connector()})
        stop = asyncio.Event()
        task = asyncio.create_task(reconciler.run_periodic(stop, interval_seconds=0.01))
        try:
            await asyncio.wait_for(called.wait(), timeout=1)
            for _ in range(20):
                async with database.session() as session:
                    person = await session.scalar(select(DirectoryPerson).where(
                        DirectoryPerson.source_id == source.id,
                    ))
                if person:
                    break
                await asyncio.sleep(0.01)
            assert person.subject == "employee-1"
        finally:
            stop.set()
            await asyncio.wait_for(task, timeout=1)
    finally:
        await database.close()


@pytest.mark.asyncio
async def test_failed_periodic_reconciliation_records_safe_error(tmp_path):
    database = GatewayDatabase(GatewaySettings(data_dir=tmp_path))
    await database.start()
    try:
        service = ExternalIdentityService(database)
        source = await service.create_source("wecom", "corp-a", "app", "SECRET_ENV", "1001")

        class BrokenConnector:
            async def fetch_directory(self, _source):
                raise RuntimeError("private vendor detail")

        await DirectoryReconciler(database, {"wecom": BrokenConnector()}).run_once()
        async with database.session() as session:
            state = await session.get(DirectorySyncState, source.id)
            assert state.last_attempt_at is not None
            assert state.last_success_at is None
            assert state.last_error_code == "provider_unavailable"
            assert "private vendor detail" not in str(state)
    finally:
        await database.close()


@pytest.mark.asyncio
async def test_failed_callback_reconciliation_keeps_receipt_pending_and_records_error(tmp_path):
    database = GatewayDatabase(GatewaySettings(data_dir=tmp_path))
    await database.start()
    try:
        service = ExternalIdentityService(database)
        source = await service.create_source("wecom", "corp-a", "app", "SECRET_ENV", "1001")
        async with database.session() as session:
            async with session.begin():
                session.add(DirectoryEventReceipt(id="receipt-1", source_id=source.id,
                                                  event_id="event-1", status="pending"))

        class BrokenConnector:
            async def fetch_directory(self, _source):
                raise RuntimeError("private vendor detail")

        await DirectoryReconciler(database, {"wecom": BrokenConnector()}).run_pending_callbacks()
        async with database.session() as session:
            receipt = await session.get(DirectoryEventReceipt, "receipt-1")
            state = await session.get(DirectorySyncState, source.id)
            assert receipt.status == "pending"
            assert state.last_error_code == "provider_unavailable"
    finally:
        await database.close()
