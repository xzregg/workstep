"""Offline Feishu/Lark webhook contracts and persisted notification behavior."""
import asyncio
import base64
import hashlib
import hmac
import json

import httpx
import pytest
from pydantic import ValidationError

from schemas.notification_hooks import NotificationHookDraft
from services.notification_delivery import DeliveryError, notification_payload, send_notification
from tests.test_notification_hooks import notification_app, save


@pytest.mark.parametrize('platform,host', [('feishu', 'open.feishu.cn'), ('lark', 'open.larksuite.com')])
def test_webhook_configuration_preserves_signing_secret_and_rejects_wrong_region(platform, host):
    values = {'name': '通知群', 'platform': platform, 'url': f'https://{host}/open-apis/bot/v2/hook/demo-token', 'secret': 'webhook-secret'}
    draft = NotificationHookDraft(**values)
    assert draft.platform == platform and draft.secret == 'webhook-secret'
    for url in (
        f'http://{host}/open-apis/bot/v2/hook/demo-token',
        f'https://{host}/open-apis/bot/v2/hook/',
        f'https://{host}/open-apis/bot/v2/hook/demo/extra',
        'https://receiver.example/open-apis/bot/v2/hook/demo',
        f'https://{host}:444/open-apis/bot/v2/hook/demo',
        f'https://{host}/open-apis/bot/v2/hook/demo#private',
        f'https://{host}/open-apis/bot/v2/hook/demo%2Fextra',
        f'https://{"open.larksuite.com" if platform == "feishu" else "open.feishu.cn"}/open-apis/bot/v2/hook/demo',
    ):
        with pytest.raises(ValidationError):
            NotificationHookDraft(**{**values, 'url': url})


@pytest.mark.parametrize('platform', ['feishu', 'lark'])
def test_card_payload_reuses_templates_links_escaping_and_event_labels(platform):
    hook = {'platform': platform, 'prefix': 'WorkStep', 'include_link': True,
            'markdown_template': '**{event_name}**\n\n{project_name}/{workflow_name}\n\n{task_title}\n\n{step_line}\n\n{task_link}'}
    snapshot = {'event': 'step_completed', 'project': {'name': '演示[项目]'}, 'workflow': {'name': '流程'},
                'task': {'title': '**任务** {event}'}, 'step': {'name': '测试'},
                'occurred_at': '2026-10-23T00:00:00+00:00', 'task_url': 'https://work.example/tasks?id=demo'}
    payload = notification_payload(hook, snapshot)
    assert payload['msg_type'] == 'interactive' and 'markdown' not in payload
    assert payload['card']['header']['title'] == {'tag': 'plain_text', 'content': 'WorkStep · 步骤完成'}
    text = payload['card']['elements'][0]['text']['content']
    assert '**步骤完成**' in text and '演示\\[项目\\]/流程' in text
    assert '\\*\\*任务\\*\\* {event}' in text and '步骤：测试' in text
    assert '[查看任务](https://work.example/tasks?id=demo)' in text
    without = notification_payload({**hook, 'include_link': False}, {**snapshot, 'step': None})
    assert 'https://' not in without['card']['elements'][0]['text']['content']
    assert 'timestamp' not in payload and 'sign' not in payload
    long = notification_payload({**hook, 'markdown_template': '\x00' * 8000}, snapshot)
    assert len(json.dumps(long, ensure_ascii=False).encode()) < 19700


@pytest.mark.parametrize('platform,host', [('feishu', 'open.feishu.cn'), ('lark', 'open.larksuite.com')])
@pytest.mark.parametrize('signed', [True, False])
async def test_send_uses_seconds_and_body_signature_without_mutating_preview(platform, host, signed):
    calls = []
    url = f'https://{host}/open-apis/bot/v2/hook/demo-token'
    payload = {'msg_type': 'interactive', 'card': {'elements': []}}
    def handle(request):
        calls.append(request)
        return httpx.Response(200, json={'code': 0, 'StatusCode': 0, 'msg': 'success'})
    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        await send_notification({'platform': platform, 'url': url, 'secret': 'webhook-secret' if signed else ''}, payload, client=client, now=1700000000.9)
    assert str(calls[0].url) == url and calls[0].method == 'POST'
    body = json.loads(calls[0].content)
    if signed:
        expected = base64.b64encode(hmac.new(b'1700000000\nwebhook-secret', b'', hashlib.sha256).digest()).decode()
        assert body['timestamp'] == '1700000000' and body['sign'] == expected
    else:
        assert body == payload
    assert payload == {'msg_type': 'interactive', 'card': {'elements': []}}


@pytest.mark.parametrize('body,retryable', [
    ({'code': 11232}, True), ({'code': -1}, True), ({'code': 19021}, False),
    ({'code': 19024}, False), ({'code': 9499}, False),
    ({'code': 19021, 'StatusCode': 0}, False), ({'code': False}, False), ({'errcode': 0}, False),
])
async def test_business_errors_use_feishu_code_and_redact_platform_details(body, retryable):
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, json={**body, 'msg': 'webhook-secret https://private.example/token'}))) as client:
        with pytest.raises(DeliveryError) as error:
            await send_notification({'platform': 'feishu', 'url': 'https://open.feishu.cn/open-apis/bot/v2/hook/demo'}, {}, client=client)
    assert error.value.retryable is retryable
    assert 'webhook-secret' not in str(error.value) and 'private.example' not in str(error.value)


async def test_legacy_success_response_is_supported():
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, json={'StatusCode': 0}))) as client:
        await send_notification({'platform': 'lark', 'url': 'https://open.larksuite.com/open-apis/bot/v2/hook/demo'}, {}, client=client)


@pytest.mark.parametrize('platform,host', [('feishu', 'open.feishu.cn'), ('lark', 'open.larksuite.com')])
async def test_saved_hook_preview_test_outbox_retry_and_slow_network_health(notification_app, platform, host):
    app, manager, project, flow, service, sent = notification_app
    root = f'/api/workflow/{flow["id"]}/notification-hooks'
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as api:
        hook = (await save(api, project, flow, [{'name': '研发通知', 'platform': platform,
            'url': f'https://{host}/open-apis/bot/v2/hook/demo', 'secret': 'webhook-secret',
            'events': ['completed'], 'markdown_template': '**{event_name}**\n{task_title}', 'include_link': False}]))[0]
        assert hook['secret'] == 'webhook-secret'
        loaded = (await api.get(root, params={'project_id': project.id})).json()['hooks'][0]
        assert loaded['platform'] == platform and loaded['secret'] == 'webhook-secret'
        preview = await api.post(root + '/preview', params={'project_id': project.id}, json={'hook': hook, 'event': 'completed', 'title': '修复登录校验'})
        assert preview.status_code == 200 and preview.json()['payload']['msg_type'] == 'interactive'
        assert not sent and 'webhook-secret' not in json.dumps(preview.json())
        await service.capture({'type': 'CUSTOM', 'name': 'workstep.task_lifecycle', 'project_id': project.id,
            'task_id': 'task', 'value': {'event': 'completed', 'event_id': 'feishu-completed'}})
        await service.deliver_due()
        assert sent[0][1] == preview.json()['payload']
        queued = await api.post(root + '/' + hook['id'] + '/test', params={'project_id': project.id})
        assert queued.status_code == 202
        entered, release = asyncio.Event(), asyncio.Event()
        calls = []
        async def handle(request):
            calls.append(json.loads(request.content))
            entered.set()
            await release.wait()
            return httpx.Response(200, json={'code': 11232 if len(calls) == 1 else 0})
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            async def sender(target, payload):
                await send_notification(target, payload, client=client)
            service.sender = sender
            pending = asyncio.create_task(service.deliver_due())
            try:
                await asyncio.wait_for(entered.wait(), 1)
                assert (await asyncio.wait_for(api.get('/health'), .5)).status_code == 200
            finally:
                release.set()
                await pending
            rows = await service.records(project.id, flow['id'], hook['id'])
            row = next(row for row in rows if row['id'] == queued.json()['delivery_id'])
            assert row['status'] == 'pending' and row['attempts'] == 1
            from models.notification_hook import NotificationDelivery
            await manager.run_db(project.id, lambda _: NotificationDelivery.update(next_at=0).where(NotificationDelivery.id == row['id']).execute())
            await service.deliver_due()
            row = next(item for item in await service.records(project.id, flow['id'], hook['id']) if item['id'] == queued.json()['delivery_id'])
            assert row['status'] == 'sent' and row['attempts'] == 2
            assert all('sign' in body and 'timestamp' in body for body in calls)
