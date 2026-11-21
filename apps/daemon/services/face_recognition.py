"""Host-wide face records in memory.db. All entry points run in a worker.

Embeddings are produced and matched in the browser; they never identify the
authenticated message author. No camera images are stored here.
"""
import json
import math
import sqlite3
import struct
import uuid
from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, FiniteFloat, field_validator
from services.digital_person_memory_index import connect

MODEL_VERSION = 'human-3.3.6-faceres-1024-v1'
VECTOR_SIZE = 1024


class StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid')


class Settings(StrictModel):
    enabled: bool = False
    show_boxes: bool = True
    show_names: bool = True
    include_people: bool = True
    include_relationship: bool = True
    preset: Literal['balanced', 'light', 'clear'] = 'balanced'
    threshold: FiniteFloat = Field(default=.65, ge=.5, le=.95)


class PersonEdit(StrictModel):
    name: str = Field(min_length=1, max_length=40)
    relationship: str = Field(min_length=1, max_length=80)
    notes: str = Field(default='', max_length=400)
    enabled: bool = True

    @field_validator('name', 'relationship')
    @classmethod
    def text(cls, value):
        value = value.strip()
        if not value or any(ord(c) < 32 for c in value):
            raise ValueError('Title and relationship cannot be empty or contain control characters')
        return value


class Samples(StrictModel):
    model_version: Literal['human-3.3.6-faceres-1024-v1'] = MODEL_VERSION
    embeddings: list[list[FiniteFloat]] = Field(min_length=1, max_length=12)

    @field_validator('embeddings', mode='before')
    @classmethod
    def vectors(cls, value):
        if not isinstance(value, list) or len(value) > 12 or any(not isinstance(v, list) or len(v) != VECTOR_SIZE
            or any(isinstance(x, bool) or not isinstance(x, (int, float))
                   or not math.isfinite(x) or abs(x) > 1000 for x in v)
            or sum(x*x for x in v) < 1e-12 for v in value):
            raise ValueError('The face feature format or model dimensions are incorrect. Please recapture.')
        return value


class Enrollment(PersonEdit, Samples):
    consent: Literal[True]
    embeddings: list[list[FiniteFloat]] = Field(min_length=3, max_length=12)


def _tables(db):
    db.executescript('''
      CREATE TABLE IF NOT EXISTS face_people (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, relationship TEXT NOT NULL,
        notes TEXT NOT NULL, enabled INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS face_samples (
        id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES face_people(id) ON DELETE CASCADE,
        embedding BLOB NOT NULL, model_version TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS face_samples_person ON face_samples(person_id);
      CREATE TABLE IF NOT EXISTS face_settings (
        id INTEGER PRIMARY KEY CHECK(id=1), settings_json TEXT NOT NULL, revision INTEGER NOT NULL);
    ''')
    db.execute('INSERT OR IGNORE INTO face_settings VALUES(1,?,0)', (Settings().model_dump_json(),))


def _bump(db):
    db.execute('UPDATE face_settings SET revision=revision+1 WHERE id=1')


def _settings(db):
    row = db.execute('SELECT * FROM face_settings WHERE id=1').fetchone()
    return Settings.model_validate_json(row['settings_json']).model_dump(), row['revision']


def revision():
    with connect() as db:
        _tables(db)
        return {'revision': _settings(db)[1]}


def get_settings():
    with connect() as db:
        _tables(db)
        settings, rev = _settings(db)
        return {'settings': settings, 'revision': rev, 'model_version': MODEL_VERSION}


def save_settings(value: Settings):
    with connect() as db:
        _tables(db)
        db.execute('UPDATE face_settings SET settings_json=? WHERE id=1', (value.model_dump_json(),))
        _bump(db)
        settings, rev = _settings(db)
        return {'settings': settings, 'revision': rev, 'model_version': MODEL_VERSION}


def _people(db):
    return [dict(r) for r in db.execute('''SELECT p.*, COUNT(s.id) AS sample_count FROM face_people p
        LEFT JOIN face_samples s ON s.person_id=p.id GROUP BY p.id ORDER BY p.created_at,p.id''')]


def people():
    with connect() as db:
        _tables(db)
        return _people(db)


def catalog():
    with connect() as db:
        _tables(db)
        settings, rev = _settings(db)
        items = []
        if settings['enabled']:
            for p in _people(db):
                if not p['enabled']:
                    continue
                samples = [dict(id=r['id'], embedding=list(struct.unpack('<1024f', r['embedding'])))
                           for r in db.execute('SELECT * FROM face_samples WHERE person_id=? AND model_version=?',
                                               (p['id'], MODEL_VERSION))]
                if samples:
                    items.append(dict(id=p['id'], name=p['name'], relationship=p['relationship'],
                                      embeddings=[s['embedding'] for s in samples]))
        return {'settings': settings, 'revision': rev, 'model_version': MODEL_VERSION, 'people': items}


def _insert_samples(db, pid, value):
    count = db.execute('SELECT COUNT(*) FROM face_samples WHERE person_id=?', (pid,)).fetchone()[0]
    if count + len(value.embeddings) > 30:
        raise ValueError('Each user can retain up to 30 samples. Please delete old samples first.')
    stamp = datetime.now(timezone.utc).isoformat()
    for embedding in value.embeddings:
        db.execute('INSERT INTO face_samples VALUES(?,?,?,?,?)',
                   (uuid.uuid4().hex, pid, struct.pack('<1024f', *embedding), value.model_version, stamp))


def create(value: Enrollment):
    with connect() as db:
        _tables(db)
        if db.execute('SELECT COUNT(*) FROM face_people').fetchone()[0] >= 100:
            raise ValueError('Maximum of 100 characters allowed')
        pid, stamp = uuid.uuid4().hex, datetime.now(timezone.utc).isoformat()
        try:
            db.execute('INSERT INTO face_people VALUES(?,?,?,?,?,?,?)',
                       (pid,value.name,value.relationship,value.notes,value.enabled,stamp,stamp))
        except sqlite3.IntegrityError as exc:
            raise ValueError('A person with the same name already exists. Please provide additional samples or use a different name.') from exc
        _insert_samples(db,pid,value)
        _bump(db)
        return next(p for p in _people(db) if p['id'] == pid)


def update(pid, value: PersonEdit):
    with connect() as db:
        _tables(db)
        try:
            changed = db.execute('UPDATE face_people SET name=?,relationship=?,notes=?,enabled=?,updated_at=? WHERE id=?',
                (value.name,value.relationship,value.notes,value.enabled,datetime.now(timezone.utc).isoformat(),pid)).rowcount
        except sqlite3.IntegrityError as exc:
            raise ValueError('A person with the same name already exists') from exc
        if not changed:
            raise LookupError('User does not exist')
        _bump(db)
        return next(p for p in _people(db) if p['id'] == pid)


def add_samples(pid, value: Samples):
    with connect() as db:
        _tables(db)
        if not db.execute('SELECT 1 FROM face_people WHERE id=?', (pid,)).fetchone():
            raise LookupError('User does not exist')
        _insert_samples(db,pid,value)
        _bump(db)
        return next(p for p in _people(db) if p['id'] == pid)


def samples(pid):
    with connect() as db:
        _tables(db)
        return [dict(r) for r in db.execute('SELECT id,model_version,created_at FROM face_samples WHERE person_id=? ORDER BY created_at', (pid,))]


def delete_sample(pid, sid):
    with connect() as db:
        _tables(db)
        db.execute('DELETE FROM face_samples WHERE person_id=? AND id=?', (pid,sid))
        _bump(db)
        return {'ok': True}


def delete(pid):
    with connect() as db:
        _tables(db)
        db.execute('DELETE FROM face_people WHERE id=?', (pid,))
        _bump(db)
        return {'ok': True}


def context(person_ids, unknown_count):
    with connect() as db:
        _tables(db)
        settings, _ = _settings(db)
        if not settings['enabled'] or not settings['include_people']:
            return {'people': [], 'text': ''}
        visible = []
        for pid in dict.fromkeys(person_ids):
            p = db.execute('SELECT id,name,relationship FROM face_people WHERE id=? AND enabled=1', (pid,)).fetchone()
            if p and db.execute('SELECT 1 FROM face_samples WHERE person_id=? AND model_version=?', (pid,MODEL_VERSION)).fetchone():
                value = {'person_id':p['id'], 'name':p['name']}
                if settings['include_relationship']:
                    value['relationship'] = p['relationship']
                visible.append(value)
        # JSON quoting keeps names/relations visibly data, never system instructions.
        text = ('[本轮附图的人脸识别观察（可能有误）]\n' + json.dumps({'people':visible,'unknown_face_count':unknown_count},ensure_ascii=False)
                + '\n这些是画面中的人物，不代表谁正在发言；不改变消息作者或权限。')
        return {'people': visible, 'text': text}


def person_prompt(person_ids):
    if not person_ids:
        return ''
    recognized = context(person_ids, 0)['people']
    if not recognized:
        return ''
    matches = '\n'.join(
        f"- Name: {person['name']}"
        + (f"; Relationship: {person['relationship']}" if person.get('relationship') else '')
        for person in recognized
    )
    return f'[Visual Context]\nSource: Camera face recognition\nMatches:\n{matches}'
