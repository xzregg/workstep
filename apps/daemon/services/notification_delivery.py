"""Platform payloads and bounded async delivery; never expose target secrets in errors."""
import base64
import hashlib
import hmac
import json
import re
import time
from datetime import datetime, timezone
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx
from schemas.notification_hooks import EVENT_NAMES
from schemas.notification_template import DEFAULT_MARKDOWN_TEMPLATE, MAX_MARKDOWN_BYTES, TEMPLATE_VARIABLE


class DeliveryError(Exception):
    def __init__(self, message, *, retryable=False):
        super().__init__(message)
        self.retryable = retryable


def markdown_text(value):
    return re.sub(r'([\\`*\[\]<>])', r'\\\1', str(value).replace('\n',' ')[:500])


def notification_time(value):
    try:
        instant = datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return str(value)
    if instant.tzinfo is None:
        instant = instant.replace(tzinfo=timezone.utc)
    local = instant.astimezone()
    offset = local.strftime('%z')
    return f"{local:%Y-%m-%d %H:%M:%S} (UTC{offset[:3]}:{offset[3:]})"


def notification_payload(hook, snapshot):
    if not hook.get('include_link', True):
        snapshot = {**snapshot, 'task_url': None}
    title = (hook['prefix'] + ' · ' if hook['prefix'] else '') + EVENT_NAMES[snapshot['event']]
    if hook['platform'] == 'generic':
        return {**snapshot, 'notification_title': title}
    step_name = markdown_text(snapshot['step']['name'][:120]) if snapshot.get('step') else ''
    # Links come from installation addresses, never webhook credentials.
    url = (snapshot.get('task_url') or '').replace('(', '%28').replace(')', '%29')
    values = {
        'notification_title':markdown_text(title), 'event_name':EVENT_NAMES[snapshot['event']],
        'project_name':markdown_text(snapshot['project']['name'][:120]),
        'workflow_name':markdown_text(snapshot['workflow']['name'][:120]),
        'task_title':markdown_text(snapshot['task']['title']), 'step_name':step_name,
        'step_line':'步骤：' + step_name if step_name else '',
        'time':notification_time(snapshot['occurred_at']), 'occurred_at':snapshot['occurred_at'],
        'event':snapshot['event'], 'task_url':url, 'task_link':f'[查看任务]({url})' if url else '',
    }
    template = hook.get('markdown_template') or DEFAULT_MARKDOWN_TEMPLATE
    text = TEMPLATE_VARIABLE.sub(lambda match: values[match.group(1)], template)
    text = re.sub(r'\n{3,}', '\n\n', text).strip()
    text = text.encode()[:MAX_MARKDOWN_BYTES].decode('utf-8', errors='ignore')
    if hook['platform'] in {'feishu', 'lark'}:
        markdown = {'tag':'lark_md', 'content':text}
        payload = {'msg_type':'interactive', 'card':{
            'config':{'wide_screen_mode':True},
            'header':{'title':{'tag':'plain_text', 'content':title}},
            'elements':[{'tag':'div', 'text':markdown}],
        }}
        # JSON escaping can expand control characters; reserve room for signing.
        while len(json.dumps(payload, ensure_ascii=False).encode()) > 19500:
            markdown['content'] = markdown['content'][:len(markdown['content'])*3//4]
        return payload
    return {'msgtype':'markdown', 'markdown': {'title': title, 'text': text} if hook['platform']=='dingtalk' else {'content':text}}


async def send_notification(hook, payload, *, client=None, now=None):
    url = hook['url']
    feishu = hook['platform'] in {'feishu', 'lark'}
    if hook['platform'] == 'dingtalk' and hook.get('secret'):
        timestamp = str(int((time.time() if now is None else now)*1000))
        secret = hook['secret']
        sign = base64.b64encode(hmac.new(secret.encode(), f'{timestamp}\n{secret}'.encode(), hashlib.sha256).digest()).decode()
        parts = urlsplit(url)
        pairs = [(k,v) for k,v in parse_qsl(parts.query) if k not in {'timestamp','sign'}]
        url = urlunsplit(parts._replace(query=urlencode(pairs+[('timestamp',timestamp),('sign',sign)])))
    elif feishu and hook.get('secret'):
        timestamp = str(int(time.time() if now is None else now))
        key = f"{timestamp}\n{hook['secret']}".encode()
        sign = base64.b64encode(hmac.new(key, b'', hashlib.sha256).digest()).decode()
        payload = {**payload, 'timestamp':timestamp, 'sign':sign}
    async def post(session):
        try:
            async with session.stream('POST', url, json=payload, timeout=10, follow_redirects=False) as response:
                if not 200 <= response.status_code < 300:
                    raise DeliveryError(f'HTTP {response.status_code}', retryable=response.status_code in {408,429} or response.status_code>=500)
                if hook['platform'] == 'generic': return
                body = bytearray()
                async for chunk in response.aiter_bytes():
                    body.extend(chunk)
                    if len(body)>16384: raise DeliveryError('平台响应超过限制')
                try:
                    data = json.loads(body)
                    code = data.get('code', data.get('StatusCode')) if feishu else data.get('errcode')
                except (ValueError, AttributeError):
                    raise DeliveryError('平台响应格式无效') from None
                if type(code) is not int:
                    raise DeliveryError('平台响应格式无效')
                if code != 0:
                    retry_codes = {11232,-1} if feishu else {130101,45009,-1}
                    raise DeliveryError(f'平台错误码 {code}', retryable=code in retry_codes)
        except httpx.TimeoutException:
            raise DeliveryError('连接超时',retryable=True) from None
        except httpx.RequestError:
            raise DeliveryError('网络连接失败',retryable=True) from None
    if client is not None:
        await post(client)
    else:
        async with httpx.AsyncClient() as session:
            await post(session)
