from tests.memory_turn_fixture import assessment_access
import asyncio
import json
import pytest
from tests.test_digital_person_unified import runtime, chat_module, seed
from services import memory_query, memory_knowledge as knowledge, digital_person_memory_index as index


def test_compact_memory_policy_reaches_assessment_extractor_and_repair():
    from services.memory_policy import COMPACT_RULES, RULES, repair_instruction
    from services.digital_person_assessment import instruction
    from services.digital_person import DigitalPersonProfile
    for prompt in (RULES, instruction(DigitalPersonProfile()), knowledge.EXTRACTION_PROMPT,
                   repair_instruction('invalid', {})):
        assert COMPACT_RULES in prompt
    for boundary in ('1-2 short sentences', 'not an activity log',
                     'test counts', 'independent facts', 'Preserve complete facts'):
        assert boundary in COMPACT_RULES


def test_assessment_accepts_one_explicit_json_block_with_surrounding_prose():
    from services.digital_person_runtime import parse_check_result
    value={'decision':'silent','summary':'整理完成','source_ids':[]}
    assert parse_check_result('已整理本批。\n```json\n'+json.dumps(value)+'\n```\n完成。')==value


@pytest.mark.parametrize('body',[
    '说明\n```json\n{"decision":"silent"}\n```\n```json\n{}\n```',
    '说明\n```json\n{"decision":"silent","summary":"坏格式","source_ids":[],}\n```',
    '说明 {"decision":"silent","summary":"未明确界定","source_ids":[]}',
    '说明\n```json\n{"decision":"silent","summary":"存在歧义","source_ids":[]}\n```\n```python\nprint(1)\n```',
])
def test_assessment_rejects_ambiguous_or_invalid_embedded_json(body):
    from services.digital_person_runtime import parse_check_result
    with pytest.raises(ValueError):parse_check_result(body)


def test_assessment_repair_names_required_envelope_fields():
    from services.memory_policy import repair_instruction
    text=repair_instruction('主动检查结果结构无效',{'reflection_batch':[{'id':1}]})
    assert 'Required top-level fields' in text
    assert 'decision (silent or notify)' in text
    assert 'summary (string)' in text
    assert 'source_ids (array of strings, [] is valid)' in text

async def test_invalid_candidate_is_repaired_before_any_side_effect(runtime,monkeypatch):
    current,project,_=runtime
    await seed(current,project)
    calls=[]
    async def invoke(*args,**kwargs):
        token=await assessment_access(current)
        ctx=await memory_query.pending(current.projects,token)
        calls.append(args[3])
        item={'summary':'发布前演练迁移','kind':'preference','outcome':'stated',
              'source_ids':ctx['conversation'][0]['memory_ids'],
              'entities':[{'kind':'person','name':'用户','aliases':[]}],
              'relations':[{'from':'用户','relation':'要求','to':'迁移'}]}
        if len(calls)>1:
            assert 'Invalid relation endpoints' in args[3]
            item['entities'].append({'kind':'object','name':'迁移','aliases':[]})
        return '<json>'+json.dumps({'decision':'silent','summary':'已整理','source_ids':[],'memories':[item]})+'</json>',[],'native'
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
    token=await memory_query.create_context(current.projects,'local',session_id=sid)
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
    with pytest.raises(ValueError,match='Old knowledge has changed'):
        await asyncio.to_thread(knowledge.store_extraction,{'memories':[replacement]},ctx['reflection_batch'],versions,strict=True)
    with index.connect() as db:
        assert db.execute('select count(*) from memory_knowledge').fetchone()[0]==1
        assert db.execute('select count(*) from memory_changes where old_id is not null').fetchone()[0]==0


async def test_background_cannot_scan_history_or_read_old_raw_messages(runtime):
    current,project,_=runtime
    sid=await seed(current,project)
    ctx=await current._collect()
    token=await memory_query.create_context(current.projects,'local',session_id=sid)
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
    token=await memory_query.create_context(current.projects,'local',session_id=sid)
    hit=(await memory_query.search(current.projects,token,query='迁移'))['knowledge'][0]
    with pytest.raises(ValueError,match='fully read'):
        validate_memories({'memories':[dict(item,supersedes=[hit['id']])]},ctx,memory_query.observed_knowledge_versions(token))


async def test_failed_repair_keeps_batch_pending_and_no_knowledge(runtime,monkeypatch):
    current,project,_=runtime
    await seed(current,project)
    calls=[]
    async def invoke(*args,**kwargs):
        token=await assessment_access(current)
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
    token=await memory_query.create_context(current.projects,'local',session_id=sid)
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


async def test_json_then_foreign_evidence_gets_specific_bounded_repair(runtime,monkeypatch):
    current,project,_=runtime
    await seed(current,project)
    calls=[]
    async def invoke(*args,**kwargs):
        access=await assessment_access(current)
        ctx=await memory_query.pending(current.projects,access)
        calls.append(args[3])
        if len(calls)==1:return '{"decision":',[],'native'
        valid=ctx['conversation'][0]['memory_ids'][0]
        item={'summary':'发布前演练迁移','kind':'preference','outcome':'stated',
              'source_ids':['memory:999999'] if len(calls)==2 else [valid]}
        if len(calls)==3:
            assert 'memory:999999' in args[3]
            assert valid in args[3]
            assert 'inherited' in args[3]
        return json.dumps({'decision':'silent','summary':'已整理','source_ids':[],'memories':[item]}),[],'native'
    monkeypatch.setattr('agent_assistants.base.invoke_engine',invoke)
    result=await current.check()
    assert result['status']=='silent',result
    assert len(calls)==3
    with index.connect() as db:
        assert db.execute('select count(*) from memory_knowledge').fetchone()[0]==1


def test_source_contract_separates_new_and_inherited_evidence():
    from services.memory_policy import RULES,validate_memories
    assert 'inherited automatically' in RULES
    ctx={'reflection_batch':[{'id':201,'needs_knowledge':True,'scope':'local','role':'user'}]}
    with pytest.raises(ValueError,match='memory:137'):
        validate_memories({'memories':[{'summary':'更新','kind':'fact','outcome':'stated','source_ids':['memory:137','memory:201']}]},ctx)


async def test_distinct_repair_errors_still_have_a_total_cap(runtime,monkeypatch):
    current,project,_=runtime
    await seed(current,project)
    calls=[]
    async def invoke(*args,**kwargs):
        ctx=await memory_query.pending(current.projects,await assessment_access(current))
        calls.append(args[3])
        if len(calls)==1:return '{',[],'native'
        item={'summary':'有效来源但字段错误','kind':'fact','outcome':'stated',
              'source_ids':['memory:999999'] if len(calls)==2 else ctx['conversation'][0]['memory_ids']}
        if len(calls)==3:item['relations']=[{'from':'缺失实体','relation':'负责','to':'另一个缺失实体'}]
        return json.dumps({'decision':'silent','summary':'整理','source_ids':[],'memories':[item]}),[],'native'
    monkeypatch.setattr('agent_assistants.base.invoke_engine',invoke)
    result=await current.check()
    assert result['status']=='failed'
    assert len(calls)==3
    with index.connect() as db:
        assert db.execute('select count(*) from memory_knowledge').fetchone()[0]==0


@pytest.mark.parametrize('prefix,suffix',[('', ''),('整理如下：\n','\n已完成')])
def test_assessment_accepts_tagged_json(prefix,suffix):
    from services.digital_person_runtime import parse_check_result
    value={'decision':'silent','summary':'原文含 <json> 和 </json>，作为字符串保留','source_ids':[]}
    assert parse_check_result(prefix+'<json>'+json.dumps(value)+'</json>'+suffix)==value


@pytest.mark.parametrize('body',[
    '<json>{}</json><json>{}</json>', '<json>{}', '{} </json>',
    '<json><json>{}</json></json>', '<json>{bad}</json>',
    '<json>{"decision":"silent","summary":"missing sources"}</json>',
])
def test_assessment_rejects_invalid_tagged_output(body):
    from services.digital_person_runtime import parse_check_result
    with pytest.raises(ValueError):parse_check_result(body)


def test_repair_instruction_requests_json_tags():
    from services.memory_policy import repair_instruction
    assert 'exactly one <json>...</json> pair' in repair_instruction('invalid',{})


async def test_progress_event_cannot_supersede_stable_fact(runtime):
    current,project,_=runtime
    await seed(current,project)
    ctx=await current._collect();mid=ctx['conversation'][0]['memory_ids'][0]
    await asyncio.to_thread(knowledge.store_extraction,{'memories':[{'summary':'用户收藏技术书籍','kind':'fact','outcome':'stated','source_ids':[mid]}]},ctx['reflection_batch'])
    access=await memory_query.create_context(current.projects,'local')
    hit=(await memory_query.search(current.projects,access,query='技术书籍'))['knowledge'][0]
    await memory_query.read(current.projects,access,hit['id'],limit=6000)
    event={'summary':'用户完成项目申请','kind':'event','outcome':'reported','source_ids':[mid],'supersedes':[hit['id']]}
    with pytest.raises(ValueError,match='progress event'):
        await asyncio.to_thread(knowledge.store_extraction,{'memories':[event]},ctx['reflection_batch'],memory_query.observed_knowledge_versions(access),strict=True)
    assert (await memory_query.search(current.projects,access,query='技术书籍'))['knowledge']
    event['supersedes']=[]
    assert await asyncio.to_thread(knowledge.store_extraction,{'memories':[event]},ctx['reflection_batch'],strict=True)==1
    assert (await memory_query.search(current.projects,access,query='技术书籍'))['knowledge']
