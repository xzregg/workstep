"""Per-application calendar schedules, evaluated in the configured time zone."""
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from pydantic import BaseModel, Field, field_validator
from typing import Literal


class SyncSchedule(BaseModel):
    frequency: Literal['off', 'daily', 'weekly'] = 'off'
    time: str = '09:00'
    timezone: str = 'Asia/Shanghai'
    weekday: int = Field(default=0, ge=0, le=6)

    @field_validator('time')
    @classmethod
    def valid_time(cls, value):
        import re
        if not re.fullmatch(r'(?:[01]\d|2[0-3]):[0-5]\d', value):
            raise ValueError('Invalid sync time')
        return value

    @field_validator('timezone')
    @classmethod
    def valid_zone(cls, value):
        try: ZoneInfo(value)
        except (ValueError, KeyError): raise ValueError('Invalid time zone')
        return value


def next_run(schedule, after=None):
    policy = SyncSchedule.model_validate(schedule)
    if policy.frequency == 'off': return None
    after = after or datetime.now(timezone.utc)
    local = after.astimezone(ZoneInfo(policy.timezone))
    hour, minute = map(int, policy.time.split(':'))
    candidate = local.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if policy.frequency == 'weekly':
        candidate += timedelta(days=(policy.weekday - candidate.weekday()) % 7)
    if candidate <= local:
        candidate += timedelta(days=7 if policy.frequency == 'weekly' else 1)
    return candidate.astimezone(timezone.utc)
