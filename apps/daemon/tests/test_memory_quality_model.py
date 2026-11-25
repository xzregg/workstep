"""Opt-in proactive-reflection regression using synthetic CLI evidence.

Run with WORKSTEP_RUN_MEMORY_MODEL_EVAL=1. No source DB is opened or mutated.
A failed provider is a failed evaluation, never an empty successful extraction.
"""
import json
import asyncio
import os
from pathlib import Path
import pytest

pytestmark=pytest.mark.skipif(os.environ.get('WORKSTEP_RUN_MEMORY_MODEL_EVAL')!='1',reason='explicit real-model evaluation only')

CASES=[
    ('greeting',[('user','你好，今天天气不错。'),('assistant','你好呀！')],'empty'),
    ('temporary',[('user','只限这次修改，不要运行测试，后续任务照常测试。')],'no_preference'),
    ('assistant_claim',[('assistant','用户永远不需要测试，他的生日是六月一日。')],'empty'),
    ('plan',[('user','准备明天修改部署脚本。'),('assistant','我打算重建前端并检查资源哈希，尚未执行。')],'plan'),
    ('experience',[('user','本次部署后页面仍用旧资源。我确认重新构建后核对实际加载哈希，页面恢复。以后遇到同样的资源未更新问题，先检查服务实际使用的构建版本。')],'experience'),
    ('correction',[('user','之前说我永远不需要测试是错的。只有昨天临时演示不用测试，正式修改都需要测试。')],'correction'),
    ('product_requirement',[('user','以后 OmniVoice 这种不支持提示词的引擎，都使用设置中的预设标签。')],'event_not_preference'),
    ('ui_requirement',[('user','没有新增知识时，隐藏新增数量和多余逗号。')],'no_preference'),
    ('personal_preference',[('user','我喜欢温和、慢一点的声音。')],'preference'),
    ('collaboration_preference',[('user','以后跟我解释结果时简短一些，技术分析需要详细时例外。')],'preference'),
    ('reported_progress',[('user','星图采用双臂方案。'),('assistant','已修改为双臂，尚未由用户验收。')],'event_not_fact'),
    ('current_setting',[('user','我现在设置的欢迎语是“你好，有何吩咐”。')],'fact'),
    ('unexplained_failure',[('user','帮我播放专注歌单。'),('assistant','寻找歌单后浏览器连续超时，未成功播放，原因未知。')],'no_experience'),
    ('generic_completion',[('user','脑图有数量却没内容，时间线文字也重叠。'),('assistant','调整了筛选分页和滚动布局，测试通过。没有进一步定位具体机制。')],'no_experience'),
]

@pytest.mark.parametrize('name,messages,expectation',CASES)
async def test_semantic_quality(name,messages,expectation):
    from services.digital_person import DigitalPersonProfile
    from services.digital_person_assessment import instruction
    from services.digital_person_runtime import parse_check_result
    from services.memory_policy import validate_memories
    from services.config import config_store
    from engines.pydantic_ai.engine import PydanticAIEngine
    from pydantic_ai import Agent,UsageLimits
    rows=[dict(id=f'message-{i+1}',memory_ids=[f'memory:{i+1}'],role=role,content=text,project_id='synthetic',
               session_id='synthetic',scope='local',author_id='user' if role=='user' else 'assistant',
               author_name=role,created_at='2026-11-14T06:00:00+00:00')
          for i,(role,text) in enumerate(messages)]
    config=await asyncio.to_thread(config_store.get_pydantic_ai_engine_config)
    runtime=await asyncio.to_thread(PydanticAIEngine().resolve_provider_runtime,
        provider_id=str(config.get('provider_id') or ''),model=str(config.get('model') or ''))
    provider=await asyncio.to_thread(config_store.get_provider,runtime.provider_id)
    if provider is None or not config.get('model'):
        raise RuntimeError('Configure a Pydantic AI provider/model for this opt-in evaluation')
    model=await asyncio.to_thread(PydanticAIEngine.build_model,provider=provider,model_name=config['model'],protocol=runtime.protocol)
    calls=[]
    async def terminal(command:str)->dict:
        """Read the workstep-cli skill/reference or retrieve this synthetic memory pending batch."""
        calls.append(command)
        if 'memory pending' in command:
            return dict(origin_project_id='synthetic',origin_session_id='synthetic',conversation=rows,
                companion={'scope':'local','contact_policy':{'allowed':False}},relationships=[],delegations=[],
                user_preferences={'items':[],'complete':True},session_knowledge={'items':[],'complete':True},
                historical_batch=False,memory_only=False,clock='2026-11-14T06:05:00+00:00')
        return {'content':'Use the engine terminal to run workstep-cli memory pending. This test has no other stored knowledge or tools.'}
    result=await asyncio.wait_for(Agent(model,tools=[terminal],system_prompt=instruction(DigitalPersonProfile())).run(
        'Start this background assessment: follow the system instructions to retrieve the pending messages and return the result.',
        usage_limits=UsageLimits(request_limit=8)),240)
    output=parse_check_result(str(result.output))
    assert any('memory pending' in command for command in calls)
    assert output['decision']=='silent'
    validate_memories(output,{'reflection_batch':[dict(id=i+1,role=role,scope='local') for i,(role,_) in enumerate(messages)]})
    root=Path(__file__).resolve().parents[3]/'tmp'/'digital-person-reflection'/'model-eval'
    root.mkdir(parents=True,exist_ok=True)
    (root/(name+'.json')).write_text(json.dumps({'evidence':rows,'output':output},ensure_ascii=False,indent=2))
    items=output.get('memories',[])
    if expectation=='empty':assert items==[]
    if expectation=='no_preference':assert all(x['kind']!='preference' for x in items)
    if expectation in ('plan','no_experience'):assert all(x['kind']!='experience' for x in items)
    if expectation=='plan':assert all(x['outcome'] not in ('observed','reported') for x in items)
    if expectation=='experience':assert any(x['kind']=='experience' and all(x.get('experience',{}).get(k) for k in ('situation','action','result')) for x in items)
    if expectation=='correction':assert items and any('测试' in x['summary'] for x in items)
    if expectation=='preference':assert any(x['kind']=='preference' for x in items)
    if expectation=='fact':assert any(x['kind']=='fact' for x in items)
    if expectation=='event_not_preference':assert any(x['kind']=='event' for x in items) and all(x['kind']!='preference' for x in items)
    if expectation=='event_not_fact':assert any(x['kind']=='event' for x in items) and all(x['kind']!='fact' for x in items)
    assert all(set(x['source_ids']) <= {mid for r in rows for mid in r['memory_ids']} for x in items)
