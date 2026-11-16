"""Bounded maintenance hints, never a complete session history or read receipt.

Called in a worker thread after the assessment batch has been authorized.
"""
import json
import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from services import digital_person_memory_index as index


def catalog(sessions, project_ids):
    result={'items':[], 'complete':False, 'basis':'bounded_recent_session_sources'}
    allowed=set(project_ids)
    pairs=list(dict.fromkeys((p,s,scope) for p,s,scope in sessions if p in allowed and s and scope))[:64]
    if not pairs:
        return result
    per_session=min(64,max(1,512//len(pairs)))
    seen=set()
    with closing(sqlite3.connect(index.database_path().resolve().as_uri()+"?mode=ro", uri=True, timeout=1)) as db:
        db.row_factory=sqlite3.Row
        for project_id,session_id,scope in pairs:
            # Materialized windows bound both source and relationship scans before
            # filtering knowledge. No COUNT, full summary fetch or global sort.
            rows=db.execute("""
                WITH recent AS MATERIALIZED (
                    SELECT id,scope,forgotten FROM memories
                    WHERE project_id=? AND session_id=?
                    ORDER BY id DESC LIMIT ?
                ), links AS MATERIALIZED (
                    SELECT s.knowledge_id,r.scope FROM recent r
                    JOIN memory_knowledge_sources s ON s.memory_id=r.id WHERE r.forgotten=0 AND r.scope=? LIMIT 128
                )
                SELECT DISTINCT k.id,substr(k.summary,1,40) AS title,
                    substr(k.summary,41,160) AS summary
                FROM links l JOIN memory_knowledge k ON k.id=l.knowledge_id AND k.scope=l.scope
                WHERE k.state IN ('active','conflict')
                  AND (k.valid_until IS NULL OR k.valid_until>?)
                LIMIT 5
                """,(project_id,session_id,per_session,scope,
                       datetime.now(timezone.utc).isoformat())).fetchall()
            count=0
            for row in rows:
                if row['id'] in seen:
                    continue
                item={'id':'knowledge:'+str(row['id']), 'project_id':project_id,
                      'session_id':session_id,'title':row['title'],'summary':row['summary']}
                result['items'].append(item)
                if len(json.dumps(result,ensure_ascii=False).encode('utf-8'))>12000:
                    result['items'].pop()
                    return result
                seen.add(row['id']);count+=1
                if len(result['items'])>=24:
                    return result
                if count>=4:
                    break
    return result
