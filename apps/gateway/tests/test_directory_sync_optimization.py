import pytest
from sqlalchemy import select
from gateway.config import GatewaySettings
from gateway.database import GatewayDatabase
from gateway.models import DirectoryPerson, User, AuthSession
from gateway.services.external_identity import ExternalIdentityService
from gateway.services.identity import IdentityService


@pytest.mark.asyncio
async def test_status_reconciliation_preserves_manual_disable_and_revokes_sessions(tmp_path):
    database = GatewayDatabase(GatewaySettings(data_dir=tmp_path))
    await database.start()
    try:
        service = ExternalIdentityService(database)
        source = await service.create_source('wecom', 'corp', 'app', 'SECRET')
        departments = [{'external_id': '2', 'display_name': '研发'}]
        people = [{'subject': name, 'display_name': name, 'department_ids': ['2']} for name in ['leaver', 'manual', 'missing']]
        await service.full_sync(source.id, departments, people)
        async with database.session() as session:
            async with session.begin():
                rows = {row.subject: row for row in (await session.scalars(select(DirectoryPerson))).all()}
                user = await session.get(User, rows['manual'].user_id)
                user.status = 'disabled'
                auth, token = IdentityService._create_session(rows['leaver'].user_id)
                session.add(auth)
        people[0]['active'] = False
        result = await service.full_sync(source.id, departments, people[:2], snapshot_complete=False)
        assert result['people_departed'] == 1
        assert result['people_unverified'] == 1
        async with database.session() as session:
            assert (await session.get(AuthSession, auth.id)).revoked_at is not None
            assert (await session.get(User, rows['manual'].user_id)).status == 'disabled'
            assert (await session.get(DirectoryPerson, rows['missing'].id)).active == 1
        people[0]['active'] = True
        result = await service.full_sync(source.id, departments, people)
        assert result['people_restoration_pending'] == 2
        async with database.session() as session:
            assert (await session.get(User, rows['leaver'].user_id)).status == 'disabled'
    finally:
        await database.close()


def test_schedule_daily_weekly_and_disabled():
    from datetime import datetime, timezone
    from gateway.services.directory_schedule import next_run
    now = datetime(2026, 10, 9, 0, 0, tzinfo=timezone.utc)
    assert next_run({'frequency': 'off'}, now) is None
    assert next_run({'frequency': 'daily', 'time': '09:00', 'timezone': 'Asia/Shanghai'}, now).isoformat() == '2026-10-09T01:00:00+00:00'
    assert next_run({'frequency': 'weekly', 'time': '09:00', 'timezone': 'Asia/Shanghai', 'weekday': 0}, now).isoformat() == '2026-10-12T01:00:00+00:00'


@pytest.mark.asyncio
async def test_scheduled_sources_run_only_when_due_and_retry_failure(tmp_path):
    from gateway.services.reconciliation import DirectoryReconciler
    from gateway.services.organization_settings import source_options
    import asyncio
    database = GatewayDatabase(GatewaySettings(data_dir=tmp_path))
    await database.start()
    try:
        service = ExternalIdentityService(database)
        source = await service.create_source('wecom', 'corp', 'app', 'SECRET', options={
            'selected_department_ids': ['2'], 'sync_schedule': {'frequency':'daily'}, 'next_sync_at':'2020-01-01T00:00:00+00:00'})
        called = []
        class Connector:
            failed = True
            async def fetch_directory(self, current, **kwargs):
                called.append(current.id)
                await asyncio.sleep(.05)
                if self.failed: raise ValueError('private details')
                return {'departments':[{'external_id':'2','display_name':'研发'}], 'people':[], 'complete':True}
        connector = Connector()
        reconciler = DirectoryReconciler(database, {'wecom':connector})
        await reconciler.run_once(scheduled=True)
        assert len(called) == 1
        options = await source_options(database, source.id)
        assert options['next_sync_at'] > '2020-01-01'
        await reconciler.run_once(scheduled=True)
        assert len(called) == 1
        connector.failed = False
        await reconciler.run_once()
        assert (await reconciler.jobs.latest(source.id))['status'] == 'completed'
    finally:
        await database.close()


@pytest.mark.asyncio
async def test_deleted_department_disables_its_group_without_losing_local_roles(tmp_path):
    from gateway.models import UserGroup, GroupMembership
    database=GatewayDatabase(GatewaySettings(data_dir=tmp_path))
    await database.start()
    try:
        service=ExternalIdentityService(database)
        source=await service.create_source('wecom','corp','app','SECRET')
        departments=[{'external_id':'1','display_name':'公司'},{'external_id':'2','display_name':'研发'}]
        await service.full_sync(source.id,departments,[{'subject':'employee','display_name':'员工','department_ids':['2']}])
        async with database.session() as session:
            async with session.begin():
                group=await session.scalar(select(UserGroup).where(UserGroup.name=='研发'))
                membership=await session.scalar(select(GroupMembership).where(GroupMembership.group_id==group.id))
                membership.role='manager';membership.source='local'
        result=await service.full_sync(source.id,departments[:1],[],selected_department_ids=['1','2'])
        assert result['departments_deleted']==1
        async with database.session() as session:
            assert (await session.get(UserGroup,group.id)).status=='disabled'
            assert (await session.get(GroupMembership,membership.id)).role=='manager'
    finally:
        await database.close()
