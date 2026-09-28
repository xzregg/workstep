"""Async Gateway database and isolated migration startup."""

import asyncio
import fcntl
import os
import sqlite3
from uuid import uuid4
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import select, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker, create_async_engine
from sqlalchemy.engine import make_url

from .config import GatewaySettings
from .models import PlatformSetting

MIGRATIONS_DIR = Path(__file__).resolve().parent / "migrations"
HEAD_REVISION = "0031_usage_rollups"


def safe_database_location(url: str) -> tuple[str, str]:
    parsed = make_url(url)
    backend = parsed.drivername.split("+", 1)[0]
    if backend == "sqlite":
        return backend, Path(parsed.database or "").name
    host = parsed.host or "localhost"
    port = f":{parsed.port}" if parsed.port else ""
    return backend, f"{host}{port}/{parsed.database or ''}"


def migration_config(url: str) -> Config:
    config = Config()
    config.set_main_option("script_location", str(MIGRATIONS_DIR))
    config.set_main_option("sqlalchemy.url", url.replace("%", "%%"))
    return config


def _upgrade(url: str) -> None:
    config = migration_config(url)
    command.upgrade(config, "head")


async def current_revision(engine: AsyncEngine) -> str | None:
    async with engine.connect() as connection:
        result = await connection.execute(text("SELECT version_num FROM alembic_version"))
        return result.scalar_one_or_none()


class GatewayDatabase:
    head_revision = HEAD_REVISION

    def __init__(self, settings: GatewaySettings):
        self.settings = settings
        self.engine: AsyncEngine | None = None
        self.session = None
        self._lock_file = None
        self._instance_connection = None
        self.usage_rollup_lock = asyncio.Lock()

    def _acquire_sqlite_lock(self, url: str) -> None:
        path = make_url(url).database
        if path in (None, ":memory:"):
            return
        lock_file = open(f"{path}.gateway.lock", "a+")
        try:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            lock_file.close()
            raise RuntimeError("Gateway instance already running for this database") from exc
        self._lock_file = lock_file

    def _release_sqlite_lock(self) -> None:
        if self._lock_file is not None:
            fcntl.flock(self._lock_file.fileno(), fcntl.LOCK_UN)
            self._lock_file.close()
            self._lock_file = None

    async def start(self) -> None:
        url = self.settings.effective_database_url
        if url.startswith("sqlite+aiosqlite:"):
            database_path = make_url(url).database
            if database_path not in (None, ":memory:"):
                await asyncio.to_thread(Path(database_path).parent.mkdir, parents=True, exist_ok=True)
            await asyncio.to_thread(self._acquire_sqlite_lock, url)
        try:
            if url.startswith("postgresql+asyncpg:"):
                self.engine = create_async_engine(url, pool_pre_ping=True)
                self._instance_connection = await self.engine.connect()
                acquired = await self._instance_connection.scalar(text("SELECT pg_try_advisory_lock(875701271)"))
                await self._instance_connection.commit()
                if not acquired:
                    raise RuntimeError("Gateway instance already running for this database")
            await asyncio.to_thread(_upgrade, url)
            engine = self.engine or create_async_engine(url, pool_pre_ping=True)
            revision = await current_revision(engine)
            if revision != self.head_revision:
                raise RuntimeError(f"Gateway database migration mismatch: {revision}")
            async with engine.connect() as connection:
                await connection.execute(select(1))
        except BaseException:
            if self._instance_connection is not None:
                await self._instance_connection.close()
                self._instance_connection = None
            if "engine" in locals():
                await engine.dispose()
            elif self.engine is not None:
                await self.engine.dispose()
            self.engine = None
            await asyncio.to_thread(self._release_sqlite_lock)
            raise
        self.engine = engine
        self.session = async_sessionmaker(engine, expire_on_commit=False)

    async def close(self) -> None:
        if self._instance_connection is not None:
            await self._instance_connection.close()
            self._instance_connection = None
        if self.engine is not None:
            await self.engine.dispose()
            self.engine = None
        await asyncio.to_thread(self._release_sqlite_lock)

    async def write_setting(self, key: str, value_json: str) -> None:
        async with self.session() as session:
            async with session.begin():
                session.add(PlatformSetting(key=key, value_json=value_json))

    async def backup_sqlite(self, destination: Path) -> None:
        url = self.settings.effective_database_url
        if not url.startswith("sqlite+aiosqlite:"):
            raise ValueError("PostgreSQL backups must use pg_dump")
        source = Path(make_url(url).database)
        await asyncio.to_thread(_backup_sqlite, source, destination)

    async def status(self) -> dict[str, str | bool | None]:
        backend, location = safe_database_location(self.settings.effective_database_url)
        if self.engine is None:
            return {"backend": backend, "location": location, "healthy": False, "migration_version": None}
        try:
            revision = await current_revision(self.engine)
        except SQLAlchemyError:
            return {"backend": backend, "location": location, "healthy": False, "migration_version": None}
        return {"backend": backend, "location": location, "healthy": True, "migration_version": revision}


def _backup_sqlite(source: Path, destination: Path) -> None:
    if source.resolve() == destination.resolve():
        raise ValueError("Backup destination must differ from the live database")
    if not source.is_file():
        raise FileNotFoundError(f"Gateway database does not exist: {source}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f".{destination.name}.{uuid4().hex}.tmp")
    try:
        with sqlite3.connect(f"{source.resolve().as_uri()}?mode=ro", uri=True) as source_connection, sqlite3.connect(temporary) as backup_connection:
            source_connection.backup(backup_connection)
            if backup_connection.execute("PRAGMA quick_check").fetchone() != ("ok",):
                raise RuntimeError("Gateway SQLite backup integrity check failed")
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)
