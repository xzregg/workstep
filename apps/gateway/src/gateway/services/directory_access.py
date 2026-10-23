"""Track enterprise-caused access suspension separately from local administrator choices."""
import json
from datetime import datetime,timezone
from sqlalchemy import select,update
from gateway.models import User,AuthSession,PlatformSetting,DirectoryPerson

PREFIX='directory-disabled:'
ENTERPRISE_ACCOUNT_SOURCES={'directory_sync','dingtalk','wecom','feishu','lark'}

async def disable_access(session,user_ids,source_id=None):
    if not user_ids:return
    active=set((await session.scalars(select(User.id).where(User.id.in_(user_ids),
        User.registration_source.in_(ENTERPRISE_ACCOUNT_SOURCES),User.status=='active'))).all())
    if active and source_id:
        keys=[PREFIX+id for id in active]
        existing={row.key:row for row in (await session.scalars(select(PlatformSetting).where(PlatformSetting.key.in_(keys)))).all()}
        for id in active:
            key=PREFIX+id;value=json.dumps(source_id)
            if key in existing:existing[key].value_json=value
            else:session.add(PlatformSetting(key=key,value_json=value))
    await session.execute(update(User).where(User.id.in_(active)).values(status='disabled'))
    await session.execute(update(AuthSession).where(AuthSession.user_id.in_(user_ids),
        AuthSession.revoked_at.is_(None)).values(revoked_at=datetime.now(timezone.utc)))

async def reactivable_users(session,source_id,user_ids):
    if not user_ids:return set()
    markers=(await session.scalars(select(PlatformSetting).where(
        PlatformSetting.key.in_([PREFIX+id for id in user_ids]),PlatformSetting.value_json==json.dumps(source_id)))).all()
    blocked=set((await session.scalars(select(DirectoryPerson.user_id).where(
        DirectoryPerson.user_id.in_(user_ids),DirectoryPerson.source_id!=source_id,DirectoryPerson.active==0))).all())
    return {row.key[len(PREFIX):] for row in markers}-blocked

async def clear_suspension(session,user_ids):
    if user_ids:await session.execute(PlatformSetting.__table__.delete().where(
        PlatformSetting.key.in_([PREFIX+id for id in user_ids])))
