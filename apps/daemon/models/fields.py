"""Shared model fields for project-local SQLite databases."""

from datetime import datetime, timezone

import peewee as pw


class UTCDateTimeField(pw.DateTimeField):
    """Store timezone-aware UTC datetimes in SQLite DATETIME columns."""

    def db_value(self, value):
        if isinstance(value, (int, float)):
            value = datetime.fromtimestamp(value, timezone.utc)
        if isinstance(value, datetime):
            if value.tzinfo is None:
                value = value.replace(tzinfo=timezone.utc)
            else:
                value = value.astimezone(timezone.utc)
        return super().db_value(value)

    def python_value(self, value):
        parsed = super().python_value(value)
        if isinstance(parsed, datetime) and parsed.tzinfo is None:
            return parsed.replace(tzinfo=timezone.utc)
        return parsed


def utc_now() -> datetime:
    return datetime.now(timezone.utc)
