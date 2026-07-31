"""Workflow model — one project can have multiple named workflows."""

import peewee as pw
from models.base import BaseModel


class Workflow(BaseModel):
    id = pw.TextField(primary_key=True)
    name = pw.TextField()
    steps_json = pw.TextField()
    is_default = pw.IntegerField(default=0)
    deleted = pw.IntegerField(default=0)
    created_at = pw.IntegerField()
    updated_at = pw.IntegerField()

    class Meta:
        table_name = "workflows"
