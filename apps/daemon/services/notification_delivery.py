"""Platform payloads and bounded async delivery; never expose target secrets in errors."""
import base64
import hashlib
import hmac
import json
import re
import time
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx
from schemas.notification_hooks import EVENT_NAMES


class DeliveryError(Exception):
    def __init__(self, message, *, retryable=False):
        super().__init__(message)
        self.retryable = retryable


def markdown_text(value):
    return re.sub(r'([\\`*\[\]<>])', r'\\\1', str(value).replace('\n',' ')[:500])


def notification_payload(hook, snapshot):
    if not hook.get('include_link', True):
        snapshot = {**snapshot, 'task_url': None}
    title = (hook['prefix'] + ' · ' if hook['prefix'] else '') + EVENT_NAMES[snapshot['event']]
    if hook['platform'] == 'generic':
        return {**snapshot, 'notification_title': title}
    lines = ['### ' + markdown_text(title), '项目：' + markdown_text(snapshot['project']['name'][:120]),
             '流程：' + markdown_text(snapshot['workflow']['name'][:120]), '任务：' + markdown_text(snapshot['task']['title'])]
    if snapshot.get('step'): lines.append('步骤：' + markdown_text(snapshot['step']['name'][:120]))
    lines.append('时间：' + snapshot['occurred_at'])
    text = '\n\n'.join(lines)
    text = text.encode()[:3000].decode('utf-8', errors='ignore')
    if snapshot.get('task_url'):
        # The base URL is installation configuration, never a webhook credential.
        url = snapshot['task_url'].replace('(', '%28').replace(')', '%29')
        if len((text + url).encode()) < 3900:
            text += '\n\n[查看任务](' + url + ')'
    return {'msgtype':'markdown', 'markdown': {'title': title, 'text': text} if hook['platform']=='dingtalk' else {'content':text}}


async def send_notification(hook, payload, *, client=None, now=None):
    url = hook['url']
    if hook['platform'] == 'dingtalk' and hook.get('secret'):
        timestamp = str(int((time.time() if now is None else now)*1000))
        secret = hook['secret']
        sign = base64.b64encode(hmac.new(secret.encode(), f'{timestamp}\n{secret}'.encode(), hashlib.sha256).digest()).decode()
        parts = urlsplit(url)
        pairs = [(k,v) for k,v in parse_qsl(parts.query) if k not in {'timestamp','sign'}]
        url = urlunsplit(parts._replace(query=urlencode(pairs+[('timestamp',timestamp),('sign',sign)])))
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
                    code = data.get('errcode')
                except (ValueError, AttributeError):
                    raise DeliveryError('平台响应格式无效') from None
                if code != 0:
                    safe_code = str(code) if isinstance(code,int) else '未知'
                    raise DeliveryError(f'平台错误码 {safe_code}', retryable=code in {130101,45009,-1})
        except httpx.TimeoutException:
            raise DeliveryError('连接超时',retryable=True) from None
        except httpx.RequestError:
            raise DeliveryError('网络连接失败',retryable=True) from None
    if client is not None:
        await post(client)
    else:
        async with httpx.AsyncClient() as session:
            await post(session)
