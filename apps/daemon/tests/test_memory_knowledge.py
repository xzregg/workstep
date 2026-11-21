from tests.memory_turn_fixture import create_completed_user
import asyncio
import hashlib
import time

import pytest

from services import config, digital_person_memory_index as index
from tests.test_chat_session import chat_module
from tests.test_digital_person_runtime import runtime


@pytest.fixture
def knowledge(tmp_path, monkeypatch):
    monkeypatch.setattr(config, 'CONFIG_DIR', tmp_path)
    from services import memory_knowledge
    memory_knowledge.ensure_schema()
    return memory_knowledge


def seed(text='用户喜欢清晨工作', scope='local'):
    return next(iter(index.capture('p', 's', str(time.time_ns()), scope, 'user', text, '2026-11-01T00:00:00+00:00').values()))


def payload(mid, **extra):
    return {'memories': [dict(summary='用户喜欢清晨工作', kind='preference', outcome='stated',
                             source_ids=[f'memory:{mid}'], entities=[{'kind':'person','name':'用户','aliases':['本人']}], **extra)]}


def test_accept_only_bound_evidence_and_source_version(knowledge):
    mid = seed()
    rows = index.candidates('local')
    assert knowledge.store_extraction(payload(mid), rows) == 1
    assert knowledge.store_extraction(payload(999), rows) == 0
    with index.connect() as db:
        assert db.execute('SELECT summary FROM memory_knowledge').fetchone()[0] == '用户喜欢清晨工作'
    # A source edit invalidates derived knowledge immediately.
    with index.connect() as db:
        db.execute('UPDATE memories SET source_hash=? WHERE id=?', ('changed', mid))
        assert db.execute('SELECT state FROM memory_knowledge').fetchone()[0] == 'invalid'
    assert knowledge.store_extraction(payload(mid), rows) == 0


def test_forgotten_and_deleted_sources_invalidate_knowledge(knowledge):
    mid = seed()
    assert knowledge.store_extraction(payload(mid), index.candidates('local')) == 1
    index.forget(mid)
    with index.connect() as db:
        assert db.execute('SELECT state FROM memory_knowledge').fetchone()[0] == 'invalid'
        assert db.execute('SELECT summary FROM memory_knowledge').fetchone()[0] == ''
        assert db.execute('SELECT count(*) FROM memory_knowledge_search').fetchone()[0] == 0
        assert db.execute('SELECT count(*) FROM memory_entities').fetchone()[0] == 0
    mid = seed()
    knowledge.store_extraction(payload(mid), index.candidates('local'))
    with index.connect() as db:
        db.execute('DELETE FROM memories WHERE id=?', (mid,))
        assert not db.execute("SELECT 1 FROM memory_knowledge WHERE state='active'").fetchone()


def test_correction_scope_and_expiry_validation(knowledge):
    mid = seed()
    knowledge.store_extraction(payload(mid), index.candidates('local'))
    next_mid = seed('用户改成晚上工作')
    value = payload(next_mid, supersedes=['knowledge:1'])
    assert knowledge.store_extraction(value, index.candidates('local'), ['knowledge:1']) == 1
    with index.connect() as db:
        assert db.execute('SELECT state FROM memory_knowledge WHERE id=1').fetchone()[0] == 'superseded'
    foreign = seed('陌生渠道的用户', 'channel:other')
    assert knowledge.store_extraction(payload(foreign, supersedes=['knowledge:2']), index.candidates('channel:other')) == 0
    assert knowledge.store_extraction(payload(next_mid, valid_until='not a date'), index.candidates('local')) == 0


async def test_atlas_exposes_recorded_conflict_link(knowledge, monkeypatch):
    from services import digital_person_memory, memory_atlas
    monkeypatch.setattr(digital_person_memory, 'allowed_projects', lambda _: ['p'])
    first = seed()
    assert knowledge.store_extraction(payload(first), index.candidates('local')) == 1
    second = seed('用户表示对早晚时间仍有不同看法')
    conflict = payload(second, supersedes=['knowledge:1'], conflict=True)
    assert knowledge.store_extraction(conflict, index.candidates('local'), ['knowledge:1']) == 1
    page = await memory_atlas.page(None, 0, 10)
    assert {row['id'] for row in page['items']} == {'knowledge:1', 'knowledge:2'}
    assert page['links'] == [{'from': 'knowledge:1', 'to': 'knowledge:2'}]
    assert all('supersedes' not in row for row in page['items']), 'star lists remain lightweight'


async def test_consolidation_runs_db_off_loop_and_retries(knowledge, monkeypatch):
    mid = seed()
    class Projects:
        def iter_projects(self):
            return [type('Project', (), {'id':'p'})()]
    async def read(projects, rows, query=''):
        return [{'id':f"memory:{r['id']}", 'content':'用户喜欢清晨工作', 'role':'user'} for r in rows]
    monkeypatch.setattr('services.digital_person_memory.read_projects', read)
    original = knowledge._claim
    def slow(*args):
        time.sleep(.06)
        return original(*args)
    monkeypatch.setattr(knowledge, '_claim', slow)
    ticks = []
    async def canary():
        for _ in range(10):
            ticks.append(time.monotonic())
            await asyncio.sleep(.01)
    async def extract(rows, existing):
        return payload(mid)
    result, _ = await asyncio.gather(knowledge.consolidate_batch(Projects(), extractor=extract), canary())
    assert result['created'] == 1
    assert max(b-a for a,b in zip(ticks,ticks[1:])) < .05
    assert (await knowledge.consolidate_batch(Projects(), extractor=extract))['processed'] == 0


async def test_failure_has_persistent_backoff_and_does_not_mark_done(knowledge, monkeypatch):
    mid = seed()
    class Projects:
        def iter_projects(self):
            return [type('Project', (), {'id':'p'})()]
    async def read(projects, rows, query=''):
        return [{'id':f"memory:{r['id']}", 'content':'用户喜欢清晨工作'} for r in rows]
    monkeypatch.setattr('services.digital_person_memory.read_projects', read)
    async def fail(rows, existing):
        raise RuntimeError('secret raw model response')
    result = await knowledge.consolidate_batch(Projects(), extractor=fail)
    assert result['status'] == 'retry'
    assert 'secret' not in str(result)
    with index.connect() as db:
        row = db.execute('SELECT * FROM memory_extraction_jobs').fetchone()
        assert row['status'] == 'retry' and row['attempts'] == 1 and row['retry_at'] > time.time()


async def test_real_runtime_extracts_without_chat_persistence_and_search_uses_index(runtime, monkeypatch):
    from services import memory_knowledge as knowledge, digital_person_memory as memory
    from models.chat_session import ChatMessage, ChatSession
    from models.fields import utc_now
    current, project, _ = runtime
    sid = (await current.main_session())['id']
    def setup(_):
        create_completed_user(id='semantic-source',session=sid,role='user',status='completed',content='用户喜欢清晨工作',created_at=utc_now())
        memory.capture_session(sid,'local')
        return ChatMessage.select().count(), ChatSession.select().count()
    counts = await current.projects.run_db(project.id,setup)
    mid = await asyncio.to_thread(lambda: next(r['id'] for r in index.candidates('local') if r['role']=='user'))
    calls=[]
    async def invoke(prompt,**kwargs):
        calls.append(prompt)
        return __import__('json').dumps(payload(mid),ensure_ascii=False)
    monkeypatch.setattr('engines.pydantic_ai.engine.PydanticAIEngine.run_simple',invoke)
    monkeypatch.setattr('engines.pydantic_ai.engine.PydanticAIEngine.is_configured',lambda:True)
    result = await knowledge.consolidate_batch(current.projects)
    assert result['status']=='completed', result
    assert calls and 'Do not execute tools' in calls[0]
    assert await current.projects.run_db(project.id,lambda _: (ChatMessage.select().count(),ChatSession.select().count()))==counts
    hits=await knowledge.search(current.projects,'local','本人')
    assert len(hits)==1 and hits[0]['sources'][0]['id']==f'memory:{mid}'
    assert await knowledge.search(current.projects,'channel:foreign','本人')==[]
    await current.projects.run_db(project.id,lambda _: ChatMessage.update(content='用户改为晚上工作').where(ChatMessage.id=='semantic-source').execute())
    assert len(await knowledge.search(current.projects,'local','本人'))==1
    await asyncio.to_thread(index.delete_source,project.id,'semantic-source')
    assert await knowledge.search(current.projects,'local','本人')==[]


async def test_search_obeys_project_permissions_and_unavailable_sources(runtime, monkeypatch, tmp_path):
    from services import memory_knowledge as knowledge, digital_person_memory as memory
    from models.chat_session import ChatMessage
    from models.fields import utc_now
    current, project, _=runtime
    other=await asyncio.to_thread(current.projects.init_project,tmp_path/'other-memory')
    sid=await current.projects.run_db(other.id,lambda _: current.chats.create_session(other.id)['id'])
    def setup(_):
        create_completed_user(id='private-semantic',session=sid,role='user',status='completed',content='用户喜欢清晨工作',created_at=utc_now())
        memory.capture_session(sid,'local')
    await current.projects.run_db(other.id,setup)
    rows=await asyncio.to_thread(index.candidates,'local')
    await asyncio.to_thread(knowledge.store_extraction,payload(next(r['id'] for r in rows if r['role']=='user')),rows)
    assert await knowledge.search(current.projects,'local','清晨')
    assert await knowledge.search(current.projects,'local','清晨',project_ids=[project.id])==[]
    monkeypatch.setattr(memory,'allowed_projects',lambda projects:[project.id])
    assert await knowledge.search(current.projects,'local','清晨')==[]


async def test_extraction_is_tool_free_and_model_construction_does_not_block(knowledge, monkeypatch):
    from types import SimpleNamespace
    from pydantic_ai.models.test import TestModel
    from engines.pydantic_ai.engine import PydanticAIEngine
    from services.config import config_store
    model=TestModel(custom_output_text='{"memories":[]}')
    monkeypatch.setattr(PydanticAIEngine,'is_installed',lambda:True)
    monkeypatch.setattr(PydanticAIEngine,'is_configured',lambda:True)
    monkeypatch.setattr(config_store,'get_pydantic_ai_engine_config',lambda:{'provider_id':'configured','model':'configured-model'})
    monkeypatch.setattr(config_store,'get_provider',lambda pid:{'id':pid,'base_url':'https://example.invalid'})
    monkeypatch.setattr(PydanticAIEngine,'resolve_provider_runtime',lambda *a,**kw:SimpleNamespace(provider_id='configured',protocol='openai_chat'))
    def build(**kwargs):
        assert kwargs['provider']['id']=='configured'
        time.sleep(.06)
        return model
    monkeypatch.setattr(PydanticAIEngine,'build_model',build)
    ticks=[]
    async def canary():
        for _ in range(15):
            ticks.append(time.monotonic())
            await asyncio.sleep(.01)
    result,_=await asyncio.gather(knowledge._extract_with_runtime(None,None,[],[]),canary())
    assert result=={'memories':[]}
    assert model.last_model_request_parameters.function_tools==[]
    assert model.last_model_request_parameters.native_tools==[]
    assert max(b-a for a,b in zip(ticks,ticks[1:])) < .05


async def test_no_configured_model_is_explicit_and_does_not_call_llm(knowledge, monkeypatch):
    monkeypatch.setattr('engines.pydantic_ai.engine.PydanticAIEngine.is_configured',lambda:False)
    with pytest.raises(knowledge.ModelUnavailable):
        await knowledge._extract_with_runtime(None,None,[],[])


def test_authorization_filter_precedes_candidate_limit(knowledge):
    own=seed()
    knowledge.store_extraction(payload(own),index.candidates('local'))
    for num in range(12):
        mid=next(iter(index.capture('foreign','foreign-session',f'foreign-{num}','local','user','用户喜欢清晨工作','2026-11-02T00:00:00+00:00').values()))
        knowledge.store_extraction(payload(mid),index.candidates('local'))
    rows=knowledge._candidates('local','清晨',1,{'p'},None,None)
    assert len(rows)==1 and rows[0]['sources'][0]['id']==own


def test_expired_memory_and_unknown_correction_are_not_used(knowledge):
    mid=seed()
    knowledge.store_extraction(payload(mid,valid_until='2000-01-01T00:00:00+00:00'),index.candidates('local'))
    assert knowledge._candidates('local','',20,{'p'},None,None)==[]
    assert knowledge.store_extraction(payload(mid,supersedes=['knowledge:1']),index.candidates('local'))==0


def test_queue_status_counts_only_current_nonforgotten_registered_sources(knowledge):
    mid=seed()
    assert knowledge.queue_status(['p'])=={'pending':1,'leased':0,'retry':0,'done':0}
    rows=knowledge._claim(['p'],8)
    assert knowledge.queue_status(['p'])['leased']==1
    knowledge._finish_jobs(rows,False)
    assert knowledge.queue_status(['p'])['retry']==1
    assert knowledge.queue_status(['other'])=={'pending':0,'leased':0,'retry':0,'done':0}
    with index.connect() as db:
        db.execute('UPDATE memories SET source_hash=? WHERE id=?',('new',mid))
    assert knowledge.queue_status(['p'])['pending']==1
    index.forget(mid)
    assert sum(knowledge.queue_status(['p']).values())==0


def test_metadata_changes_invalidate_knowledge_and_requeue_same_text(knowledge):
    mid=seed()
    rows=knowledge._claim(['p'],8)
    knowledge.store_extraction(payload(mid),rows)
    knowledge._finish_jobs(rows,True)
    with index.connect() as db:
        db.execute('UPDATE memories SET role=? WHERE id=?',('assistant',mid))
        assert db.execute('SELECT state FROM memory_knowledge').fetchone()[0]=='invalid'
    assert knowledge.queue_status(['p'])['pending']==1
    assert knowledge.store_extraction(payload(mid),rows)==0
    value=payload(mid)
    value['memories'][0].update(kind='event',outcome='reported')
    assert knowledge.store_extraction(value,index.candidates('local'))==1


def test_forgetting_overlapping_chunk_clears_all_derived_source_knowledge(knowledge):
    mids=index.capture('p','s','long','local','user','用户喜欢清晨工作'*200,'2026-11-01T00:00:00+00:00')
    assert len(mids)==1
    first=second=next(iter(mids.values()))
    rows=index.candidates('local')
    knowledge.store_extraction(payload(second),rows)
    index.forget(first)
    with index.connect() as db:
        row=db.execute('SELECT * FROM memory_knowledge').fetchone()
        assert row['state']=='invalid' and row['summary']==''
    assert sum(knowledge.queue_status(['p']).values())==0
    assert knowledge.store_extraction(payload(second),rows)==0


def test_upgrade_pre_source_kind_database_before_installing_triggers(tmp_path,monkeypatch):
    import sqlite3
    from services import memory_knowledge as knowledge
    monkeypatch.setattr(config,'CONFIG_DIR',tmp_path)
    path=index.database_path()
    path.parent.mkdir(parents=True)
    # Real pre-change SQLite schema, not a mock of the migration.
    with sqlite3.connect(path) as db:
        db.execute('''CREATE TABLE memories (
          id INTEGER PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT NOT NULL,
          source_message_id TEXT NOT NULL, offset INTEGER NOT NULL, scope TEXT NOT NULL,
          summary TEXT NOT NULL, source_hash TEXT NOT NULL, role TEXT NOT NULL,
          source_time TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'episodic',
          importance REAL NOT NULL DEFAULT .5, reinforcements INTEGER NOT NULL DEFAULT 0,
          activated_at TEXT NOT NULL, forgotten INTEGER NOT NULL DEFAULT 0,
          UNIQUE(project_id,source_message_id,offset))''')
    knowledge.ensure_schema()
    mid=seed()
    assert knowledge.store_extraction(payload(mid),index.candidates('local'))==1
    knowledge.ensure_schema()  # Restart-safe and idempotent.
    with index.connect() as db:
        assert {'source_kind','source_metadata_json'}.issubset({r['name'] for r in db.execute('PRAGMA table_info(memories)')})
        db.execute('UPDATE memories SET source_metadata_json=? WHERE id=?',('{"outcome":"failed"}',mid))
        assert db.execute('SELECT state FROM memory_knowledge').fetchone()[0]=='invalid'


async def test_extractor_sees_old_related_preference_among_newer_unrelated_memories(knowledge,monkeypatch):
    texts={}
    class Projects:
        def iter_projects(self):
            return [type('Project',(),{'id':pid})() for pid in ('p','other')]
    def add(text,project_id='p'):
        mid=next(iter(index.capture(project_id,'s',str(time.time_ns()),'local','user',text,'2026-11-01T00:00:00+00:00').values()))
        texts[mid]=text
        data=payload(mid)
        data['memories'][0]['summary']=text
        knowledge.store_extraction(data,index.candidates('local'))
        with index.connect() as db:
            row=dict(db.execute('SELECT * FROM memories WHERE id=?',(mid,)).fetchone())
            db.execute("INSERT INTO memory_extraction_jobs VALUES(?,?,'done',1,0)",(mid,row['source_hash']))
        return mid
    old=add('用户喜欢小提琴音乐，晚上练习小提琴。','other')
    for num in range(60):
        add(f'用户完成软件构建任务编号 {num}。')
    fresh=seed('用户小提琴练习时间改成早晨。')
    texts[fresh]='用户小提琴练习时间改成早晨。'
    async def read(projects,rows,query=''):
        return [{'id':f"memory:{r['id']}",'content':texts[r['id']],'role':'user'} for r in rows]
    monkeypatch.setattr('services.digital_person_memory.read_projects',read)
    seen=[]
    async def extract(rows,existing):
        seen.extend(existing)
        return {'memories':[]}
    result=await knowledge.consolidate_batch(Projects(),extractor=extract)
    assert result['status']=='completed'
    assert any(item['sources'][0]['id']==f'memory:{old}' for item in seen)
    assert len(seen)<=12


def test_assistant_claim_cannot_become_user_fact_or_override_user(knowledge):
    mid=seed('用户明确要求只在本任务关闭测试')
    assert knowledge.store_extraction(payload(mid),index.candidates('local'))==1
    aid=next(iter(index.capture('p','s','assistant-claim','local','assistant','用户永远不需要测试','2026-11-02T00:00:00+00:00').values()))
    rows=index.candidates('local')
    assert knowledge.store_extraction(payload(aid),rows)==0
    value=payload(aid,supersedes=['knowledge:1'])
    value['memories'][0].update(kind='event',outcome='reported')
    assert knowledge.store_extraction(value,rows,['knowledge:1'])==0


def test_experience_requires_applicability_action_and_result(knowledge):
    mid=seed('本次修改后用户指出部署仍用旧资源；重新构建并验证资源哈希后恢复')
    value=payload(mid)
    value['memories'][0].update(kind='experience',outcome='reported')
    rows=index.candidates('local')
    assert knowledge.store_extraction(value,rows)==0
    value['memories'][0]['experience']={'situation':'服务仍使用旧资源','action':'重建并核对实际加载资源哈希','result':'用户确认恢复'}
    assert knowledge.store_extraction(value,rows)==1


async def test_empty_extraction_is_done_and_duplicate_does_not_retry(knowledge,monkeypatch):
    mid=seed()
    class Projects:
        def iter_projects(self):
            return [type('Project',(),{'id':'p'})()]
    async def read(projects,rows,query=''):
        return [{'id':f"memory:{r['id']}",'content':'用户喜欢清晨工作','role':'user'} for r in rows]
    monkeypatch.setattr('services.digital_person_memory.read_projects',read)
    async def empty(rows,existing):return {'memories':[]}
    result=await knowledge.consolidate_batch(Projects(),extractor=empty)
    assert result['status']=='completed' and result['created']==0
    assert (await knowledge.consolidate_batch(Projects(),extractor=empty))['status']=='idle'
    # Replayed valid extraction after a crash is completion, not invalid output.
    other=seed()
    knowledge.store_extraction(payload(other),index.candidates('local'))
    async def repeated(rows,existing):return payload(other)
    result=await knowledge.consolidate_batch(Projects(),extractor=repeated)
    assert result['status']=='completed' and result['created']==0


def test_late_notification_exclusion_invalidates_previously_indexed_output(knowledge):
    from services.digital_person_reflection import ignore
    mid=next(iter(index.capture('p','s','notice','local','assistant','自动通知摘要','2026-11-14T00:00:00+00:00').values()))
    value=payload(mid)
    value['memories'][0].update(kind='event',outcome='reported')
    assert knowledge.store_extraction(value,index.candidates('local'))==1
    ignore('p','notice')
    ignore('p','notice')
    assert index.candidates('local')==[]
    assert index.capture('p','s','notice','local','assistant','自动通知摘要','2026-11-14T00:00:00+00:00')=={}
    with index.connect() as db:
        assert db.execute('SELECT state FROM memory_knowledge').fetchone()[0]=='invalid'


def test_crashed_extraction_lease_recovers_old_source_without_repeating_done(knowledge,monkeypatch):
    mid=seed()
    now=time.time()
    monkeypatch.setattr('services.memory_knowledge.time.time',lambda:now)
    rows=knowledge._claim(['p'],8)
    assert [row['id'] for row in rows]==[mid]
    assert knowledge._claim(['p'],8)==[]
    # A process dies with an in-flight claim; its durable lease later expires.
    monkeypatch.setattr('services.memory_knowledge.time.time',lambda:now+241)
    recovered=knowledge._claim(['p'],8)
    assert [row['id'] for row in recovered]==[mid]
    knowledge._finish_jobs(recovered,True)
    monkeypatch.setattr('services.memory_knowledge.time.time',lambda:now+86400)
    assert knowledge._claim(['p'],8)==[]


async def test_model_http_status_is_recorded_without_response_or_credentials(knowledge,monkeypatch):
    seed()
    class Projects:
        def iter_projects(self):return [type('Project',(),{'id':'p'})()]
    async def read(projects,rows,query=''):
        return [{'id':f"memory:{r['id']}",'content':'用户喜欢清晨工作'} for r in rows]
    monkeypatch.setattr('services.digital_person_memory.read_projects',read)
    class ModelHTTPError(RuntimeError):status_code=502
    async def fail(rows,existing):raise ModelHTTPError('secret response with private evidence')
    result=await knowledge.consolidate_batch(Projects(),extractor=fail)
    assert result['error']=='ModelHTTPError' and result['http_status']==502
    assert 'secret' not in str(result) and 'private' not in str(result)


def test_extracted_memory_cannot_persist_execution_capability(knowledge):
    mid=seed()
    secret='wsm_'+'a'*43
    item=payload(mid)
    item['memories'][0]['summary']='用户提到了 '+secret
    assert knowledge.store_extraction(item,index.candidates('local'))==1
    with index.connect() as db:
        stored=db.execute('select summary from memory_knowledge').fetchone()[0]
    assert secret not in stored and '[REDACTED_MEMORY_TOKEN]' in stored
