"""Instance-wide SQLite index. Call only in a worker, never on the event loop.

The index holds one metadata record per project/message identity, not chat text.
Each connection is short lived; the lock also makes state read/modify/write atomic.
"""
from contextlib import contextmanager
import json
import math
import re
import sqlite3
import threading
from datetime import datetime, timezone

from services import config

_lock = threading.RLock()
HALF_LIVES = {'short': 3, 'episodic': 30, 'long': 365}


def database_path():
    return config.CONFIG_DIR / 'Memory' / 'memory.db'


@contextmanager
def connect():
    with _lock:
        path = database_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        readme = path.parent / 'README.md'
        if not readme.exists():
            readme.write_text('# WorkStep 记忆主目录\n\n'
                              'memory.db 保存本实例的全局记忆索引、来源位置、分类、遗忘与强化记录，'
                              '以及数字人的念头、联系和巡检状态。完整聊天原文仍保存在各项目数据库中。\n\n'
                              '本目录属于应用数据，随 WORKSTEP_CONFIG_DIR 迁移，不属于程序安装目录。'
                              '备份时请先停止服务，再备份整个目录；不要单独删除数据库旁的日志文件。\n', encoding='utf-8')
        db = sqlite3.connect(path, timeout=5)
        db.row_factory = sqlite3.Row
        try:
            db.execute('PRAGMA foreign_keys=ON')
            db.executescript('''
                CREATE TABLE IF NOT EXISTS memories (
                  id INTEGER PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT NOT NULL,
                  source_message_id TEXT NOT NULL, offset INTEGER NOT NULL, scope TEXT NOT NULL,
                  summary TEXT NOT NULL, source_hash TEXT NOT NULL, role TEXT NOT NULL,
                  source_time TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'episodic',
                  importance REAL NOT NULL DEFAULT .5, reinforcements INTEGER NOT NULL DEFAULT 0,
                  activated_at TEXT NOT NULL, forgotten INTEGER NOT NULL DEFAULT 0,
                  UNIQUE(project_id, source_message_id, offset));
                CREATE INDEX IF NOT EXISTS memories_scope_time ON memories(scope,source_time);
                CREATE INDEX IF NOT EXISTS memories_project_session ON memories(project_id,session_id);
                CREATE VIRTUAL TABLE IF NOT EXISTS memory_search USING fts5(terms);
                CREATE TABLE IF NOT EXISTS activations (
                  memory_id INTEGER REFERENCES memories(id) ON DELETE CASCADE,
                  event_key TEXT NOT NULL, PRIMARY KEY(memory_id,event_key));
                CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY,value_json TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS digital_reflection_ignored (
                  project_id TEXT, message_id TEXT, PRIMARY KEY(project_id,message_id));
                CREATE TABLE IF NOT EXISTS legacy_imports (project_id TEXT PRIMARY KEY);
                CREATE TRIGGER IF NOT EXISTS memory_search_delete AFTER DELETE ON memories
                  BEGIN DELETE FROM memory_search WHERE rowid=old.id; END;
            ''')
            columns = {row['name'] for row in db.execute('PRAGMA table_info(memories)')}
            if 'source_kind' not in columns:
                db.execute("ALTER TABLE memories ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'chat'")
            if 'source_metadata_json' not in columns:
                db.execute("ALTER TABLE memories ADD COLUMN source_metadata_json TEXT NOT NULL DEFAULT '{}'")
            from services.memory_message_migration import migrate
            migrate(db)
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()


def terms(text):
    words = re.findall(r'[a-z0-9_]{2,40}', str(text).lower())
    for part in re.findall(r'[\u3400-\u9fff]+', str(text)):
        words.extend(part[i:i+2] for i in range(max(0, len(part)-1)))
    return list(dict.fromkeys(words))[:512]


def capture(project_id, session_id, message_id, scope, role, content, created_at, *, source_kind="chat", metadata=None):
    stamp = created_at.isoformat() if isinstance(created_at, datetime) else str(created_at)
    with connect() as db:
        # System-delivered summaries are output, never fresh independent evidence.
        if db.execute('SELECT 1 FROM digital_reflection_ignored WHERE project_id=? AND message_id=?',
                      (project_id,message_id)).fetchone():
            return {}
        row = db.execute('SELECT * FROM memories WHERE project_id=? AND source_message_id=?',
                         (project_id, message_id)).fetchone()
        metadata_json = json.dumps(metadata or {}, ensure_ascii=False)
        if row is None:
            if not content:
                return {}
            mid=db.execute('SELECT next_id FROM memory_identity_sequence WHERE id=1').fetchone()[0]
            db.execute('UPDATE memory_identity_sequence SET next_id=next_id+1 WHERE id=1')
            cursor = db.execute("""INSERT INTO memories(id,project_id,session_id,source_message_id,offset,scope,summary,
                source_hash,role,source_time,activated_at,source_kind,source_metadata_json)
                VALUES(?,?,?,?,0,?,'','',?,?,?,?,?)""",
                (mid,project_id,session_id,message_id,scope,role,stamp,stamp,source_kind,metadata_json))
            return {0:cursor.lastrowid}
        if not row['forgotten']:
            db.execute("""UPDATE memories SET session_id=?,scope=?,role=?,source_time=?,source_kind=?,source_metadata_json=?
                WHERE id=?""", (session_id,scope,role,stamp,source_kind,metadata_json,row['id']))
        return {0:row['id']}


def power(row, now=None):
    now = now or datetime.now(timezone.utc)
    stamp = datetime.fromisoformat(row['activated_at'])
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    half = HALF_LIVES.get(row['category'], 30)*(.5+row['importance']*1.5)*(1+min(row['reinforcements'], 8)*.25)
    return 2 ** (-max(0, (now-stamp).total_seconds()/86400)/half)


def candidates(scope=None, query='', *, since=None, before=None, limit=80, project_ids=None, exclude_source=None):
    with connect() as db:
        where, args = ['m.forgotten=0'], []
        if scope:
            where.append('m.scope=?'); args.append(scope)
        if project_ids is not None:
            if not project_ids:
                return []
            where.append('m.project_id IN ('+','.join('?' for _ in project_ids)+')'); args.extend(project_ids)
        for name, value, op in [('source_time', since, '>='), ('source_time', before, '<')]:
            if value:
                where.append('m.'+name+op+'?'); args.append(value.isoformat() if isinstance(value, datetime) else str(value))
        if exclude_source:
            where.append('m.source_message_id!=?'); args.append(exclude_source)
        selected = terms(query)[:64]
        join, order = '', 'm.source_time DESC,m.id DESC'
        if query:
            if not selected:
                return []
            join = ' JOIN memory_search ON memory_search.rowid=m.id'
            where.append('memory_search MATCH ?')
            args.append(' OR '.join('"'+word.replace('"','""')+'"' for word in selected))
            order = 'bm25(memory_search)'
        rows = [dict(row) for row in db.execute('SELECT m.* FROM memories m'+join+' WHERE '+' AND '.join(where)+' ORDER BY '+order+' LIMIT ?', (*args, min(200, max(1, limit))))]
        if query:
            rows = [row for _,row in sorted(enumerate(rows), key=lambda item:(1/(10+item[0]))*(.8+.2*power(item[1])), reverse=True)]
        return rows


def reinforce(mid, event_key):
    with connect() as db:
        cursor = db.execute('INSERT OR IGNORE INTO activations VALUES(?,?)', (mid, event_key))
        if cursor.rowcount:
            db.execute('UPDATE memories SET reinforcements=MIN(8,reinforcements+1),activated_at=? WHERE id=?',
                       (datetime.now(timezone.utc).isoformat(), mid))


def forget(mid):
    mid = str(mid).removeprefix('memory:')
    with connect() as db:
        alias=db.execute('SELECT memory_id FROM memory_source_aliases WHERE old_id=?',(mid,)).fetchone()
        mid=alias[0] if alias else mid
        cursor = db.execute("UPDATE memories SET forgotten=1,summary='',source_hash='' WHERE id=?", (mid,))
        db.execute('DELETE FROM memory_search WHERE rowid=?', (mid,))
        db.execute('DELETE FROM activations WHERE memory_id=?', (mid,))
        return bool(cursor.rowcount)


def classify(scope, updates, allowed_ids):
    changed = []
    with connect() as db:
        for item in updates[:12] if isinstance(updates, list) else []:
            if not isinstance(item, dict) or str(item.get('id')) not in allowed_ids:
                continue
            category, importance = item.get('category'), item.get('importance', .5)
            if not isinstance(category,str) or category not in HALF_LIVES or isinstance(importance,bool) or not isinstance(importance,(int,float)) or not math.isfinite(importance) or not 0 <= importance <= 1:
                continue
            cursor = db.execute('UPDATE memories SET category=?,importance=? WHERE id=? AND scope=? AND forgotten=0',
                                (category,importance,str(item['id']).removeprefix('memory:'),scope))
            if cursor.rowcount:
                changed.append(item['id'])
    return changed


def mutate_state(key, change, default=None):
    with connect() as db:
        row = db.execute('SELECT value_json FROM state WHERE key=?', (key,)).fetchone()
        value = json.loads(row[0]) if row else (default or {})
        result = change(value)
        db.execute('INSERT INTO state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json',
                   (key,json.dumps(value,ensure_ascii=False,default=str)))
        return result


def read_state(key):
    with connect() as db:
        row = db.execute('SELECT value_json FROM state WHERE key=?', (key,)).fetchone()
        return json.loads(row[0]) if row else None


def delete_source(project_id, message_id):
    with connect() as db:
        db.execute('DELETE FROM memories WHERE project_id=? AND source_message_id=?', (project_id,message_id))


def delete_session(project_id, session_id):
    with connect() as db:
        db.execute('DELETE FROM memories WHERE project_id=? AND session_id=?', (project_id,session_id))
