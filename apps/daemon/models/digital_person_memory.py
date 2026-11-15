"""Legacy project-local models, read only by the global Memory migration.

Do not register these in ALL_MODELS: new projects must not create memory tables.
"""
import peewee as pw
from playhouse.sqlite_ext import FTS5Model, SearchField
from models.base import BaseModel, db_proxy
from models.chat_session import ChatMessage
from models.fields import UTCDateTimeField, utc_now


class DigitalMemoryChunk(BaseModel):
    source = pw.ForeignKeyField(ChatMessage, on_delete='CASCADE', backref='memory_chunks')
    scope = pw.TextField(index=True)
    offset = pw.IntegerField(default=0)
    content = pw.TextField()
    category = pw.TextField(default='episodic')
    importance = pw.FloatField(default=.5)
    reinforcements = pw.IntegerField(default=0)
    activated_at = UTCDateTimeField(default=utc_now)
    forgotten = pw.BooleanField(default=False)

    class Meta:
        table_name = 'digital_memory_chunks'
        indexes = ((('source', 'offset'), True),)


class DigitalMemoryActivation(BaseModel):
    chunk = pw.ForeignKeyField(DigitalMemoryChunk, on_delete='CASCADE')
    event_key = pw.TextField()

    class Meta:
        table_name = 'digital_memory_activations'
        indexes = ((('chunk', 'event_key'), True),)


class DigitalMemorySearch(FTS5Model):
    terms = SearchField()

    class Meta:
        database = db_proxy
        table_name = 'digital_memory_search'
