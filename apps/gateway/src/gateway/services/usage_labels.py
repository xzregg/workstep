"""Display names for paged ledger groups; stable IDs remain the grouping keys."""
import asyncio
import time
from sqlalchemy import and_, or_, select
from gateway.models import Device, PlatformProject, PlatformProvider, User


async def label_usage_groups(call, entity, conditions, group_by, groups):
    keys = {group['value'] for group in groups if group['value'] is not None}
    if not keys:
        return
    names = {}
    pairs = []
    async with call.database.session() as session:
        if group_by == 'user':
            rows = (await session.execute(select(User.id, User.display_name, User.username)
                    .where(User.id.in_(keys)))).all()
            names = {id: display_name or username for id, display_name, username in rows}
        elif group_by in ('device', 'provider'):
            model = Device if group_by == 'device' else PlatformProvider
            rows = (await session.execute(select(model.id, model.name).where(model.id.in_(keys)))).all()
            names = dict(rows)
        elif group_by == 'project':
            # A host project ID is meaningful only on its source device. Limit
            # metadata lookup to the same already-authorized ledger records.
            source = select(entity.project_id, entity.device_id).where(
                *conditions, entity.project_id.in_(keys)).distinct().subquery()
            pairs = (await session.execute(select(source))).all()
            rows = (await session.execute(select(source.c.project_id, PlatformProject.name)
                .join(PlatformProject, and_(PlatformProject.device_id == source.c.device_id,
                    or_(PlatformProject.host_project_id == source.c.project_id,
                        PlatformProject.id == source.c.project_id))))).all()
            for id, name in rows:
                names.setdefault(id, set()).add(name)
    if group_by == 'project':
        catalog_cache = getattr(call.notifications, 'catalog', {})
        needed = {}
        for project_id, device_id in pairs:
            if project_id not in names:
                needed.setdefault(device_id, set()).add(project_id)
        slots = asyncio.Semaphore(4)
        async def resolve(device_id, ids):
            cached = catalog_cache.get(device_id)
            catalog = cached[1] if cached else []
            async with slots:
                if call.control_connections is not None and call.control_connections.is_online(device_id) and (not cached or cached[0] < time.monotonic() - 60):
                    try:
                        catalog = await call.control_connections.request_project_catalog(device_id)
                        catalog_cache[device_id] = (time.monotonic(), catalog)
                    except (ConnectionError, OSError, RuntimeError, asyncio.TimeoutError):
                        pass
                for project in catalog:
                    if project['id'] in ids:
                        names.setdefault(project['id'], set()).add(project['name'])
        if needed:
            try:
                # Names cannot hold up a report when a source daemon is slow.
                await asyncio.wait_for(asyncio.gather(*(resolve(device, ids) for device, ids in needed.items())), 2)
            except asyncio.TimeoutError:
                pass
        names = {id: ' / '.join(sorted(values)) for id, values in names.items()}
    for group in groups:
        group['label'] = names.get(group['value'])
