import asyncio
import pytest
from tests.test_chat_session import chat_module
from tests.test_digital_person_runtime import runtime
from models.chat_session import ChatMessage
from models.fields import utc_now


def test_memory_directory_is_an_instance_data_directory(tmp_path,monkeypatch):
    from services import config
    from services import digital_person_memory_index as index
    monkeypatch.setattr(config,'CONFIG_DIR',tmp_path/'instance')
    assert index.database_path()==tmp_path/'instance'/'Memory'/'memory.db'
    with index.connect() as db:
        assert db.execute("SELECT name FROM sqlite_master WHERE name='memories'").fetchone()
    assert (index.database_path().parent/'README.md').is_file()


async def test_global_index_and_original_content_live_in_different_databases(runtime, tmp_path, monkeypatch):
    from services import digital_person_memory as memory, digital_person_memory_index as index
    current, home, _ = runtime
    other = await asyncio.to_thread(current.projects.init_project, tmp_path/'source-project')
    prompts = []
    async def invoke(*args, **kwargs):
        prompts.append(kwargs.get('system_prompt', ''))
        return '收到', [], 'thread'
    monkeypatch.setattr('agent_assistants.base.invoke_engine', invoke)
    sid = await current.projects.run_db(other.id, lambda _: current.chats.create_session(other.id)['id'])
    turn = await current.projects.run_db(other.id, lambda _: current.chats.submit_message(other.id, sid, '星河发布前必须执行完整回归测试。', 'seed', schedule=False))
    current.chats.start_queued_turn(turn.turn_id)
    await current.chats.await_turn(turn.turn_id, timeout=5)
    assert index.database_path().exists()
    assert not await current.projects.run_db(other.id, lambda _: 'digital_memory_chunks' in other.db.get_tables())
    hits = [h for h in await memory.recall_projects(current.projects, 'local', '') if h['role']=='user']
    assert hits and hits[0]['project_id'] == other.id
    assert hits[0]['session_id'] == sid
    assert '完整回归测试' in hits[0]['content']
    # The full text is read from the source DB, never trusted from the index.
    await current.projects.run_db(other.id, lambda _: ChatMessage.update(content='星河发布改为执行增量测试。').where(ChatMessage.id == hits[0]['source_message_id']).execute())
    refreshed = [h for h in await memory.recall_projects(current.projects, 'local', '') if h['role']=='user']
    assert refreshed and '增量测试' in refreshed[0]['content']
    assert '完整回归测试' not in refreshed[0]['content']
    await current.projects.run_db(other.id, lambda _: ChatMessage.delete().where(ChatMessage.id == hits[0]['source_message_id']).execute())
    assert not [h for h in await memory.recall_projects(current.projects, 'local', '') if h['role']=='user']


async def test_global_index_follows_config_directory_and_has_no_raw_content(runtime, monkeypatch, tmp_path):
    from services import digital_person_memory as memory, digital_person_memory_index as index
    current, project, _ = runtime
    sid = (await current.main_session())['id']
    secret_tail = '只有来源数据库才有的完整原话结尾'
    text = '星河项目的发布经验。' * 25 + secret_tail
    def seed(_):
        ChatMessage.create(id='original', session=sid, role='user', status='completed', content=text, created_at=utc_now())
        memory.capture_session(sid, 'local')
    await current.projects.run_db(project.id, seed)
    with index.connect() as db:
        row = dict(db.execute('SELECT * FROM memories LIMIT 1').fetchone())
        assert row['project_id'] == project.id
        assert 'content' not in row
        assert secret_tail not in str(row)


async def test_legacy_classification_forgetting_and_thought_references_migrate_once(runtime):
    from services import digital_person_memory as memory, digital_person_memory_index as index
    from models.digital_person_memory import DigitalMemoryChunk, DigitalMemoryActivation, DigitalMemorySearch
    current, project, _ = runtime
    sid = (await current.main_session())['id']
    def seed(_):
        project.db.create_tables([DigitalMemoryChunk,DigitalMemoryActivation,DigitalMemorySearch])
        for mid,text in [('keep','喜欢天文摄影'),('forget','某段要忘记的生日资料')]:
            ChatMessage.create(id=mid,session=sid,role='user',status='completed',content=text,created_at=utc_now())
        a=DigitalMemoryChunk.create(source='keep',scope='local',content='喜欢天文摄影',category='long',importance=.9,reinforcements=3)
        DigitalMemoryActivation.create(chunk=a.id,event_key='old-input')
        DigitalMemoryChunk.create(source='forget',scope='local',content='',forgotten=True)
        return a.id
    old_id=await current.projects.run_db(project.id,seed)
    # Force new global IDs to differ from project-local IDs.
    await asyncio.to_thread(index.capture,'unused','unused','unused','other','user','占位','2026-01-01T00:00:00+00:00')
    await current.mutate(lambda s:s.update(companions={'local':{'thought':{'source_ids':['memory:'+str(old_id)]}}}))
    await current.projects.run_db(project.id,lambda _:memory.migrate_legacy(project.id))
    hits=await memory.recall_projects(current.projects,'local','')
    assert len(hits)==1 and hits[0]['category']=='long' and hits[0]['reinforcements']==3
    assert (await current.state())['companions']['local']['thought']['source_ids']==[hits[0]['id']]
    assert all(h['source_message_id']!='forget' for h in await memory.recall_projects(current.projects,'local',''))
    await current.projects.run_db(project.id,lambda _:memory.migrate_legacy(project.id))
    await asyncio.to_thread(index.reinforce,int(hits[0]['id'].removeprefix('memory:')),project.id+':old-input')
    assert (await memory.recall_projects(current.projects,'local',''))[0]['reinforcements']==3


async def test_other_project_history_requires_explicit_tool_search_from_main_chat(runtime,tmp_path,monkeypatch):
    from services import digital_person_memory as memory
    current,home,_=runtime
    other=await asyncio.to_thread(current.projects.init_project,tmp_path/'historical')
    def seed(_):
        sid=current.chats.create_session(other.id)['id']
        ChatMessage.create(id='old-project-message',session=sid,role='user',status='completed',content='北辰发布必须回归验证。',created_at=utc_now())
    await current.projects.run_db(other.id,seed)
    await memory.sync_projects(current.projects)
    main=(await current.main_session())['id']
    prompts=[]
    async def invoke(*args,**kwargs):
        prompts.append(kwargs.get('system_prompt',''))
        return '知道了',[],'thread'
    monkeypatch.setattr('agent_assistants.base.invoke_engine',invoke)
    turn=await current.projects.run_db(home.id,lambda _:current.chats.submit_message(home.id,main,'北辰发布要注意什么？','ask',schedule=False))
    current.chats.start_queued_turn(turn.turn_id)
    await current.chats.await_turn(turn.turn_id,timeout=5)
    assert '北辰发布必须回归验证' not in prompts[0]
    assert 'Relevant memories' not in prompts[0]
    assert 'memory search' in prompts[0]
    # The model can choose to call the authorized tools after seeing the prompt.
    from services import memory_query
    token=prompts[0].split('Pass memory_token=',1)[1].split(' ',1)[0]
    from services import digital_person_memory_index as index, memory_knowledge as knowledge
    rows=await asyncio.to_thread(index.candidates,'local',project_ids=[other.id])
    await asyncio.to_thread(knowledge.store_extraction,{'memories':[{'summary':'北辰发布必须回归验证。',
        'kind':'fact','outcome':'stated','source_ids':['memory:'+str(rows[0]['id'])]}]},rows)
    found=await memory_query.search(current.projects,token,query='北辰发布')
    hit=next(source for item in found['knowledge'] for source in item['sources'] if source['project_id']==other.id)
    original=await memory_query.read(current.projects,token,hit['id'])
    assert original['content']=='北辰发布必须回归验证。'
    context=await current._collect()
    # Foreground recall remains available; a heartbeat does not automatically
    # attach unrelated project history to its pending source batch.
    assert context['memory']==[]
    assert context['origin_project_id'] in (home.id,other.id)
    assert all(m['session_id']==context['origin_session_id'] for m in context['conversation'])


@pytest.mark.parametrize('actor_source',['remote_project','browser','channel'])
async def test_global_memory_never_reads_removed_or_unauthorized_project(runtime,tmp_path,actor_source):
    from services import digital_person_memory as memory
    from services.remote_access import ActorSnapshot,actor_context
    current,home,_=runtime
    other=await asyncio.to_thread(current.projects.init_project,tmp_path/'private')
    def seed(_):
        sid=current.chats.create_session(other.id)['id']
        ChatMessage.create(id='private',session=sid,role='user',status='completed',content='秘密项目天文摄影计划。',created_at=utc_now())
        memory.capture_session(sid,'local')
    await current.projects.run_db(other.id,seed)
    actor=ActorSnapshot(actor_id='u',user_name='u',device_id='d',device_name='d',source=actor_source,project_id=home.id,access_level='edit')
    with actor_context(actor):
        assert await memory.recall_projects(current.projects,'local','')==[]
    assert await memory.recall_projects(current.projects,'local','')
    await asyncio.to_thread(current.projects.unregister,other.id)
    assert await memory.recall_projects(current.projects,'local','')==[]


@pytest.mark.parametrize('locked_database',['global','source'])
async def test_global_memory_lock_does_not_block_health_api(runtime,monkeypatch,locked_database):
    import threading
    import sqlite3
    import main
    from fastapi import FastAPI
    from httpx import AsyncClient,ASGITransport
    from api.digital_person import router
    from services import digital_person_memory_index as index, digital_person_memory as memory
    current,project,_=runtime
    sid=(await current.main_session())['id']
    def seed(_):
        ChatMessage.create(id='lock-evidence',session=sid,role='user',status='completed',content='索引回查原文的依据。',created_at=utc_now())
        memory.capture_session(sid,'local')
    await current.projects.run_db(project.id,seed)
    if locked_database == 'source':
        await current.projects.run_db(project.id,lambda _:project.db.execute_sql('PRAGMA journal_mode=DELETE').fetchone())
    monkeypatch.setattr(main,'digital_person_runtime',current)
    entered,release=threading.Event(),threading.Event()
    def hold():
        db=sqlite3.connect(index.database_path() if locked_database=='global' else project.db_path)
        db.execute('BEGIN EXCLUSIVE')
        entered.set()
        assert release.wait(3)
        db.rollback();db.close()
    holder=asyncio.create_task(asyncio.to_thread(hold))
    assert await asyncio.to_thread(entered.wait,2)
    app=FastAPI();app.include_router(router)
    @app.get('/health')
    async def health(): return {'ok':True}
    async with AsyncClient(transport=ASGITransport(app),base_url='http://test') as client:
        pending=asyncio.create_task(client.get('/api/digital-person/memory'))
        try:
            await asyncio.sleep(.05)
            assert not pending.done(), 'the database request must actually be waiting on the lock'
            assert (await asyncio.wait_for(client.get('/health'),.3)).status_code==200
        finally:
            release.set()
        await holder
        assert (await pending).status_code==200
