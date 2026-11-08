"""Small asynchronous iLink client. Protocol reference: Hermes Weixin adapter.

Reference snapshot: NousResearch/hermes-agent a8b0bc15053c (MIT).
This client runs inside WorkStep; no OpenClaw runtime or relay is involved.
"""
import asyncio
import base64
import logging
import re
import secrets
from urllib.parse import urlsplit

import httpx

BASE_URL = 'https://ilinkai.weixin.qq.com'
VERSION = '2.2.0'


class _RedactQuery(logging.Filter):
    def filter(self, record):
        def clean(match):
            url = match.group(0)
            parsed = urlsplit(url)
            if (parsed.hostname or '').endswith(('.weixin.qq.com', '.qpic.cn', '.qlogo.cn', '.wx.qq.com')):
                return url.split('?', 1)[0] + '?[REDACTED]'
            return url
        message = record.getMessage()
        redacted = re.sub(r'https://[^\s"\']+\?[^\s"\']+', clean, message)
        if redacted != message:
            record.msg, record.args = redacted, ()
        return True


# QR poll identifiers and CDN signatures are bearer-like secrets in query strings.
logging.getLogger('httpx').addFilter(_RedactQuery())


def api_url(value):
    """Only send login credentials to Tencent's iLink HTTPS hosts."""
    try:
        parsed = urlsplit(value)
        host = parsed.hostname or ''
        if (parsed.scheme == 'https' and host.endswith('.weixin.qq.com')
                and parsed.port in (None, 443) and not parsed.username and not parsed.password
                and parsed.path in ('', '/') and not parsed.query and not parsed.fragment):
            return value.rstrip('/')
    except ValueError:
        pass
    raise ValueError('微信 ClawBot 接口地址无效')


class SessionExpired(RuntimeError):
    def __init__(self):
        super().__init__('微信 ClawBot 登录已失效，请重新扫码')


class ILinkClient:
    def __init__(self, token='', base_url=BASE_URL):
        self.token = token
        self.base_url = api_url(base_url)
        self.http = None
        self._lock = asyncio.Lock()

    async def client(self):
        async with self._lock:
            if self.http is None:
                self.http = await asyncio.to_thread(httpx.AsyncClient, timeout=40, follow_redirects=False)
            return self.http

    async def close(self):
        if self.http is not None:
            await self.http.aclose()
            self.http = None

    async def request(self, endpoint, *, payload=None, params=None, base_url=None):
        headers = {'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': str((2 << 16) | (2 << 8))}
        kwargs = {'params': params} if payload is None else {'json': {**payload, 'base_info': {'channel_version': VERSION}}}
        if payload is not None:
            headers.update({'AuthorizationType': 'ilink_bot_token',
                            'X-WECHAT-UIN': base64.b64encode(str(secrets.randbits(32)).encode()).decode()})
            if self.token:
                headers['Authorization'] = f'Bearer {self.token}'
        try:
            client = await self.client()
            response = await client.request('GET' if payload is None else 'POST',
                f'{api_url(base_url or self.base_url)}/ilink/bot/{endpoint}', headers=headers,
                timeout=40 if endpoint in {'getupdates', 'get_qrcode_status'} else 15, **kwargs)
            response.raise_for_status()
            data = response.json()
            if not isinstance(data, dict):
                raise ValueError('invalid response')
            if data.get('ret') == -14 or data.get('errcode') == -14:
                raise SessionExpired()
            if data.get('ret', 0) != 0 or data.get('errcode', 0) != 0:
                raise RuntimeError('微信 ClawBot 请求被拒绝，请检查登录状态或稍后重试')
            return data
        except httpx.ReadTimeout:
            if endpoint == 'getupdates':
                return {'msgs': [], 'get_updates_buf': payload.get('get_updates_buf', '')}
            if endpoint == 'get_qrcode_status':
                return {'status': 'wait'}
            raise RuntimeError('微信 ClawBot 请求超时') from None
        except (httpx.HTTPError, ValueError):
            # Never include request URLs, response bodies or credential values.
            raise RuntimeError('微信 ClawBot 请求失败，请检查网络后重试') from None
