import asyncio
import os
import sqlite3
import threading
from time import monotonic

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import insert, select
from sqlalchemy.exc import IntegrityError
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext

from gateway.app import create_app
from gateway.config import GatewaySettings
from gateway.database import GatewayDatabase, current_revision, migration_config, safe_database_location
from gateway.models import Base, PlatformSetting, User


@pytest.mark.asyncio
async def test_sqlite_cold_start_and_repeat_migration(tmp_path):
    settings = GatewaySettings(data_dir=tmp_path)
    first = GatewayDatabase(settings)
    await first.start()
    assert await current_revision(first.engine) == first.head_revision
    await first.close()

    second = GatewayDatabase(settings)
    await second.start()
    assert await current_revision(second.engine) == second.head_revision
    await second.close()


@pytest.mark.asyncio
async def test_migration_schema_matches_models(tmp_path):
    database = GatewayDatabase(GatewaySettings(data_dir=tmp_path))
    await database.start()
    try:
        def compare(connection):
            return compare_metadata(MigrationContext.configure(connection), Base.metadata)

        async with database.engine.connect() as connection:
            differences = await connection.run_sync(compare)
        assert differences == []
    finally:
        await database.close()


def test_database_location_redacts_credentials_and_query():
    backend, location = safe_database_location(
        "postgresql+asyncpg://private-user:secret@db.example.com:5432/workstep?sslmode=require"
    )
    assert backend == "postgresql"
    assert location == "db.example.com:5432/workstep"
    assert "secret" not in location


@pytest.mark.asyncio
async def test_internal_database_status_contains_only_safe_fields(tmp_path):
    database = GatewayDatabase(GatewaySettings(data_dir=tmp_path))
    await database.start()
    try:
        assert await database.status() == {
            "backend": "sqlite", "location": "workstep_platform.db",
            "healthy": True, "migration_version": database.head_revision,
        }
    finally:
        await database.close()


@pytest.mark.asyncio
async def test_existing_database_upgrades_from_identity_revision(tmp_path):
    from alembic import command

    settings = GatewaySettings(data_dir=tmp_path)
    await asyncio.to_thread(command.upgrade, migration_config(settings.effective_database_url), "0001_identity")
    database = GatewayDatabase(settings)
    await database.start()
    try:
        assert await current_revision(database.engine) == database.head_revision
    finally:
        await database.close()


@pytest.mark.asyncio
async def test_skill_source_migration_preserves_assignments(tmp_path):
    from alembic import command

    settings = GatewaySettings(data_dir=tmp_path)
    database = GatewayDatabase(settings)
    await database.start()
    await database.close()
    await asyncio.to_thread(command.downgrade,
                            migration_config(settings.effective_database_url),
                            "0031_usage_rollups")
    path = tmp_path / "workstep_platform.db"
    with sqlite3.connect(path) as connection:
        connection.execute(
            "INSERT INTO project_skill_assignments "
            "(id,platform_project_id,skill_id,skill_version_id,source_group_id,"
            "assigned_by_user_id,desired_revision,status) VALUES (?,?,?,?,?,?,?,?)",
            ("assignment-a", "project-1", "skill-1", "version-1", "group-a",
             "owner-1", 1, "active"),
        )
    await database.start()
    await database.close()
    with sqlite3.connect(path) as connection:
        original = connection.execute(
            "SELECT id,source_group_id FROM project_skill_assignments"
        ).fetchall()
        assert original == [("assignment-a", "group-a")]
        connection.execute(
            "INSERT INTO project_skill_assignments "
            "(id,platform_project_id,skill_id,skill_version_id,source_group_id,"
            "assigned_by_user_id,desired_revision,status) VALUES (?,?,?,?,?,?,?,?)",
            ("assignment-b", "project-1", "skill-1", "version-1", "group-b",
             "owner-1", 2, "active"),
        )
        assert connection.execute(
            "SELECT COUNT(*) FROM project_skill_assignments"
        ).fetchone() == (2,)


@pytest.mark.asyncio
async def test_second_sqlite_gateway_instance_is_rejected(tmp_path):
    settings = GatewaySettings(data_dir=tmp_path)
    first = GatewayDatabase(settings)
    second = GatewayDatabase(settings)
    await first.start()
    try:
        with pytest.raises(RuntimeError, match="already running"):
            await second.start()
    finally:
        await first.close()
    await second.start()
    await second.close()


@pytest.mark.asyncio
async def test_sqlite_online_backup_is_restorable(tmp_path):
    database = GatewayDatabase(GatewaySettings(data_dir=tmp_path))
    await database.start()
    try:
        await database.write_setting("registration_mode", '"closed"')
        backup = tmp_path / "backup.db"
        await database.backup_sqlite(backup)
        with sqlite3.connect(backup) as connection:
            assert connection.execute("SELECT value_json FROM platform_settings WHERE key='registration_mode'").fetchone() == ('"closed"',)
            assert connection.execute("SELECT version_num FROM alembic_version").fetchone() == (database.head_revision,)
    finally:
        await database.close()


@pytest.mark.asyncio
async def test_backup_does_not_create_an_empty_database_when_source_is_missing(tmp_path):
    database = GatewayDatabase(GatewaySettings(data_dir=tmp_path))
    with pytest.raises(FileNotFoundError):
        await database.backup_sqlite(tmp_path / "backup.db")
    assert not (tmp_path / "backup.db").exists()
    assert not (tmp_path / "workstep_platform.db").exists()


@pytest.mark.asyncio
async def test_unknown_database_revision_fails_without_fallback(tmp_path):
    settings = GatewaySettings(data_dir=tmp_path)
    database = GatewayDatabase(settings)
    await database.start()
    await database.close()
    with sqlite3.connect(tmp_path / "workstep_platform.db") as connection:
        connection.execute("UPDATE alembic_version SET version_num='future_unknown'")
    with pytest.raises(Exception):
        await GatewayDatabase(settings).start()
    with sqlite3.connect(tmp_path / "workstep_platform.db") as connection:
        assert connection.execute("SELECT version_num FROM alembic_version").fetchone() == ("future_unknown",)


@pytest.mark.asyncio
async def test_transaction_rollback_and_unique_username(tmp_path):
    database = GatewayDatabase(GatewaySettings(data_dir=tmp_path))
    await database.start()
    try:
        with pytest.raises(RuntimeError):
            async with database.session() as session:
                async with session.begin():
                    await session.execute(insert(PlatformSetting).values(key="registration_mode", value_json='"open"'))
                    raise RuntimeError("abort")
        async with database.session() as session:
            assert (await session.scalars(select(PlatformSetting))).all() == []
        async with database.session() as session:
            async with session.begin():
                await session.execute(insert(User).values(id="u1", username="alice", display_name="Alice", status="active"))
            with pytest.raises(IntegrityError):
                async with session.begin():
                    await session.execute(insert(User).values(id="u2", username="alice", display_name="Second", status="active"))
    finally:
        await database.close()


@pytest.mark.asyncio
async def test_health_remains_responsive_during_sqlite_lock(tmp_path):
    settings = GatewaySettings(data_dir=tmp_path)
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        database = app.state.database
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://gateway") as client:
            async with database.engine.connect() as lock_connection:
                await lock_connection.exec_driver_sql("BEGIN IMMEDIATE")
                blocked = asyncio.create_task(database.write_setting("locked", '"value"'))
                await asyncio.sleep(0.05)
                assert not blocked.done()
                started = monotonic()
                response = await client.get("/api/health")
                elapsed = monotonic() - started
                await lock_connection.rollback()
                await blocked
        assert response.status_code == 200
        assert elapsed < 0.3


@pytest.mark.asyncio
async def test_health_remains_responsive_during_slow_backup(tmp_path, monkeypatch):
    import gateway.database as database_module

    entered = threading.Event()
    release = threading.Event()
    original_backup = database_module._backup_sqlite

    def slow_backup(source, destination):
        entered.set()
        release.wait(timeout=2)
        original_backup(source, destination)

    monkeypatch.setattr(database_module, "_backup_sqlite", slow_backup)
    app = create_app(GatewaySettings(data_dir=tmp_path))
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://gateway") as client:
            backup_task = asyncio.create_task(app.state.database.backup_sqlite(tmp_path / "slow-backup.db"))
            try:
                assert await asyncio.to_thread(entered.wait, 1)
                started = monotonic()
                response = await client.get("/api/health")
                assert response.status_code == 200
                assert monotonic() - started < 0.3
            finally:
                release.set()
                await backup_task


@pytest.mark.asyncio
async def test_postgres_migration_and_core_transaction(tmp_path):
    url = os.environ.get("WORKSTEP_TEST_POSTGRES_URL")
    if not url:
        pytest.skip("PostgreSQL integration URL not configured")
    settings = GatewaySettings(data_dir=tmp_path, database_url=url)
    database = GatewayDatabase(settings)
    await database.start()
    try:
        assert await current_revision(database.engine) == database.head_revision
        second = GatewayDatabase(settings)
        with pytest.raises(RuntimeError, match="already running"):
            await second.start()
        async with database.session() as session:
            async with session.begin():
                await session.execute(insert(User).values(id="postgres-u1", username="postgres-alice", display_name="Alice", status="active"))
        async with database.session() as session:
            assert (await session.scalar(select(User.id).where(User.username == "postgres-alice"))) == "postgres-u1"
    finally:
        await database.close()


@pytest.mark.asyncio
async def test_device_scope_upgrade_preserves_existing_device_and_project_grants(tmp_path):
    from alembic import command
    settings = GatewaySettings(data_dir=tmp_path)
    await asyncio.to_thread(command.upgrade, migration_config(settings.effective_database_url), '0034_platform_shares')
    path = tmp_path / 'workstep_platform.db'
    def seed():
        with sqlite3.connect(path) as db:
            db.execute("INSERT INTO devices(id,name,public_key,status) VALUES('device-existing','Existing PC','key','active')")
            db.execute("INSERT INTO platform_projects(id,device_id,host_project_id,name,status,access_mode) VALUES('project-existing','device-existing','host-id','Existing project','active','remote_published')")
            db.execute("INSERT INTO project_access_grants(id,project_id,subject_type,subject_id,access_level,assigned_by_user_id) VALUES('grant-existing','project-existing','user','user-existing','read','owner')")
    await asyncio.to_thread(seed)
    database = GatewayDatabase(settings)
    await database.start()
    await database.close()
    def verify():
        with sqlite3.connect(path) as db:
            assert db.execute('SELECT id,name,department_id FROM devices').fetchall() == [('device-existing', 'Existing PC', None)]
            assert db.execute('SELECT device_id FROM platform_projects').fetchall() == [('device-existing',)]
            assert db.execute('SELECT access_level FROM project_access_grants').fetchall() == [('read',)]
            assert db.execute('SELECT * FROM device_groups').fetchall() == []
            assert db.execute('PRAGMA foreign_key_check').fetchall() == []
    await asyncio.to_thread(verify)
