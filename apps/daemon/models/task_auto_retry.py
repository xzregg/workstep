"""Independent automatic-retry cooldown; does not alter workflow state."""
import peewee as pw
from models.base import BaseModel
from models.fields import UTCDateTimeField
from models.task import Task


class TaskAutoRetryRecord(BaseModel):
    task = pw.ForeignKeyField(Task, primary_key=True, on_delete="CASCADE")
    step_run_id = pw.TextField()
    attempted_at = UTCDateTimeField()

    class Meta:
        table_name = "task_auto_retry_records"
