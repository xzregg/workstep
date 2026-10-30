"""Current-user statistics with the same metering semantics as the admin ledger."""
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select

from gateway.models import UsageEvent
from gateway.services.identity import COOKIE_NAME
from gateway.services.identity_api import _identity
from gateway.services.usage_ledger import _usage_select_totals, _usage_totals


async def account_usage(call, days=30):
    user, _ = await _identity(call).session_user(call.tokens.get(COOKIE_NAME))
    end = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1)
    start = end - timedelta(days=days)
    # Attribution is the ledger user, never a caller-supplied ID or all users of a shared device.
    conditions = [UsageEvent.user_id == user.id, UsageEvent.source == 'reported_by_device',
                  UsageEvent.occurred_at >= start, UsageEvent.occurred_at < end]
    totals = _usage_select_totals(UsageEvent)
    async with call.database.session() as session:
        summary = _usage_totals((await session.execute(select(*totals).where(*conditions))).one())
        day = func.date(UsageEvent.occurred_at)
        daily_rows = (await session.execute(select(day, *totals).where(*conditions)
            .group_by(day).order_by(day))).all()
        model_rows = (await session.execute(select(UsageEvent.model, *totals).where(*conditions)
            .group_by(UsageEvent.model).order_by(func.count(UsageEvent.id).desc(), UsageEvent.model)
            .limit(8))).all()
    by_day = {value: _usage_totals(values) for value, *values in daily_rows}
    # Days with no calls are zero; calls with missing metering retain null token values.
    empty = {'event_count': 0, 'unmetered_count': 0, 'input_tokens': 0, 'output_tokens': 0,
             'cache_read_tokens': 0, 'cache_write_tokens': 0, 'total_tokens': 0,
             'estimated_cost': None, 'billed_cost': None, 'currency': None}
    daily = []
    for index in range(days):
        value = (start + timedelta(days=index)).date().isoformat()
        daily.append({'value': value, **by_day.get(value, empty)})
    return {'days': days, 'from_time': start, 'to_time': end, 'summary': summary,
            'daily': daily, 'models': [{'value': value, **_usage_totals(values)} for value, *values in model_rows]}
