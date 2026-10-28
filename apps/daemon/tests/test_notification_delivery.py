"""Exercise the outbound HTTP contract without contacting real robots."""
import json
import time

import httpx
import pytest

from services.notification_delivery import DeliveryError, notification_payload, send_notification


@pytest.mark.parametrize('platform', ['dingtalk', 'wecom'])
def test_custom_markdown_templates_replace_values_once_and_control_optional_content(platform):
    hook = {'platform':platform,'prefix':'k8s · WorkStep','include_link':True,
            'markdown_template':'## {notification_title}\n\n**{event_name}** | {event}\n\n{project_name}/{workflow_name}\n\n{task_title}\n\n{step_line}\n\n{time}\n\n{task_link}'}
    snapshot = {'event':'step_completed','project':{'name':'演示[项目]'},'workflow':{'name':'研发流程'},
                'task':{'title':'**修复** {event}'},'step':{'name':'测试'},'occurred_at':'2026-10-11T00:13:10+00:00',
                'task_url':'https://work.example/tasks?task=demo'}
    payload = notification_payload(hook, snapshot)
    text = payload['markdown']['text' if platform == 'dingtalk' else 'content']
    assert text.startswith('## k8s · WorkStep · 步骤完成')
    assert '**步骤完成** | step_completed' in text
    assert '演示\\[项目\\]/研发流程' in text
    assert '\\*\\*修复\\*\\* {event}' in text  # Task text is not another template.
    assert '步骤：测试' in text and '[查看任务](https://work.example/tasks?task=demo)' in text
    without = notification_payload({**hook,'include_link':False},{**snapshot,'step':None})
    text = without['markdown']['text' if platform == 'dingtalk' else 'content']
    assert '步骤：' not in text and 'https://' not in text
    omitted = notification_payload({**hook,'markdown_template':'仅通知：{event_name}'},snapshot)
    assert omitted['markdown']['text' if platform == 'dingtalk' else 'content'] == '仅通知：步骤完成'


def test_template_output_respects_platform_byte_limit_and_generic_stays_structured():
    snapshot = {'event':'completed','project':{'name':'演示'},'workflow':{'name':'流程'},
                'task':{'title':'任务'},'step':None,'occurred_at':'2026-10-11T00:13:10+00:00','task_url':None}
    hook = {'platform':'wecom','prefix':'','markdown_template':'字'*8000}
    text = notification_payload(hook,snapshot)['markdown']['content']
    assert len(text.encode()) <= 3900 and text.endswith('字')
    generic = notification_payload({**hook,'platform':'generic'},snapshot)
    assert generic['event'] == 'completed' and generic['occurred_at'] == snapshot['occurred_at']
    assert 'markdown' not in generic


@pytest.mark.skipif(not hasattr(time, 'tzset'), reason='Requires process timezone switching')
@pytest.mark.parametrize('platform', ['dingtalk', 'wecom'])
@pytest.mark.parametrize('zone,display', [
    ('Asia/Shanghai', '2026-10-11 08:13:10 (UTC+08:00)'),
    ('UTC', '2026-10-11 00:13:10 (UTC+00:00)'),
    ('America/New_York', '2026-10-10 20:13:10 (UTC-04:00)'),
    ('Asia/Kolkata', '2026-10-11 05:43:10 (UTC+05:30)'),
])
def test_robot_time_uses_device_timezone_and_keeps_json_timestamp(monkeypatch, platform, zone, display):
    snapshot = {'event':'test','project':{'name':'通知功能测试'},'workflow':{'name':'钉钉通知联调'},
                'task':{'title':'测试通知'},'step':None,'occurred_at':'2026-10-11T00:13:10.029659+00:00','task_url':None}
    hook = {'platform':platform,'prefix':'k8s','include_link':False}
    try:
        with monkeypatch.context() as patch:
            patch.setenv('TZ', zone)
            time.tzset()
            payload = notification_payload(hook, snapshot)
            text = payload['markdown']['text' if platform == 'dingtalk' else 'content']
            assert f'时间：{display}' in text
            assert '.029659' not in text
            assert notification_payload({**hook,'platform':'generic'}, snapshot)['occurred_at'] == snapshot['occurred_at']
    finally:
        time.tzset()


@pytest.mark.parametrize('platform', ['dingtalk', 'wecom'])
@pytest.mark.parametrize('event,label', [
    ('test','测试通知'), ('started','任务开始'), ('completed','任务完成'),
    ('failed','任务失败'), ('paused','任务等待确认'), ('stopped','任务停止'),
    ('step_completed','步骤完成'), ('step_failed','步骤失败'), ('waiting','步骤等待确认'),
])
def test_robot_body_explicitly_names_the_event(platform, event, label):
    snapshot = {'event':event,'project':{'name':'演示项目'},'workflow':{'name':'研发流程'},
                'task':{'title':'演示任务'},'step':None,'occurred_at':'2026-10-11T00:13:10+00:00','task_url':None}
    payload = notification_payload({'platform':platform,'prefix':'k8s'}, snapshot)
    text = payload['markdown']['text' if platform == 'dingtalk' else 'content']
    assert f'事件：{label}' in text


@pytest.mark.asyncio
@pytest.mark.parametrize('status,retryable', [(301, False), (400, False), (401, False), (408, True), (429, True), (500, True), (503, True)])
async def test_http_failures_are_classified_without_following_redirects(status, retryable):
    requests = []
    def receiver(request):
        requests.append(request)
        return httpx.Response(status, headers={'location':'https://other.example/private'}, text='credential echoed')
    async with httpx.AsyncClient(transport=httpx.MockTransport(receiver), follow_redirects=True) as client:
        with pytest.raises(DeliveryError) as error:
            await send_notification({'platform':'generic','url':'https://receiver.example/hook?token=private'}, {'event':'completed'}, client=client)
    assert len(requests) == 1
    assert str(error.value) == f'HTTP {status}'
    assert error.value.retryable is retryable


@pytest.mark.asyncio
@pytest.mark.parametrize('exception,message', [(httpx.ReadTimeout, '连接超时'), (httpx.ConnectError, '网络连接失败')])
async def test_network_errors_do_not_leak_request_or_exception(exception, message):
    def receiver(request):
        raise exception('credential echoed https://private.example/token', request=request)
    async with httpx.AsyncClient(transport=httpx.MockTransport(receiver)) as client:
        with pytest.raises(DeliveryError) as error:
            await send_notification({'platform':'generic','url':'https://receiver.example/hook'}, {}, client=client)
    assert str(error.value) == message and error.value.retryable


@pytest.mark.asyncio
@pytest.mark.parametrize('platform,url', [
    ('dingtalk', 'https://oapi.dingtalk.com/robot/send?access_token=demo'),
    ('wecom', 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=demo'),
    ('generic', 'https://receiver.example/hook'),
])
async def test_success_posts_json_and_unsigned_bots_keep_original_query(platform, url):
    requests = []
    payload = {'msgtype':'markdown','markdown':{'content':'通知'}}
    def receiver(request):
        requests.append(request)
        return httpx.Response(204) if platform == 'generic' else httpx.Response(200, json={'errcode':0})
    async with httpx.AsyncClient(transport=httpx.MockTransport(receiver)) as client:
        await send_notification({'platform':platform,'url':url,'secret':''}, payload, client=client)
    request = requests[0]
    assert request.method == 'POST' and str(request.url) == url
    assert json.loads(request.content) == payload
    assert request.headers['content-type'] == 'application/json'


@pytest.mark.asyncio
@pytest.mark.parametrize('body', [b'not json', b'[]', b'null', b'{}', b'{"errcode":false}', b'{"errcode":[]}', b'{"errcode":{}}', b'x'*16385])
async def test_malformed_platform_responses_are_permanent_delivery_errors(body):
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200, content=body))) as client:
        with pytest.raises(DeliveryError) as error:
            await send_notification({'platform':'wecom','url':'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=demo'}, {}, client=client)
    assert not error.value.retryable


@pytest.mark.asyncio
@pytest.mark.parametrize('code,retryable', [(130101, True), (45009, True), (-1, True), (310000, False), (40014, False)])
async def test_platform_business_failures_are_not_http_success(code, retryable):
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200, json={'errcode':code,'errmsg':'secret echoed'}))) as client:
        with pytest.raises(DeliveryError) as error:
            await send_notification({'platform':'wecom','url':'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=demo'}, {}, client=client)
    assert str(error.value) == f'平台错误码 {code}' and error.value.retryable is retryable
