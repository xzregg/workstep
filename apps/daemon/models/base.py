"""Peewee base model with runtime-bound database proxy."""

import peewee as pw

# Proxy: initialized per-project when a project DB is opened
db_proxy = pw.Proxy()


class BaseModel(pw.Model):
    class Meta:
        database = db_proxy
