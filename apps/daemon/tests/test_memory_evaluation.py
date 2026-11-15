import pytest
from memory_evaluation import retrieval_metrics, validate_dataset, percentile

def test_multi_evidence_and_duplicate_chunks():
    metrics=retrieval_metrics(['a','a','x','b'],['a','b','c'],3)
    assert metrics['hit']==1 and metrics['recall']==pytest.approx(2/3)
    assert metrics['precision']==pytest.approx(2/3)
    assert metrics['all_evidence']==0 and metrics['mrr']==1

def test_no_answer_is_not_counted_as_perfect_recall():
    assert retrieval_metrics([],[],5)['recall'] is None
    assert retrieval_metrics(['wrong'],[],5)['false_retrieval']==1
    assert retrieval_metrics([],[],5)['false_retrieval']==0

def test_dataset_rejects_unknown_evidence_and_duplicate_questions():
    with pytest.raises(ValueError):validate_dataset({'sources':[],'cases':[{'id':'q','query':'q','expected_ids':['missing']}]})
    assert percentile([1,2,3,4],.95)==4

def test_duplicate_case_ids_are_rejected():
    with pytest.raises(ValueError):
        validate_dataset({'sources': [], 'cases': [{'id':'q','expected_ids':[]}] * 2})

def test_errors_remain_in_denominator():
    from memory_evaluation import summarize
    rows = [dict(operation='search', expected_ids=['a'], metrics={'5':retrieval_metrics(['a'], ['a'], 5)}),
            dict(operation='search', expected_ids=['b'], error='failure', metrics={'5':retrieval_metrics([], ['b'], 5)})]
    assert summarize(rows, [5])['5']['recall'] == .5

def test_history_gold_matches_time_and_project_filters():
    import json
    from pathlib import Path
    from datetime import datetime
    data=json.loads((Path(__file__).parents[1]/'evaluation/memory_smoke.json').read_text())
    validate_dataset(data)
    for case in data['cases']:
        if case.get('operation') == 'history':
            expected={s['id'] for s in data['sources'] if s['project'] in case['projects']
                      and datetime.fromisoformat(case['since']) <= datetime.fromisoformat(s['time'])
                      < datetime.fromisoformat(case['before'])}
            assert expected == set(case['expected_ids'])


def test_knowledge_metrics_keep_all_evidence_within_top_k_memories():
    from memory_evaluation import knowledge_metrics
    result=knowledge_metrics([['a','b'],['x']],['a','b'],1)
    assert result['recall']==1 and result['precision']==1
    assert knowledge_metrics([['a','b'],['x']],['a','b'],2)['precision']==pytest.approx(2/3)


@pytest.mark.parametrize('identifier',['memory:0','memory:-1','memory:2','knowledge:1'])
def test_evidence_mapping_rejects_unknown_or_wrong_kind_ids(identifier):
    from memory_evaluation import remap_evidence
    with pytest.raises(ValueError):remap_evidence([identifier],[{'id':'a'}],{'a':'memory:9'})


def test_cli_evaluation_scores_knowledge_sources_instead_of_empty_raw_items(tmp_path):
    import json,subprocess,sys
    from pathlib import Path
    dataset={'name':'isolated-evaluation-test','sources':[{'id':'s1','project':'work','session':'chat',
        'time':'2026-10-01T08:00:00+00:00','role':'user','text':'小林负责审核发布清单'}],
        'cases':[{'id':'positive','category':'fact','query':'审核','expected_ids':['s1']},
                 {'id':'negative','category':'unanswerable','query':'zz_missing_98765','expected_ids':[]}]}
    extraction={'memories':[{'summary':'小林负责审核发布清单','kind':'fact','outcome':'stated','source_ids':['memory:1']}]}
    data_path=tmp_path/'dataset.json';data_path.write_text(json.dumps(dataset))
    extraction_path=tmp_path/'extraction.json';extraction_path.write_text(json.dumps(extraction))
    output=tmp_path/'report'
    result=subprocess.run([sys.executable,'-m','memory_evaluation','--dataset',str(data_path),
        '--memories-file',str(extraction_path),'--output',str(output),'--repeats','1'],
        cwd=Path(__file__).resolve().parents[1],capture_output=True,text=True,timeout=30)
    assert result.returncode==0,result.stderr
    report=json.loads((output/'report.json').read_text())
    assert report['summary']['1']['recall']==1
    assert report['summary']['1']['precision']==1
    assert report['cases'][0]['retrieved_ids']==['s1']
    assert report['cases'][1]['metrics']['1']['false_retrieval']==0


@pytest.mark.parametrize('diagnostic',[False,True])
def test_invalid_extraction_is_reported_and_gold_never_disappears(tmp_path,diagnostic):
    import json,subprocess,sys
    from pathlib import Path
    dataset={'sources':[{'id':'a','project':'p','session':'s','time':'2026-10-01T00:00:00+00:00',
                        'role':'user','text':'小林负责发布清单'}],
             'cases':[{'id':'q','category':'entity','query':'小林','expected_ids':['a']}]}
    extraction={'memories':[{'summary':'小林负责发布清单','kind':'fact','outcome':'stated',
        'source_ids':['memory:1'],'entities':[],
        'relations':[{'from':'小林','relation':'负责','to':'发布清单'}]}]}
    data_path=tmp_path/'data.json';data_path.write_text(json.dumps(dataset))
    memories=tmp_path/'memories.json';memories.write_text(json.dumps(extraction))
    output=tmp_path/'output'
    command=[sys.executable,'-m','memory_evaluation','--dataset',str(data_path),
             '--memories-file',str(memories),'--output',str(output),'--repeats','1']
    if diagnostic:command.append('--diagnostic-valid-only')
    result=subprocess.run(command,cwd=Path(__file__).resolve().parents[1],capture_output=True,text=True,timeout=30)
    assert result.returncode==(0 if diagnostic else 1),result.stderr
    report=json.loads((output/'report.json').read_text())
    assert len(report['rejected_candidates'])==1
    assert report['cases'][0]['expected_ids']==['a']
    assert report['summary']['1']['recall']==0
    if not diagnostic:assert report['extraction_result']['status']=='failed'
