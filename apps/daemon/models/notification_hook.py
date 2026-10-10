"""Project-local notification targets and durable delivery outbox."""
import peewee as pw
from models.base import BaseModel


class NotificationHook(BaseModel):
    id = pw.TextField(primary_key=True)
    workflow_id = pw.TextField(index=True)
    name = pw.TextField()
    platform = pw.TextField()
    url = pw.TextField()
    secret = pw.TextField(default='')
    enabled = pw.BooleanField(default=True)
    events_json = pw.TextField()
    prefix = pw.TextField(default='')
    include_link = pw.BooleanField(default=True)
    link_base = pw.TextField(default='gateway')
    sort_order = pw.IntegerField(default=0)

    class Meta:
        table_name = 'notification_hooks'


class NotificationDelivery(BaseModel):
    id = pw.TextField(primary_key=True)
    hook_id = pw.TextField(index=True)
    event_id = pw.TextField()
    event = pw.TextField()
    title = pw.TextField()
    snapshot_json = pw.TextField()
    status = pw.TextField(default='pending')
    attempts = pw.IntegerField(default=0)
    cycle_attempts = pw.IntegerField(default=0)
    next_at = pw.DoubleField(default=0)
    created_at = pw.DoubleField()
    updated_at = pw.DoubleField()
    result = pw.TextField(default='')
    claim_id = pw.TextField(null=True)

    class Meta:
        table_name = 'notification_deliveries'
        indexes = ((('hook_id', 'event_id'), True), (('status', 'next_at'), False))
