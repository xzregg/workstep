"""Offline, isolated evaluation of the production memory retrieval path.

Run as a fresh process: uv run --directory apps/daemon python -m memory_evaluation
"""
import argparse
import asyncio
from datetime import datetime, timezone, timedelta
import hashlib
import json
import math
import os
from pathlib import Path
import statistics
import subprocess
import sys
import tempfile
import time


def retrieval_metrics(retrieved, expected, k):
    ranked = list(dict.fromkeys(retrieved))[:k]
    gold = set(expected)
    relevant = sum(item in gold for item in ranked)
    if not gold:
        return dict(hit=None, recall=None, precision=None, all_evidence=None,
                    mrr=None, false_retrieval=int(bool(ranked)))
    return dict(hit=int(relevant > 0), recall=relevant / len(gold),
                precision=relevant / len(ranked) if ranked else 0,
                all_evidence=int(relevant == len(gold)),
                mrr=next((1 / i for i, item in enumerate(ranked, 1) if item in gold), 0),
                false_retrieval=None)


def percentile(values, fraction):
    return sorted(values)[max(0, math.ceil(len(values) * fraction) - 1)] if values else None


def knowledge_metrics(groups, expected, k):
    """K ranks knowledge records; score every cited source within those records."""
    evidence=list(dict.fromkeys(source for group in groups[:k] for source in group))
    metrics=retrieval_metrics(evidence,expected,max(1,len(evidence)))
    if expected:
        metrics['mrr']=next((1/i for i,group in enumerate(groups[:k],1) if set(group)&set(expected)),0)
    return metrics


def remap_evidence(ids, sources, coordinates):
    result=[]
    for mid in ids:
        if not isinstance(mid,str) or not mid.startswith('memory:'):
            raise ValueError('Invalid dataset evidence identifier')
        ordinal=int(mid.split(':',1)[1])
        if not 1<=ordinal<=len(sources):
            raise ValueError('Unknown dataset evidence')
        result.append(coordinates[sources[ordinal-1]['id']])
    return result


def validate_dataset(data):
    sources, cases = data['sources'], data['cases']
    ids = {s['id'] for s in sources}
    if len(ids) != len(sources) or len({c['id'] for c in cases}) != len(cases):
        raise ValueError('Duplicate source or case IDs')
    projects = {s['project'] for s in sources}
    for source in sources:
        if not source['text'] or datetime.fromisoformat(source['time']).tzinfo is None:
            raise ValueError('Sources require text and timezone-aware times')
    for case in cases:
        if not set(case['expected_ids'] + case.get('forget_ids', [])) <= ids:
            raise ValueError('Unknown evidence ID')
        if not set(case.get('projects', [])) <= projects:
            raise ValueError('Unknown project')
        if case.get('operation', 'search') not in ('search', 'history'):
            raise ValueError('Unsupported operation')


def encoded_size(value):
    return len(json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode())


async def evaluate(data, root, repeats, ks, extraction=None, query_plan=None,diagnostic_valid_only=False):
    # No service imports before main installs the isolated configuration paths.
    from services.config import config_store
    from services.project import ProjectManager
    from services import memory_query, digital_person_memory as memory
    from services import digital_person_memory_index as index
    from models.chat_session import ChatMessage, ChatSession
    from cli_memory_output import compact
    from services import memory_knowledge, digital_person_assessment as assessment

    await asyncio.to_thread(config_store.set, 'digital_person', {'enabled': True})
    await asyncio.to_thread(memory_knowledge.ensure_schema)
    manager = ProjectManager()
    projects, results = {}, []
    started = time.perf_counter()
    try:
        for i, name in enumerate(dict.fromkeys(s['project'] for s in data['sources'])):
            project = await asyncio.to_thread(manager.init_project, root / f'project-{i}', name=name)
            projects[name] = project.id
            def seed(_, name=name, project=project):
                sessions = set()
                for source in (s for s in data['sources'] if s['project'] == name):
                    sid = name + '-' + source['session']
                    when = datetime.fromisoformat(source['time'])
                    if sid not in sessions:
                        ChatSession.create(id=sid, project_id=project.id, workflow_id='',
                                           engine='codex', title=source['session'], created_at=when, updated_at=when)
                        sessions.add(sid)
                    message=ChatMessage.create(id=source['id'], session=sid, role=source.get('role', 'user'),
                                       content=source['text'], status='completed', created_at=when)
                    if message.role=='user':
                        message=ChatMessage.create(id='eval-reply-'+source['id'],session=sid,role='assistant',
                            content='收到。',status='completed',created_at=when+timedelta(milliseconds=1),ended_at=when+timedelta(milliseconds=1))
                    memory.capture_message(message,'local')
            await manager.run_db(project.id, seed)
        source_ids={source['id'] for source in data['sources']}
        with index.connect() as db:
            coordinates={r['source_message_id']:f"memory:{r['id']}" for r in db.execute('SELECT id,source_message_id FROM memories')}
        original_by_coordinate={value:key for key,value in coordinates.items()}
        extraction_result=None
        rejected=[]
        if extraction is not None:
            memories=[]
            for raw in extraction['memories']:
                item=dict(raw)
                # External model IDs label original dataset evidence, not ephemeral DB rows.
                item['source_ids']=remap_evidence(item['source_ids'],data['sources'],coordinates)
                memories.append(item)
            rows=await asyncio.to_thread(assessment.pending,list(projects.values()),baseline='0001-01-01T00:00:00+00:00')
            valid=[]
            for i,item in enumerate(memories):
                try:
                    memory_knowledge._validate(item,{int(row['id']):row for row in rows})
                    valid.append(item)
                except ValueError as exc:
                    rejected.append({'candidate':i+1,'error':str(exc),'source_ids':extraction['memories'][i]['source_ids']})
            if diagnostic_valid_only:memories=valid
            await asyncio.to_thread(assessment.claim,rows)
            try:
                extraction_result=await asyncio.to_thread(assessment.commit,rows,memories,'evaluation')
            except ValueError as exc:
                extraction_result={'status':'failed','error':str(exc)}
        ingest_ms = (time.perf_counter() - started) * 1000
        # Destructive diagnostics run last so ordinary/history cases share pristine data.
        for case in sorted(data['cases'], key=lambda c: bool(c.get('forget_ids'))):
            record = {key: case[key] for key in ('id', 'category', 'query', 'expected_ids')}
            record['original_query']=case['query']
            search_query=(query_plan or {}).get(case['id'],case['query'])
            record['query']=search_query
            record['operation'] = operation = case.get('operation', 'search')
            try:
                if operation=='search' and extraction_result and extraction_result['status']=='failed':
                    raise ValueError('Extraction commit failed: '+extraction_result['error'])
                if case.get('forget_ids'):
                    def forget():
                        with index.connect() as db:
                            rows = list(db.execute('SELECT id,source_message_id FROM memories'))
                        for row in rows:
                            if row['source_message_id'] in case['forget_ids']:
                                index.forget(row['id'])
                    await asyncio.to_thread(forget)
                ids = [projects[n] for n in case.get('projects', projects)]
                token = await memory_query.create_context(manager, 'local', project_ids=ids)
                times, sizes, retrieved = [], [], []
                for _ in range(repeats):
                    start = time.perf_counter()
                    cursor, snapshot, pages, retrieved,groups = 0, '', [], [],[]
                    while True:
                        page = await getattr(memory_query, operation)(manager, token,
                            query='' if operation=='history' else search_query, limit=max(ks), cursor=cursor, snapshot=snapshot,
                            since=case.get('since'), before=case.get('before'))
                        pages.append(page)
                        retrieved.extend(item['source_message_id'] for item in page['items'] if item['source_message_id'] in source_ids)
                        for item in page.get('knowledge',[]):
                            evidence=[original_by_coordinate[s['id']] for s in item['sources'] if s['id'] in original_by_coordinate]
                            groups.append([mid for mid in evidence if mid in source_ids])
                        if groups:retrieved=[mid for group in groups for mid in group]
                        if operation != 'history' or not page['has_more']:
                            break
                        if len(pages) > 1000 or page['next_cursor'] <= cursor:
                            raise RuntimeError('Pagination failed to advance')
                        cursor, snapshot = page['next_cursor'], page['snapshot']
                    times.append((time.perf_counter() - start) * 1000)
                    sizes.append((sum(encoded_size(p) for p in pages),
                                  sum(encoded_size(compact(p, operation)) for p in pages)))
                record.update(retrieved_ids=list(dict.fromkeys(retrieved)), pages=len(pages),
                              metrics={str(k): (knowledge_metrics(groups,case['expected_ids'],k) if groups else retrieval_metrics(retrieved,case['expected_ids'],k)) for k in ks},
                              knowledge_evidence=groups,
                              latency_ms={'first': times[0], 'p50': statistics.median(times), 'p95': percentile(times, .95)},
                              verbose_bytes=sizes[-1][0], compact_bytes=sizes[-1][1], coverage=pages[-1]['coverage'])
                if operation == 'history':
                    record['complete_metrics'] = retrieval_metrics(retrieved, case['expected_ids'], max(1, len(set(retrieved))))
            except Exception as exc:
                # Errors remain in aggregate denominators, never silently dropped.
                record.update(error=f'{type(exc).__name__}: {exc}',
                              metrics={str(k): retrieval_metrics([], case['expected_ids'], k) for k in ks})
            results.append(record)
        return {'ingest_ms': ingest_ms, 'cases': results,'extraction_result':extraction_result,
                'diagnostic_valid_only':diagnostic_valid_only,'rejected_candidates':rejected,
                'extraction_metadata':{k:v for k,v in (extraction or {}).items() if k!='memories'},
                'query_mode':'model_keywords' if query_plan else 'original_question'}
    finally:
        await asyncio.to_thread(manager.close_all)


def summarize(results, ks):
    rows = [r for r in results if r['operation'] == 'search' and r['expected_ids']]
    return {str(k): {name: statistics.mean(r['metrics'][str(k)][name] for r in rows) if rows else None
                    for name in ('hit', 'recall', 'precision', 'all_evidence', 'mrr')} for k in ks}


def markdown(report):
    lines = ['# WorkStep 记忆评测报告', '', f"数据集：{report['dataset']}；SHA256：`{report['dataset_sha256']}`",
             '', '隔离合成数据，完成回复登记→知识提交→生产 search/history；不是公开基准成绩。',
             f"提炼结果：{report.get('extraction_result')}；检索词模式：{report.get('query_mode')}。",
             f"仅合法候选诊断模式：{report.get('diagnostic_valid_only',False)}；被拒候选：{report.get('rejected_candidates',[])}。诊断模式跳过非法知识，但保留全部题目和标准证据，不代表生产整批提交已成功。",
             '模型提炼使用外部生成产物；标准答案未提供给提炼模型。未测最终回答正确率、事件日志及真实规模并发。',
             '时间范围由评测提供，未测 LLM 时间理解；更新案例仅检查新证据召回，不等同冲突消解。',
             '耗时含本进程缓存效应，P95 是少量重复样本的描述值；字节数不是 token 数。',
             '', '| K | Hit | Recall | Precision | 全证据命中 | MRR |', '|---|---|---|---|---|---|']
    for k, row in report['summary'].items():
        lines.append('| ' + k + ' | ' + ' | '.join(f'{v:.1%}' if v is not None else 'N/A' for v in row.values()) + ' |')
    lines += ['', '指标按有答案 search 问题宏平均；K为知识条目数，按前K条引用的源消息去重评分；Precision分母为返回证据数。',
              '无答案、隔离和遗忘逐题显示，不混入召回率；返回无关记录不等于最终回答幻觉。',
              '', '| 问题 | 类别 | 找到 / 应找 | 首次 / P50 / P95 ms | 完整 / 精简字节 | 状态 |', '|---|---|---|---|---|---|']
    for row in report['cases']:
        found = len(set(row.get('retrieved_ids', [])) & set(row['expected_ids']))
        latency = ' / '.join(f'{v:.2f}' for v in row.get('latency_ms', {}).values())
        status = row.get('error') or ('返回 '+str(len(row.get('retrieved_ids', [])))+' 条' if not row['expected_ids'] else '')
        lines.append(f"| {row['id']} {row['query']} | {row['category']} | {found}/{len(row['expected_ids'])} | {latency} | {row.get('verbose_bytes', '-')} / {row.get('compact_bytes', '-')} | {status.replace('|', '/')} |")
    lines += ['', f"异常数：{sum('error' in r for r in report['cases'])}；初始化与入索引：{report['ingest_ms']:.1f} ms。",
              '逐题证据、分页覆盖声明、配置及错误详见同目录 report.json。', '', '方法参考（本脚本不是这些基准的复现）：',
              '- [LongMemEval](https://github.com/xiaowu0162/LongMemEval)：多会话、更新、时间与无答案分类。',
              '- [LoCoMo](https://github.com/snap-research/LoCoMo)：问题与标准证据关联。',
              '- [Memory Benchmarks](https://github.com/mem0ai/memory-benchmarks)：检索与回答评估分层。', '']
    return '\n'.join(lines)


def main():
    repo = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dataset', type=Path, default=Path(__file__).parent / 'evaluation/memory_smoke.json')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--repeats', type=int, default=3)
    parser.add_argument('--top-k', default='1,3,5')
    parser.add_argument('--memories-file',type=Path,help='External model output using memory:N to label dataset source N')
    parser.add_argument('--query-plan',type=Path,help='Question-only model keyword plan, without standard answers')
    parser.add_argument('--diagnostic-valid-only',action='store_true',help='Isolated diagnostic only: score valid candidates while retaining all gold questions')
    args = parser.parse_args()
    ks = sorted(set(int(k) for k in args.top_k.split(',')))
    if args.repeats < 1 or not ks or min(ks) < 1 or max(ks) > 100:
        parser.error('repeats >= 1; top-k between 1 and 100')
    raw = args.dataset.read_bytes()
    data = json.loads(raw)
    validate_dataset(data)
    output = args.output or repo / 'tmp/memory-eval' / datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    output.mkdir(parents=True, exist_ok=False)
    if any(name.startswith('services.') for name in sys.modules):
        raise RuntimeError('Run evaluation in a fresh process to guarantee isolation')
    with tempfile.TemporaryDirectory(prefix='sandbox-', dir=output) as temp:
        root = Path(temp).resolve()
        os.environ['WORKSTEP_CONFIG_DIR'] = str(root / 'config')
        os.environ['WORKSTEP_PROJECTS_ROOT'] = str(root)
        extraction=json.loads(args.memories_file.read_text()) if args.memories_file else None
        query_plan=json.loads(args.query_plan.read_text()) if args.query_plan else None
        report = asyncio.run(evaluate(data, root, args.repeats, ks,extraction,query_plan,args.diagnostic_valid_only))
    revision = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=repo, capture_output=True, text=True)
    dirty = subprocess.run(['git', 'status', '--porcelain'], cwd=repo, capture_output=True, text=True)
    report.update(dataset=data.get('name', args.dataset.name), dataset_sha256=hashlib.sha256(raw).hexdigest(),
                  generated_at=datetime.now(timezone.utc).isoformat(), source_count=len(data['sources']),
                  repeats=args.repeats, top_k=ks, python=sys.version, revision=revision.stdout.strip(),
                  dirty=bool(dirty.stdout), summary=summarize(report['cases'], ks), answer_quality='not_measured')
    (output / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')
    (output / 'report.md').write_text(markdown(report))
    print(output.resolve() / 'report.md')
    return int(any('error' in r for r in report['cases']))


if __name__ == '__main__':
    raise SystemExit(main())
