"""Short-lived QR login receipts; credentials remain entirely in the daemon."""
import asyncio
import secrets
import time

from services.channels.weixin_api import ILinkClient, BASE_URL, api_url

# The workspace gateway waits 30s for response headers. Bound the entire poll,
# including lock contention and upstream I/O, so the browser can keep polling.
POLL_WAIT_SECONDS = 10


class WeixinLogin:
    def __init__(self):
        self.api = ILinkClient()
        self._sessions = {}

    def _prune(self):
        now = time.monotonic()
        self._sessions = {key: row for key, row in self._sessions.items() if row['expires'] > now}

    async def start(self, bot_id=''):
        self._prune()
        if len(self._sessions) >= 20:
            raise ValueError('扫码会话过多，请关闭已有二维码后重试')
        data = await self.api.request('get_bot_qrcode', params={'bot_type': '3'})
        if not data.get('qrcode') or not data.get('qrcode_img_content'):
            raise RuntimeError('微信 ClawBot 未返回有效二维码')
        login_id = secrets.token_urlsafe(32)
        self._sessions[login_id] = {'qrcode': data['qrcode'], 'qr_content': data['qrcode_img_content'],
            'bot_id': bot_id, 'status': 'wait', 'base_url': BASE_URL, 'expires': time.monotonic() + 480,
            'lock': asyncio.Lock()}
        return self._public(login_id, self._sessions[login_id])

    def _get(self, login_id):
        self._prune()
        if login_id not in self._sessions:
            raise ValueError('二维码已失效，请重新扫码')
        return self._sessions[login_id]

    @staticmethod
    def _public(login_id, row):
        return {'login_id': login_id, 'status': row['status'], 'qr_content': row['qr_content'],
                'account_id': row.get('credentials', {}).get('app_id', '')}

    async def poll(self, login_id):
        try:
            async with asyncio.timeout(POLL_WAIT_SECONDS):
                return await self._poll(login_id)
        except TimeoutError:
            return self._public(login_id, self._get(login_id))

    async def _poll(self, login_id):
        row = self._get(login_id)
        async with row['lock']:
            if row['status'] not in {'confirmed', 'expired'}:
                data = await self.api.request('get_qrcode_status', params={'qrcode': row['qrcode']}, base_url=row['base_url'])
                # Cancellation/deletion while the upstream request was pending must not revive a receipt.
                if self._get(login_id) is not row:
                    raise ValueError('二维码已失效，请重新扫码')
                status = data.get('status', 'wait')
                if status == 'scaned_but_redirect':
                    row['base_url'] = api_url('https://' + str(data.get('redirect_host', '')))
                    status = 'scaned'
                if status == 'confirmed':
                    account, token, owner = (str(data.get(key) or '').strip() for key in ('ilink_bot_id', 'bot_token', 'ilink_user_id'))
                    if not account or not token or not owner:
                        raise RuntimeError('微信 ClawBot 登录凭据不完整，请重新扫码')
                    row['credentials'] = {'app_id': account, 'secret': token, 'weixin_user_id': owner,
                        'weixin_base_url': api_url(data.get('baseurl') or BASE_URL)}
                row['status'] = status if status in {'wait', 'scaned', 'confirmed', 'expired'} else 'wait'
        return self._public(login_id, row)

    def credentials(self, login_id, bot_id=''):
        row = self._get(login_id)
        if row['status'] != 'confirmed' or row['bot_id'] != bot_id:
            raise ValueError('请完成此机器人的微信扫码授权')
        return dict(row['credentials'])

    def consume(self, login_id):
        self._sessions.pop(login_id, None)

    async def close(self):
        self._sessions.clear()
        await self.api.close()
