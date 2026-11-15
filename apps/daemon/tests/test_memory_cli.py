import json

import httpx
import pytest

from cli import build_parser, dispatch
from services.tool_registry import WorkstepClient


@pytest.mark.parametrize('command,flags,expected', [
    ('search', ['--query', '发布经验', '--cursor', '20', '--snapshot', 'page-snapshot', '--limit', '5'], {'query':'发布经验', 'cursor':20, 'snapshot':'page-snapshot', 'limit':5}),
    ('history', ['--period', 'last_month', '--timezone', 'Asia/Shanghai'], {'period':'last_month', 'timezone_name':'Asia/Shanghai'}),
    ('read', ['--id', 'memory:7', '--offset', '800', '--limit', '40', '--events'], {'memory_id':'memory:7', 'offset':800, 'limit':40, 'events':True}),
])
async def test_memory_cli_uses_shared_authenticated_endpoints(command, flags, expected):
    seen = []
    async def handler(request):
        seen.append(request)
        return httpx.Response(200, json={'items': [], 'has_more': False})
    client = WorkstepClient(transport=httpx.MockTransport(handler))
    args = build_parser().parse_args(['memory', command, '--token', 'test-capability', *flags, '--json'])
    result = await dispatch(args, client)
    assert result['has_more'] is False
    assert seen[0].method == 'POST' and seen[0].url.path == '/api/memory/' + ('search' if command == 'history' else command)
    body = json.loads(seen[0].content)
    assert body['memory_token'] == 'test-capability'
    assert all(body[key] == value for key, value in expected.items())


def test_memory_cli_requires_capability():
    with pytest.raises(SystemExit):
        build_parser().parse_args(['memory', 'search', '--query', 'private'])


async def test_memory_compact_results_keep_evidence_and_pagination_without_internal_fields():
    raw = {'items':[{'id':'memory:7','content':'计划明天发布。' * 100,'role':'assistant','source_hash':'internal-hash','project_id':'p','strength':.9}],
           'knowledge':[{'id':'knowledge:2','summary':'发布计划待确认','kind':'event','outcome':'planned','state':'conflict','entities':[{'name':'internal'}],'sources':[{'id':'memory:7','source_hash':'internal-hash'}]}],
           'snapshot':'snapshot-1','has_more':True,'next_cursor':20,
           'coverage':{'basis':'indexed_sources','complete_source_history':False,'unavailable_or_changed':2,'worker':{'large':'internal'},'scan_cursors':{'p':123}}}
    class Client:
        async def call(self, operation, args):
            assert 'verbose' not in args
            return raw
    args=build_parser().parse_args(['memory','search','--token','test','--json'])
    result=await dispatch(args,Client())
    assert result['items'][0]['id']=='memory:7'
    assert len(result['items'][0]['summary'])<=160
    assert result['items'][0]['needs_read'] is True
    assert result['items'][0]['role']=='assistant'
    assert result['knowledge'][0]['source_ids']==['memory:7']
    assert result['knowledge'][0]['state']=='conflict'
    assert result['knowledge'][0]['outcome']=='planned'
    assert result['snapshot']=='snapshot-1' and result['next_cursor']==20
    assert result['coverage']['unavailable_or_changed']==2
    assert 'internal' not in json.dumps(result)
    args=build_parser().parse_args(['memory','search','--token','test','--verbose','--json'])
    assert await dispatch(args,Client())==raw


async def test_memory_read_keeps_requested_text_and_history_coverage():
    class Client:
        async def call(self, operation, args):
            if operation.endswith('read'):
                return {'id':'memory:7','content':'原文'*400,'source_hash':'hidden','offset':0,'next_offset':800,'has_more':True,'total_chars':2000,'role':'user'}
            return {'items':[{'id':'history:7','content':'原文','needs_read':True,'total_chars':2000}], 'has_more':False,
                    'coverage':{'complete_source_history':False,'unavailable_projects':['p'],'since':'2026-10-01','before':'2026-11-01'}}
    args=build_parser().parse_args(['memory','read','--token','test','--id','memory:7'])
    result=await dispatch(args,Client())
    assert result['content']=='原文'*400 and result['next_offset']==800
    assert 'source_hash' not in result
    args=build_parser().parse_args(['memory','history','--token','test'])
    result=await dispatch(args,Client())
    assert result['coverage']['unavailable_projects']==['p']
    assert result['items'][0]['needs_read'] is True


def test_memory_plain_output_and_errors(capsys):
    from cli import main
    class Client:
        async def call(self, operation, args):
            return {'items':[{'id':'memory:7','content':'只通知最终结果'}],'has_more':False}
    assert main(['memory','search','--token','test'],Client())==0
    output=capsys.readouterr().out
    assert 'memory:7' in output and '只通知最终结果' in output
    assert '"items"' not in output
    class Failed:
        async def call(self, operation, args): return {'ok':False,'error':'unavailable'}
    assert main(['memory','search','--token','test'],Failed())==1
    assert json.loads(capsys.readouterr().out)['error']=='unavailable'
