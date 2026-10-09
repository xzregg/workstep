"""Durable organization change notices, isolated from task notifications."""
import json
from datetime import datetime, timezone
from sqlalchemy import select
from gateway.models import PlatformSetting
from gateway.services.management_scope import organization_manager
from pydantic import BaseModel, Field

CHANGE_KEYS = ('departments_added', 'departments_updated', 'departments_moved', 'departments_deleted',
               'people_added', 'people_updated', 'people_transferred', 'people_departed', 'people_unverified')


async def record_notice(session, source_id, result=None, error=None):
    if not error and not any(result.get(key, 0) for key in CHANGE_KEYS): return
    key = 'directory-notice:' + source_id
    row = await session.get(PlatformSetting, key)
    value = json.dumps({'source_id': source_id, 'at': datetime.now(timezone.utc).isoformat(),
                        'result': result, 'error': error})
    if row: row.value_json = value
    else: session.add(PlatformSetting(key=key, value_json=value))


async def list_notices(call):
    actor, allowed = await organization_manager(call)
    async with call.database.session() as session:
        rows = (await session.scalars(select(PlatformSetting).where(PlatformSetting.key.like('directory-notice:%')))).all()
        read = await session.get(PlatformSetting, 'directory-notice-read:' + actor.id)
        seen = json.loads(read.value_json) if read else {}
        notices = [json.loads(row.value_json) for row in rows]
        return {'notices': [notice for notice in notices if (allowed is None or notice['source_id'] in allowed) and seen.get(notice['source_id']) != notice['at']]}


class NoticeRead(BaseModel):
    source_id: str = Field(min_length=1, max_length=64)
    at: str = Field(min_length=1, max_length=64)


async def read_notice(call, body):
    actor, _ = await organization_manager(call, source_id=body.source_id, mutation=True)
    async with call.database.session() as session:
        async with session.begin():
            key = 'directory-notice-read:' + actor.id
            row = await session.get(PlatformSetting, key)
            seen = json.loads(row.value_json) if row else {}
            seen[body.source_id] = body.at
            if row: row.value_json = json.dumps(seen)
            else: session.add(PlatformSetting(key=key, value_json=json.dumps(seen)))
    return {'ok': True}
