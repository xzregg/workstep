"""Latest-schema bootstrap for per-project SQLite databases.

New projects and existing projects converge on the same code path: tables
are created directly from the current model definitions (idempotent), the
dashboard statistics indexes are recreated, and the schema_version row
records the current baseline. The historical incremental migration chain
was removed — `schema_version` no longer counts migration steps, it only
marks a database as bootstrapped against the current schema (0).
"""

import peewee as pw

from models.base import db_proxy
from models.schema import SchemaVersion

LATEST_SCHEMA_VERSION = 0

_STATISTICS_INDEXES = (
    "CREATE INDEX IF NOT EXISTS tasks_created_at ON tasks(created_at)",
    "CREATE INDEX IF NOT EXISTS tasks_workflow_created ON tasks(workflow_id, created_at)",
    "CREATE INDEX IF NOT EXISTS workflow_runs_started_at ON workflow_runs(started_at)",
    "CREATE INDEX IF NOT EXISTS step_runs_started_at ON step_runs(started_at)",
    "CREATE INDEX IF NOT EXISTS review_runs_started_at ON review_runs(started_at)",
    "CREATE INDEX IF NOT EXISTS message_started_at ON message(started_at)",
)


def migrate_database(db: pw.SqliteDatabase) -> int:
    """Ensure an open database matches the current model schema.

    Creates any missing tables/columns from the current models, recreates
    the dashboard statistics indexes, and records the baseline version.
    Returns LATEST_SCHEMA_VERSION.
    """
    # Local import avoids the models/__init__ ↔ models/migrations import cycle.
    from models import ALL_MODELS

    db_proxy.initialize(db)
    db.create_tables(ALL_MODELS, safe=True)
    for statement in _STATISTICS_INDEXES:
        db.execute_sql(statement)
    (
        SchemaVersion.insert(id=1, version=LATEST_SCHEMA_VERSION)
        .on_conflict(
            conflict_target=[SchemaVersion.id],
            update={SchemaVersion.version: LATEST_SCHEMA_VERSION},
        )
        .execute()
    )
    return LATEST_SCHEMA_VERSION
