"""Opt-in semantic regression using synthetic evidence and the configured model.

Run with WORKSTEP_RUN_MEMORY_MODEL_EVAL=1. No source DB is opened or mutated.
A failed provider is a failed evaluation, never an empty successful extraction.
"""
import json
import os
from pathlib import Path
import pytest
from services.memory_knowledge import _extract_with_runtime

pytestmark=pytest.mark.skipif(os.environ.get('WORKSTEP_RUN_MEMORY_MODEL_EVAL')!='1',reason='explicit real-model evaluation only')

CASES=[
    ('greeting',[('user','你好，今天天气不错。'),('assistant','你好呀！')],'empty'),
    ('temporary',[('user','只限这次修改，不要运行测试，后续任务照常测试。')],'no_preference'),
    ('assistant_claim',[('assistant','用户永远不需要测试，他的生日是六月一日。')],'empty'),
    ('plan',[('user','准备明天修改部署脚本。'),('assistant','我打算重建前端并检查资源哈希，尚未执行。')],'no_experience'),
    ('experience',[('user','本次部署后页面仍用旧资源。我确认重新构建后核对实际加载哈希，页面恢复。以后遇到同样的资源未更新问题，先检查服务实际使用的构建版本。')],'experience'),
    ('correction',[('user','之前说我永远不需要测试是错的。只有昨天临时演示不用测试，正式修改都需要测试。')],'correction'),
]

@pytest.mark.parametrize('name,messages,expectation',CASES)
async def test_semantic_quality(name,messages,expectation):
    rows=[dict(id=f'memory:{i+1}',role=role,content=text,project_id='synthetic',
               session_id='synthetic',scope='local',created_at='2026-11-14T06:00:00+00:00')
          for i,(role,text) in enumerate(messages)]
    output=await _extract_with_runtime(None,None,rows,[])
    root=Path(__file__).resolve().parents[3]/'tmp'/'digital-person-reflection'/'model-eval'
    root.mkdir(parents=True,exist_ok=True)
    (root/(name+'.json')).write_text(json.dumps({'evidence':rows,'output':output},ensure_ascii=False,indent=2))
    items=output['memories']
    if expectation=='empty':assert items==[]
    if expectation=='no_preference':assert all(x['kind']!='preference' for x in items)
    if expectation=='no_experience':assert all(x['kind']!='experience' and x['outcome'] not in ('observed','reported') for x in items)
    if expectation=='experience':assert any(x['kind']=='experience' and all(x.get('experience',{}).get(k) for k in ('situation','action','result')) for x in items)
    if expectation=='correction':assert items and any('测试' in x['summary'] for x in items)
    assert all(set(x['source_ids']) <= {r['id'] for r in rows} for x in items)
