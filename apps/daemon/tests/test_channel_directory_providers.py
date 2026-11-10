import asyncio
import json
import httpx
import pytest

from services.channels.directory_providers.dingtalk import DingTalkDirectory
from services.channels.directory_providers.feishu import FeishuDirectory
from services.channels.directory_providers.wecom import WeComDirectory
from services.channels.directory import DirectoryError


@pytest.mark.parametrize('provider', [DingTalkDirectory, FeishuDirectory, WeComDirectory])
async def test_native_directory_requests_and_identity(provider):
    calls = []
    def handler(request):
        calls.append(request)
        path = request.url.path
        if path.endswith('accessToken'): return httpx.Response(200,json={'accessToken':'token'})
        if path.endswith('internal'): return httpx.Response(200,json={'code':0,'tenant_access_token':'token'})
        if path.endswith('gettoken'): return httpx.Response(200,json={'errcode':0,'access_token':'token'})
        if path.endswith('listsub'): return httpx.Response(200,json={'errcode':0,'result':[]})
        if path.endswith('children'): return httpx.Response(200,json={'code':0,'data':{'items':[],'has_more':False}})
        if path.endswith('agent/get'): return httpx.Response(200,json={'errcode':0,'agentid':1})
        if path.endswith('department/list'): return httpx.Response(200,json={'errcode':0,'department':[{'id':1,'name':'研发'}]})
        if path.endswith('v2/user/list'):
            cursor=json.loads(request.content)['cursor']
            return httpx.Response(200,json={'errcode':0,'result':{'list':[{'userid':f'u{cursor}','name':'张三','unionid':'not-a-send-id'}], 'has_more':cursor==0,'next_cursor':1}})
        if path.endswith('find_by_department'):
            assert request.url.params['user_id_type']=='open_id'
            return httpx.Response(200,json={'code':0,'data':{'items':[{'open_id':'ou_1','user_id':'wrong','name':'张三'}],'has_more':False}})
        if path.endswith('user/list'):
            return httpx.Response(200,json={'errcode':0,'userlist':[{'userid':'u1','name':'张三','department':[1]}]})
        raise AssertionError(path)
    item=provider({'app_id':'app','secret':'secret','directory_corp_id':'corp','directory_agent_id':'1','directory_secret':'dir'}, asyncio.to_thread)
    item.client=lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler))
    rows=await item.fetch_snapshot()
    if provider is DingTalkDirectory:
        assert [row['user_id'] for row in rows]==['u0','u1']
    elif provider is FeishuDirectory:
        assert rows[0]['user_id']=='ou_1'
    else:
        assert rows[0]['contact_id']=='u1'
        assert rows[0]['user_id']==''  # no assumed bot/application ID equivalence
    assert all(row['name']=='张三' for row in rows)


async def test_permission_failure_does_not_leak_platform_details():
    item=DingTalkDirectory({'app_id':'a','secret':'secret'},asyncio.to_thread)
    item.client=lambda: httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200,json={'errcode':60011,'errmsg':'secret private data'})))
    with pytest.raises(DirectoryError) as error:
        await item.fetch_snapshot()
    assert 'secret' not in str(error.value)


def test_repeated_cursor_is_rejected():
    with pytest.raises(DirectoryError):
        DingTalkDirectory.next_page({'has_more':True,'next_cursor':0}, {'0'}, 'next_cursor')
