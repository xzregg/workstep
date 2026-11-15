import asyncio
import json
import pytest
from tests.test_digital_person_unified import runtime, chat_module, seed
from services import memory_query, memory_knowledge as knowledge, digital_person_memory_index as index

async def test_invalid_candidate_is_repaired_before_any_side_effect(runtime,monkeypatch):
    current,project,_=runtime
    await seed(current,project)
    calls=[]
    async def invoke(*args,**kwargs):
        token=kwargs['system_prompt'].split('Pass memory_token=',1)[1].split(' ',1)[0]
        ctx=await memory_query.pending(current.projects,token)
        calls.append(args[3])
        item={'summary':'发布前演练迁移','kind':'preference','outcome':'stated',
              'source_ids':ctx['conversation'][0]['memory_ids'],
              'entities':[{'kind':'person','name':'用户','aliases':[]}],
              'relations':[{'from':'用户','relation':'要求','to':'迁移'}]}
        if len(calls)>1:
            assert 'Invalid relation endpoints' in args[3]
            item['entities'].append({'kind':'object','name':'迁移','aliases':[]})
        return json.dumps({'decision':'silent','summary':'已整理','source_ids':[],'memories':[item]}),[],'native'
    monkeypatch.setattr('agent_assistants.base.invoke_engine',invoke)
    result=await current.check()
    assert result['status']=='silent',result
    assert len(calls)==2
    with index.connect() as db:
        assert db.execute('select count(*) from memory_knowledge').fetchone()[0]==1

async def test_knowledge_full_read_is_required_and_version_bound(runtime):
    current,project,_=runtime
    sid=await seed(current,project)
    ctx=await current._collect()
    mid=ctx['conversation'][0]['memory_ids'][0]
    await asyncio.to_thread(knowledge.store_extraction,{'memories':[{'summary':'发布前演练迁移','kind':'preference','outcome':'stated','source_ids':[mid]}]},ctx['reflection_batch'])
    token=await memory_query.issue_access(current.projects,'local',session_id=sid)
    hit=(await memory_query.search(current.projects,token,query='迁移'))['knowledge'][0]
    assert memory_query.observed_knowledge_versions(token)=={}
    first=await memory_query.read(current.projects,token,hit['id'],limit=5)
    assert first['has_more'] and memory_query.observed_knowledge_versions(token)=={}
    await memory_query.read(current.projects,token,hit['id'],offset=first['next_offset'],limit=6000)
    versions=memory_query.observed_knowledge_versions(token)
    assert hit['id'] in versions
    replacement={'summary':'实验项目可跳过演练，正式发布仍须演练','kind':'preference','outcome':'stated',
                 'source_ids':[mid],'supersedes':[hit['id']]}
    with index.connect() as db:
        db.execute("update memory_knowledge set summary='已被另一轮更新' where id=?",(int(hit['id'].split(':')[1]),))
    with pytest.raises(ValueError,match='旧知识已变化'):
        await asyncio.to_thread(knowledge.store_extraction,{'memories':[replacement]},ctx['reflection_batch'],versions,strict=True)
    with index.connect() as db:
        assert db.execute('select count(*) from memory_knowledge').fetchone()[0]==1
        assert db.execute('select count(*) from memory_changes where old_id is not null').fetchone()[0]==0


async def test_background_cannot_scan_history_or_read_old_raw_messages(runtime):
    current,project,_=runtime
    sid=await seed(current,project)
    ctx=await current._collect()
    token=await memory_query.issue_access(current.projects,'local',session_id=sid)
    memory_query.bind_assessment(token,ctx)
    for operation in (memory_query.search(current.projects,token),
                      memory_query.search(current.projects,token,query='   '),
                      memory_query.history(current.projects,token),
                      memory_query.search(current.projects,token,query='迁移',include_sources=True),
                      memory_query.read(current.projects,token,ctx['conversation'][0]['memory_ids'][0])):
        with pytest.raises(PermissionError):
            await operation


async def test_search_only_does_not_authorize_replacement(runtime):
    from services.memory_policy import validate_memories
    current,project,_=runtime
    sid=await seed(current,project)
    ctx=await current._collect()
    item={'summary':'发布前演练迁移','kind':'preference','outcome':'stated',
          'source_ids':ctx['conversation'][0]['memory_ids']}
    await asyncio.to_thread(knowledge.store_extraction,{'memories':[item]},ctx['reflection_batch'])
    token=await memory_query.issue_access(current.projects,'local',session_id=sid)
    hit=(await memory_query.search(current.projects,token,query='迁移'))['knowledge'][0]
    with pytest.raises(ValueError,match='fully read'):
        validate_memories({'memories':[dict(item,supersedes=[hit['id']])]},ctx,memory_query.observed_knowledge_versions(token))


async def test_failed_repair_keeps_batch_pending_and_no_knowledge(runtime,monkeypatch):
    current,project,_=runtime
    await seed(current,project)
    calls=[]
    async def invoke(*args,**kwargs):
        token=kwargs['system_prompt'].split('Pass memory_token=',1)[1].split(' ',1)[0]
        await memory_query.pending(current.projects,token)
        calls.append(args[3])
        return json.dumps({'decision':'silent','summary':'无效','source_ids':[],
                           'memories':[{'summary':'无依据','kind':'fact','source_ids':[]}]}),[],'native'
    monkeypatch.setattr('agent_assistants.base.invoke_engine',invoke)
    result=await current.check()
    assert result['status']=='failed',result
    assert len(calls)==2
    with index.connect() as db:
        assert db.execute('select count(*) from memory_knowledge').fetchone()[0]==0
        assert db.execute("select count(*) from memories where memory_status='done'").fetchone()[0]==0


async def test_slow_knowledge_read_does_not_block_event_loop(runtime,monkeypatch):
    import time
    current,project,_=runtime
    sid=await seed(current,project)
    ctx=await current._collect()
    await asyncio.to_thread(knowledge.store_extraction,{'memories':[{'summary':'发布前演练迁移','kind':'preference','outcome':'stated',
        'source_ids':ctx['conversation'][0]['memory_ids']}]},ctx['reflection_batch'])
    token=await memory_query.issue_access(current.projects,'local',session_id=sid)
    hit=(await memory_query.search(current.projects,token,query='迁移'))['knowledge'][0]
    original=knowledge.read_record
    def slow(*args):
        time.sleep(.15)
        return original(*args)
    monkeypatch.setattr(knowledge,'read_record',slow)
    task=asyncio.create_task(memory_query.read(current.projects,token,hit['id']))
    await asyncio.sleep(.03)
    assert not task.done()
    assert (await task)['content']
