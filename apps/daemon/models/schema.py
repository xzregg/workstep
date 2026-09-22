"""Schema metadata stored in every project database."""

import peewee as pw

from models.base import BaseModel


class SchemaVersion(BaseModel):
    """The migration version applied to a project database."""

    id = pw.IntegerField(primary_key=True, default=1)
    version = pw.IntegerField()

    class Meta:
        table_name = "schema_version"
