import asyncio

import pytest
from sqlalchemy import select

from gateway.config import GatewaySettings
from gateway.database import GatewayDatabase
from gateway.external_identity import ExternalIdentityService
from gateway.models import DirectoryPerson
from gateway.reconciliation import DirectoryReconciler


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
