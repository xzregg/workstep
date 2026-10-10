"""Project-local external task creation credentials and configuration."""
import peewee as pw
from models.base import BaseModel


class WorkflowHook(BaseModel):
    id = pw.TextField(primary_key=True)
    workflow_id = pw.TextField(index=True)
    name = pw.TextField()
    token = pw.TextField()
    enabled = pw.BooleanField(default=True)
    step_key = pw.TextField(default='')
    default_title = pw.TextField()
    default_creator = pw.TextField(default='钩子触发')
    execution_mode = pw.TextField(default='manual')
    owner_id = pw.TextField(null=True)
    sort_order = pw.IntegerField(default=0)

    class Meta:
        table_name = 'workflow_hooks'
