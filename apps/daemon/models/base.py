"""Peewee base model with task-local project database routing."""

from contextvars import ContextVar, Token

import peewee as pw


class ProjectDatabaseProxy(pw.DatabaseProxy):
    """Route the shared Peewee models to this execution context's database.

    Peewee models keep one database object in their metadata for their entire
    lifetime. A regular ``Proxy.initialize()`` mutates that object process-wide,
    so one coroutine can redirect another after an ``await``. This proxy keeps
    the selected database in a ``ContextVar`` while retaining ``initialize`` as
    a compatibility fallback for existing synchronous callers.
    """

    __slots__ = ("_current_database",)
    _writable_attributes = {"obj", "_callbacks", "_Model", "_current_database"}

    def __init__(self) -> None:
        object.__setattr__(self, "_callbacks", [])
        object.__setattr__(
            self,
            "_current_database",
            ContextVar("workstep_project_database", default=None),
        )
        object.__setattr__(self, "obj", None)

    def __setattr__(self, attr, value) -> None:
        if attr not in self._writable_attributes:
            raise AttributeError("Cannot set attribute on proxy.")
        object.__setattr__(self, attr, value)

    @property
    def current_database(self) -> pw.Database | None:
        """Return the task-local database, falling back to the legacy binding."""
        database = self._current_database.get()
        return database if database is not None else self.obj

    def initialize(self, database) -> None:
        """Set both the legacy fallback and this context's active database."""
        self.obj = database
        self._current_database.set(database)
        for callback in self._callbacks:
            callback(database)

    def activate(self, database: pw.Database) -> Token:
        """Activate ``database`` locally and return a token for scoped reset."""
        return self._current_database.set(database)

    def reset(self, token: Token) -> None:
        """Restore the database active before a matching ``activate`` call."""
        self._current_database.reset(token)

    def _active_database(self):
        database = self.current_database
        if database is None:
            raise AttributeError("Cannot use uninitialized Proxy.")
        return database

    def __getattr__(self, attr):
        return getattr(self._active_database(), attr)

    def __enter__(self):
        return self._active_database().__enter__()

    def __exit__(self, exc_type, exc_val, exc_tb):
        return self._active_database().__exit__(exc_type, exc_val, exc_tb)


# All models share this router; each asyncio task selects its own project DB.
db_proxy = ProjectDatabaseProxy()


class BaseModel(pw.Model):
    class Meta:
        database = db_proxy
