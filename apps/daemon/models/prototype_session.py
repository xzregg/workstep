"""Persistent conversation belonging to a prototype document."""
import peewee as pw
from models.gen_session import WorkflowGenSession


class PrototypeSession(WorkflowGenSession):
    document_id = pw.TextField(unique=True)
    # Inherited shape lets the shared persistence adapter own engine state.
    workflow_id = pw.TextField(default='')

    class Meta:
        table_name = 'prototype_sessions'
        indexes = ()
