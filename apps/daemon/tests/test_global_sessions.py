import asyncio
from concurrent.futures import ThreadPoolExecutor
import threading

import pytest

from models.gen_session import WorkflowGenSession
from services import global_sessions


@pytest.fixture
def database_path(tmp_path, monkeypatch):
    global_sessions.reset_global_sessions_db()
    monkeypatch.setattr(global_sessions, "GLOBAL_SESSIONS_DB_PATH", tmp_path / "sessions.db")
    yield tmp_path / "sessions.db"
    global_sessions.reset_global_sessions_db()


def test_global_session_workers_share_handle_and_release_connections(database_path):
    barrier = threading.Barrier(4)

    def query(_):
        barrier.wait(timeout=3)
        with global_sessions.global_sessions_ctx():
            db = global_sessions.global_sessions_db()
            connection = db.connection()
            with global_sessions.global_sessions_ctx():
                assert db.connection() is connection
                assert WorkflowGenSession.select().count() == 0
            assert not db.is_closed()
        return db, db.is_closed()

    with ThreadPoolExecutor(max_workers=4) as workers:
        results = list(workers.map(query, range(4)))
    assert len({id(db) for db, closed in results}) == 1
    assert all(closed for db, closed in results)
    assert global_sessions.global_sessions_db().is_closed()


@pytest.mark.asyncio
async def test_slow_global_session_initialization_keeps_event_loop_responsive(database_path, monkeypatch):
    import peewee
    entered = threading.Event()
    release = threading.Event()
    original = peewee.SqliteDatabase.create_tables

    def slow_create(db, *args, **kwargs):
        entered.set()
        assert release.wait(2)
        return original(db, *args, **kwargs)

    monkeypatch.setattr(peewee.SqliteDatabase, "create_tables", slow_create)
    pending = asyncio.create_task(asyncio.to_thread(global_sessions.global_sessions_db))
    try:
        assert await asyncio.to_thread(entered.wait, 1)
        await asyncio.wait_for(asyncio.sleep(0), timeout=0.2)
        assert not pending.done()
    finally:
        release.set()
        db = await pending
    assert await asyncio.to_thread(db.is_closed)
