"""Host-scoped welcome settings and short-lived delivery reservations."""
import json
import re
from datetime import datetime, timedelta, timezone
from random import choice
from typing import Annotated, Literal

from pydantic import Field, StringConstraints

from services import digital_person, digital_person_companion as companion, face_recognition
from services.digital_person_memory_index import connect, read_state

SETTINGS = 'face_welcome_settings'
RECEIPTS = 'face_welcome_receipts'
COMPANION_STATE = 'digital_person_runtime'
VARIABLE = re.compile(r'\{(name|relationship)\}')
Phrase = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=160)]


class Settings(face_recognition.StrictModel):
    enabled: bool = False
    phrases: list[Phrase] = Field(default_factory=list, max_length=12)
    output: Literal['text', 'voice'] = 'text'
    away_minutes: int = Field(default=2, ge=1, le=120)
    person_cooldown_minutes: int = Field(default=60, ge=1, le=1440)
    interval_minutes: int = Field(default=10, ge=1, le=1440)
    hourly_limit: int = Field(default=2, ge=1, le=60)
    daily_limit: int = Field(default=4, ge=1, le=240)


class Candidate(face_recognition.StrictModel):
    event_id: str = Field(min_length=1, max_length=64, pattern=r'^[A-Za-z0-9_-]+$')
    person_id: str = Field(min_length=1, max_length=64)
    revision: int = Field(ge=0)


class Welcome(face_recognition.StrictModel):
    text: str
    speak: bool
    personalized: bool


def _read(db, key, default):
    row = db.execute('SELECT value_json FROM state WHERE key=?', (key,)).fetchone()
    return json.loads(row[0]) if row else default


def _write(db, key, value):
    db.execute('INSERT INTO state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json',
               (key, json.dumps(value, ensure_ascii=False)))


def settings():
    return Settings.model_validate(read_state(SETTINGS) or {})


def save(value):
    with connect() as db:
        face_recognition._tables(db)
        _write(db, SETTINGS, value.model_dump())
        face_recognition._bump(db)
    return value


def observation_settings(db):
    value = _read(db, SETTINGS, {})
    return {'enabled': True, 'away_minutes': value['away_minutes']} if value.get('enabled') else None


def _quiet(profile, hour):
    start, end = profile.quiet_start, profile.quiet_end
    if start <= end:
        return start <= hour < end
    return hour >= start or hour < end


def _live_receipts(rows, now):
    day_ago = now - timedelta(days=1)
    return [row for row in rows if companion.timestamp(row['at']) > day_ago]


def blocks_social(state, last_user, now):
    """Called inside the reflection reservation lock for the local scope."""
    receipts = _live_receipts(read_state(RECEIPTS) or [], now)
    if not receipts:
        return False
    value = state.get('companions', {}).get('local', {})
    contact = {'contacts': [receipts[-1]], 'last_observed_at': value.get('last_observed_at')}
    return not companion.contact_policy(contact, last_user, now, interval_minutes=settings().interval_minutes)['allowed']


def offer(candidate, last_user=None, *, now=None):
    now = now or datetime.now(timezone.utc)
    profile = digital_person.get_profile()
    if not profile.enabled or _quiet(profile, now.astimezone().hour):
        return None
    with connect() as db:
        face_recognition._tables(db)
        # The face settings row is initialized by a write in _tables, which
        # starts the SQLite transaction before checking or granting a receipt.
        face_settings, revision = face_recognition._settings(db)
        config = Settings.model_validate(_read(db, SETTINGS, {}))
        if not face_settings['enabled'] or not config.enabled or revision != candidate.revision:
            return None
        person = db.execute('''SELECT name,relationship FROM face_people AS p
            WHERE p.id=? AND p.enabled=1 AND EXISTS (
                SELECT 1 FROM face_samples AS s WHERE s.person_id=p.id AND s.model_version=?
            )''', (candidate.person_id, face_recognition.MODEL_VERSION)).fetchone()
        if not person:
            return None
        receipts = _live_receipts(_read(db, RECEIPTS, []), now)
        if any(row['id'] == candidate.event_id for row in receipts):
            return None
        runtime = _read(db, COMPANION_STATE, {})
        companion.observe_user(runtime, 'local', last_user)
        local = runtime.get('companions', {}).get('local', {})
        contacts = [*local.get('contacts', []), *receipts]
        policy = companion.contact_policy(dict(local, contacts=contacts), None, now,
                                          interval_minutes=config.interval_minutes)
        if not policy['allowed']:
            return None
        hourly = 0
        for row in receipts:
            elapsed = now - companion.timestamp(row['at'])
            if row['person_id'] == candidate.person_id and elapsed < timedelta(minutes=config.person_cooldown_minutes):
                return None
            hourly += elapsed < timedelta(hours=1)
        if hourly >= config.hourly_limit or len(receipts) >= config.daily_limit:
            return None
        phrase = choice(config.phrases) if config.phrases else '欢迎回来。'
        text = VARIABLE.sub(lambda match: person[match[1]], phrase)
        _write(db, RECEIPTS, [*receipts, {'id': candidate.event_id, 'at': now.isoformat(),
                                         'person_id': candidate.person_id}])
        return Welcome(text=text, speak=config.output == 'voice', personalized=bool(VARIABLE.search(phrase)))
