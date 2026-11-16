"""Source-backed relationship state. All public functions run in a worker thread.

One response carries a small private prefix, no classifier call or tool roundtrip.
Original messages remain in project databases; only coordinates are stored here.
"""
import hashlib
import json
import math
from datetime import datetime, timezone

from services import digital_person_memory_index as index

OPEN, CLOSE = '<workstep-affect>', '</workstep-affect>'
EMOTIONS = {'calm', 'happy', 'warm', 'curious', 'sad', 'angry', 'tired'}
STYLES = {
    'balanced': 'Balanced: value respectful cooperation, distinguish criticism from personal attacks.',
    'warm': 'Warm and approachable: appreciate care and sharing, forgiving of awkward wording.',
    'reserved': 'Slow to trust: warm up gradually through reliable repeated interaction, value boundaries.',
    'tsundere': 'Proud and reserved: express care indirectly; friendly teasing may be welcome with familiar people, abuse is not affection.',
}


def subject(message, scope='local'):
    author = str(message.get('author_id') or '')
    if author:
        device = str(message.get('author_device_id') or '') if author.startswith('channel:') else ''
        return author + ('@'+device if device else '')
    return 'local:owner' if scope == 'local' else None


def _tables(db):
    db.executescript('''
      CREATE TABLE IF NOT EXISTS affect_people (
        person_id TEXT PRIMARY KEY, name TEXT NOT NULL, affinity REAL NOT NULL,
        emotion TEXT NOT NULL, valence REAL NOT NULL, arousal REAL NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS affect_events (
        id INTEGER PRIMARY KEY, person_id TEXT NOT NULL, project_id TEXT NOT NULL,
        session_id TEXT NOT NULL, source_ids TEXT NOT NULL, kind TEXT NOT NULL,
        delta REAL NOT NULL, before_value REAL NOT NULL, after_value REAL NOT NULL,
        emotion TEXT NOT NULL, reason TEXT NOT NULL, at TEXT NOT NULL, fingerprint TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS affect_events_person ON affect_events(person_id,id DESC);
      CREATE TABLE IF NOT EXISTS affect_sources (
        project_id TEXT NOT NULL, message_id TEXT NOT NULL, event_id INTEGER NOT NULL,
        PRIMARY KEY(project_id,message_id));
    ''')


def _now(now=None):
    return now or datetime.now(timezone.utc)


def _snapshot(db, person_id, now):
    row = db.execute('SELECT * FROM affect_people WHERE person_id=?', (person_id,)).fetchone()
    result = dict(row) if row else dict(person_id=person_id, name='', affinity=50, emotion='calm', valence=0, arousal=0, updated_at=None)
    if row:
        elapsed = max(0, (now-datetime.fromisoformat(row['updated_at'])).total_seconds())
        factor = 2 ** (-elapsed/7200)  # mood recovers; relationships do not reset overnight.
        result['valence'] = round(row['valence']*factor)
        result['arousal'] = round(row['arousal']*factor)
        if factor < .1:
            result['emotion'] = 'calm'
    result['history'] = [dict(r) for r in db.execute('SELECT * FROM affect_events WHERE person_id=? ORDER BY id DESC LIMIT 30', (person_id,))]
    for event in result['history']:
        event['source_ids'] = json.loads(event['source_ids'])
    return result


def read(person_id, *, now=None):
    with index.connect() as db:
        _tables(db)
        return _snapshot(db,person_id,_now(now))


def people():
    with index.connect() as db:
        _tables(db)
        return [dict(r) for r in db.execute('SELECT person_id,name,affinity,emotion,updated_at FROM affect_people ORDER BY updated_at DESC LIMIT 100')]


def unsettled(project_id, messages):
    with index.connect() as db:
        _tables(db)
        return [m for m in messages if m.get('role') == 'user' and not db.execute('SELECT 1 FROM affect_sources WHERE project_id=? AND message_id=?', (project_id,m['id'])).fetchone()]


def valid(value):
    if not isinstance(value,dict):
        return False
    for key,lo,hi in [('affinity_delta',-2,2),('valence',-100,100),('arousal',0,100)]:
        n=value.get(key)
        if isinstance(n,bool) or not isinstance(n,(int,float)) or not math.isfinite(n) or not lo<=n<=hi:
            return False
    return (isinstance(value.get('emotion'),str) and value['emotion'] in EMOTIONS
            and isinstance(value.get('reason'),str) and 0<len(value['reason'].strip())<=240)


def parse_output(raw):
    text=raw.lstrip()
    if not text or OPEN.startswith(text):
        return '',None
    if not text.startswith(OPEN):
        return raw,None
    end=text.find(CLOSE,len(OPEN))
    if end<0:
        # Fail closed for a malformed reserved header, never send it to TTS.
        return '',None
    body=text[end+len(CLOSE):].lstrip('\r\n ')
    if end>2048:
        return body,None
    try:
        value=json.loads(text[len(OPEN):end])
    except (ValueError,TypeError):
        return body,None
    return body,value if valid(value) else None


def visible_text(raw):
    return parse_output(raw)[0]


def apply(project_id,session_id,sources,value,*,kind='chat',scope='local',now=None):
    if not valid(value) or not sources or len(sources)>20:
        return None
    ids=[str(m['id']) for m in sources if m.get('role')=='user' and m.get('id')]
    persons={subject(m,scope) for m in sources}
    if len(ids)!=len(sources) or len(set(ids))!=len(ids) or len(persons)!=1 or None in persons:
        return None
    person_id=persons.pop(); now=_now(now); stamp=now.isoformat();day=now.date().isoformat()
    fingerprint=hashlib.sha256(' '.join(''.join(str(m.get('content','')).split()).lower() for m in sources).encode()).hexdigest()
    with index.connect() as db:
        _tables(db)
        # connect serializes threads; BEGIN IMMEDIATE also protects another process.
        db.execute('BEGIN IMMEDIATE')
        if any(db.execute('SELECT 1 FROM affect_sources WHERE project_id=? AND message_id=?',(project_id,mid)).fetchone() for mid in ids):
            return None
        before=_snapshot(db,person_id,now)['affinity'];delta=value['affinity_delta']
        positive,negative=db.execute('SELECT COALESCE(SUM(MAX(delta,0)),0), COALESCE(SUM(MIN(delta,0)),0) FROM affect_events WHERE person_id=? AND at>=?', (person_id,day)).fetchone()
        if delta>0:
            repeated=db.execute('SELECT 1 FROM affect_events WHERE person_id=? AND at>=? AND fingerprint=?',(person_id,day,fingerprint)).fetchone()
            delta=0 if repeated else min(delta,max(0,5-positive))
        else:
            delta=max(delta,min(0,-10-negative))
        after=round(max(0,min(100,before+delta)),2);delta=round(after-before,2)
        name=str(sources[-1].get('author_name') or '')[:120]
        db.execute('INSERT INTO affect_people VALUES(?,?,?,?,?,?,?) ON CONFLICT(person_id) DO UPDATE SET name=excluded.name,affinity=excluded.affinity,emotion=excluded.emotion,valence=excluded.valence,arousal=excluded.arousal,updated_at=excluded.updated_at',
                   (person_id,name,after,value['emotion'],value['valence'],value['arousal'],stamp))
        cursor=db.execute('INSERT INTO affect_events(person_id,project_id,session_id,source_ids,kind,delta,before_value,after_value,emotion,reason,at,fingerprint) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
                          (person_id,project_id,session_id,json.dumps(ids),kind,delta,before,after,value['emotion'],value['reason'].strip(),stamp,fingerprint))
        db.executemany('INSERT INTO affect_sources VALUES(?,?,?)',[(project_id,mid,cursor.lastrowid) for mid in ids])
        return _snapshot(db,person_id,now)


def prompt(profile,state):
    return ('[Relationship tone reference]\n'+STYLES[profile.relationship_style]+' '+profile.relationship_preferences+'\n'
            'Current speaker: '+json.dumps({k:state[k] for k in ('affinity','emotion','valence','arousal')})+'\n'
            'Use this state only as a tone reference alongside the configured personality.')


def review_context(project_id,messages,scope):
    pending={m['id'] for m in unsettled(project_id,messages)}
    groups={}
    for message in messages:
        if message.get('role') != 'user':
            continue
        person=subject(message,scope)
        if person:
            group=groups.setdefault(person,{'person_id':person,'unsettled':[]})
            if message['id'] in pending:
                group['unsettled'].append(message['id'])
    return list(groups.values())


def apply_review(project_id,session_id,messages,updates,scope):
    allowed={m['id']:m for m in messages if m.get('role')=='user'}
    results=[]
    for value in updates[:10] if isinstance(updates,list) else []:
        if not isinstance(value,dict):
            continue
        ids=value.get('source_ids')
        if not isinstance(ids,list) or not ids or any(not isinstance(mid,str) or mid not in allowed for mid in ids):
            continue
        value={**value,'emotion':'calm','valence':0,'arousal':0}
        state=apply(project_id,session_id,[allowed[mid] for mid in ids],value,kind='reflection',scope=scope)
        if state:
            results.append({'person_id':state['person_id'],'affinity':state['affinity'],'source_ids':ids,
                            'affinity_delta':state['history'][0]['delta']})
    return results
