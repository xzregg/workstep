"""Idempotent migrations for per-project SQLite databases."""

from collections.abc import Callable

import peewee as pw

from models.base import db_proxy
from models.schema import SchemaVersion
from models.run import StepRun, WorkflowRun
from models.message import Message
from models.task import Task, TaskStep

LATEST_SCHEMA_VERSION = 3


def _create_initial_tables(db: pw.SqliteDatabase) -> None:
    db.create_tables([Task, TaskStep, Message], safe=True)


def _create_workflow_runs_table(db: pw.SqliteDatabase) -> None:
    db.create_tables([WorkflowRun], safe=True)


def _create_step_runs_table(db: pw.SqliteDatabase) -> None:
    db.create_tables([StepRun], safe=True)


MIGRATIONS: dict[int, Callable[[pw.SqliteDatabase], None]] = {
    1: _create_initial_tables,
    2: _create_workflow_runs_table,
    3: _create_step_runs_table,
}


def migrate_database(db: pw.SqliteDatabase) -> int:
    """Bind and upgrade an open project database, returning its schema version."""
    db_proxy.initialize(db)
    SchemaVersion.create_table(safe=True)
    row = SchemaVersion.get_or_none(SchemaVersion.id == 1)
    current_version = row.version if row else 0

    for version in range(current_version + 1, LATEST_SCHEMA_VERSION + 1):
        with db.atomic():
            MIGRATIONS[version](db)
            (
                SchemaVersion.insert(id=1, version=version)
                .on_conflict(
                    conflict_target=[SchemaVersion.id],
                    update={SchemaVersion.version: version},
                )
                .execute()
            )

    return LATEST_SCHEMA_VERSION
