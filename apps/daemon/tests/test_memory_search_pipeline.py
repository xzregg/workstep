from tests.memory_turn_fixture import assessment_access
"""Deterministic extraction fixture, real persistence/CLI/search/source paths.

This verifies wiring and lexical association, not a live model's extraction quality.
"""
import json
from datetime import datetime,timedelta,timezone
from pathlib import Path

from cli import build_parser,dispatch
from models.fields import utc_now
from services import memory_query
from tests.memory_turn_fixture import create_completed_user
from tests.test_chat_session import chat_module
from tests.test_digital_person_runtime import runtime


async def test_completed_turn_to_cli_search_summary_entities_relations_and_originals(runtime,monkeypatch):
    current,project,_=runtime
    bodies={
        'fact-source':'北辰应用服务器在杭州，别名Polaris，林岚负责维护api-gateway。2026年10月8日出现502，已确认是Nginx上游端口和实际监听不一致。',
        'experience-source':'2026年10月18日北辰再次出现502，林岚核对监听地址和上游端口，修正代理配置，nginx -t后reload恢复。以后遇到类似情况先核对端口，再验证配置和重载。',
    }
    base=datetime(2026,10,8,8,tzinfo=timezone.utc)
    await current.mutate(lambda s:s.update(assessment_live_since=(base-timedelta(days=1)).isoformat()))
    def seed(_):
        for i,(mid,body) in enumerate(bodies.items()):
            sid=current.chats.create_session(project.id)['id']
            create_completed_user(id=mid,session=sid,role='user',status='completed',content=body,
                                  created_at=base+timedelta(days=i*10))
    await current.projects.run_db(project.id,seed)
    class Client:
        async def call(self,operation,arguments):
            action=operation.removeprefix('workstep_memory_')
            arguments['context']=getattr(self,'context',None) or await assessment_access(current)
            return await getattr(memory_query,action)(current.projects,**arguments)
    async def cli(action,token,*flags):
        args=build_parser().parse_args(['memory',action,*flags,'--json'])
        client=Client();client.context=token
        return await dispatch(args,client)
    async def invoke(*args,**kwargs):
        token=await assessment_access(current)
        pending=await cli('pending',token)
        messages=[message for group in pending['conversations'] for message in group['conversation']]
        evidence={m['id']:m['memory_ids'][0] for m in messages if m['role']=='user'}
        return json.dumps({'decision':'silent','kind':'work','summary':'整理完成','source_ids':[],
            'memories':[
                {'summary':'北辰网关曾出现502，原因是代理上游与实际监听不一致。','kind':'fact','outcome':'stated',
                 'source_ids':[evidence['fact-source']],
                 'entities':[{'kind':'person','name':'林岚','aliases':[]},
                             {'kind':'object','name':'北辰','aliases':['Polaris']},
                             {'kind':'object','name':'api-gateway','aliases':[]},
                             {'kind':'place','name':'杭州','aliases':[]}],
                 'relations':[{'from':'林岚','relation':'维护','to':'api-gateway'}]},
                {'summary':'网关502处理经验','kind':'experience','outcome':'reported',
                 'source_ids':[evidence['experience-source']],
                 'experience':{'situation':'北辰网关出现502','action':'核对监听地址和上游端口，修正代理配置并nginx -t后reload','result':'服务恢复'},
                 'entities':[{'kind':'object','name':'北辰','aliases':['Polaris']}],
                 'relations':[]}
            ]}),[],'native'
    monkeypatch.setattr('agent_assistants.base.invoke_engine',invoke)
    processed=await current.check()
    assert processed['status']=='silent',processed.get('error')
    assert processed['memory_processing']['knowledge']['created']==2
    token=await memory_query.create_context(current.projects,'local',project_ids=[project.id])
    history=await cli('search',token,'--since','2026-10-01T00:00:00Z','--before','2026-11-01T00:00:00Z',
                      '--with-sources','--limit','20')
    assert not history['has_more'] and history['coverage']['complete_source_history']
    assert set(bodies.values())<={item['content'] for item in history['source_texts']}
    clues=[word for word in ('Polaris','api-gateway','502')
           if any(word in source['content'] for source in history['source_texts'])]
    assert len(clues)==3
    related=await cli('search',token,'--query',' '.join(clues))
    assert {item['kind'] for item in related['knowledge']}=={'fact','experience'}
    knowledge_id=related['knowledge'][0]['id']
    knowledge_read=await cli('read',token,'--id',knowledge_id,'--limit','6000')
    assert knowledge_read['id']==knowledge_id
    assert json.loads(knowledge_read['content'])['summary']
    assert knowledge_id in memory_query.observed_knowledge_versions(token)
    cases=[]
    for category,query,expected_kinds in [
        ('summary','502',{'fact','experience'}),('person_tag','林岚',{'fact'}),
        ('place_tag','杭州',{'fact'}),('alias','Polaris',{'fact','experience'}),
        ('relationship_only','维护',{'fact'}),('experience_action','监听地址',{'experience'}),
        ('no_answer','zz_nomatch_98765',set()),
    ]:
        result=await cli('search',token,'--query',query,'--limit','20')
        kinds={item['kind'] for item in result['knowledge']}
        assert expected_kinds<=kinds if expected_kinds else not kinds
        assert 'source_texts' not in result
        assert all('content' not in item and item.get('title') for item in result['knowledge'])
        cases.append({'category':category,'query':query,'expected_kinds':sorted(expected_kinds),
                      'returned_kinds':sorted(kinds),'pass':True})
    typed=await cli('search',token,'--person','林岚','--object','api-gateway','--relation','维护','--with-sources')
    assert len(typed['knowledge'])==1
    assert typed['knowledge'][0]['matched_relations']==[{'from':'林岚','relation':'维护','to':'api-gateway'}]
    assert [s['content'] for s in typed['source_texts']]==[bodies['fact-source']]
    expanded=await cli('search',token,'--query','Polaris','--with-sources')
    assert expanded['source_coverage']['complete']
    assert {item['content'] for item in expanded['source_texts']}==set(bodies.values())
    source=expanded['knowledge'][0]['source_ids'][0]
    read=await cli('read',token,'--id',source)
    assert read['content'] in bodies.values()
    report={'method':'controlled model output; real completed-turn indexing, pending CLI, atomic commit, search CLI and original-source reads',
            'created_memories':2,'cases':cases,'with_sources_matches_originals':True,'read_matches_original':True}
    report['time_first_search']={'source_messages':len(history['items']),'derived_clues':clues,
                                'related_knowledge':len(related['knowledge']),'pass':True}
    root=Path(__file__).resolve().parents[3]/'tmp/memory-search-e2e'
    root.mkdir(parents=True,exist_ok=True)
    (root/'pipeline.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
