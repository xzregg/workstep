"""Per-project database execution outside the FastAPI event loop."""

import asyncio
import contextvars
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Callable, TypeVar

import peewee as pw

from models import db_proxy


ResultT = TypeVar("ResultT")


class ProjectDatabaseExecutor:
    """Serialize one project's Peewee work on a dedicated thread.

    SQLite permits one writer per database. A single-thread executor preserves
    that ordering while ensuring lock waits and disk I/O never occupy the
    FastAPI event-loop thread. The worker owns its Peewee connection through
    Peewee's thread-local connection state.
    """

    def __init__(self, database: pw.SqliteDatabase, project_id: str) -> None:
        self._database = database
        self._executor = ThreadPoolExecutor(
            max_workers=1,
            thread_name_prefix=f"workstep-db-{project_id or 'project'}",
        )
        self._state_lock = threading.Lock()
        self._closed = False

    async def run(self, operation: Callable[[], ResultT]) -> ResultT:
        """Run one complete database work unit in project order."""
        loop = asyncio.get_running_loop()
        context = contextvars.copy_context()
        with self._state_lock:
            if self._closed:
                raise RuntimeError("Project database executor is closed")
            future = loop.run_in_executor(
                self._executor,
                lambda: context.run(self._execute, operation),
            )
        try:
            return await asyncio.shield(future)
        except asyncio.CancelledError:
            # SQLite cannot be interrupted safely in the middle of a
            # transaction. Let the work unit commit or roll back first.
            await future
            raise

    def _execute(self, operation: Callable[[], ResultT]) -> ResultT:
        token = db_proxy.activate(self._database)
        try:
            if self._database.is_closed():
                self._database.connect(reuse_if_open=True)
            return operation()
        finally:
            db_proxy.reset(token)

    def close(self) -> None:
        """Drain pending work, close the worker connection, and stop it."""
        with self._state_lock:
            if self._closed:
                return
            self._closed = True
            future = self._executor.submit(self._close_worker_connection)
        future.result()
        self._executor.shutdown(wait=True)

    def _close_worker_connection(self) -> None:
        token = db_proxy.activate(self._database)
        try:
            if not self._database.is_closed():
                self._database.close()
        finally:
            db_proxy.reset(token)
