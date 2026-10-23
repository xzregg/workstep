"""Shared asynchronous lifecycle for text-only public chat bot adapters."""
import asyncio
import logging

import httpx

from services.channels.base import ChannelAdapter

logger = logging.getLogger(__name__)


def text_chunks(text, limit=1900):
    """Keep astral characters within platforms' UTF-16 length limits."""
    start, size = 0, 0
    for index, character in enumerate(text):
        width = 2 if ord(character) > 0xffff else 1
        if size + width > limit:
            yield text[start:index]
            start, size = index, 0
        size += width
    if text[start:]:
        yield text[start:]


class SocialAdapter(ChannelAdapter):
    def __init__(self, bot, on_message, on_state):
        super().__init__(bot, on_message, on_state)
        self._http = None
        self._http_lock = asyncio.Lock()
        self._task = None
        self._messages = set()

    async def _client(self):
        async with self._http_lock:
            if self._http is None:
                # Client construction loads the system TLS certificate store.
                self._http = await asyncio.to_thread(httpx.AsyncClient, timeout=40, follow_redirects=False)
            return self._http

    async def _request(self, method, url, **kwargs):
        # Telegram embeds its token in the URL; never expose HTTP exceptions.
        try:
            client = await self._client()
            response = await client.request(method, url, **kwargs)
            response.raise_for_status()
            data = response.json()
            if not isinstance(data, dict) or data.get('ok') is False:
                raise ValueError('invalid response')
            return data
        except (httpx.HTTPError, ValueError):
            raise RuntimeError(f'{self.DISPLAY_NAME} 接口请求失败，请检查凭证、权限及网络') from None

    async def start(self):
        if self._task is None:
            self._task = asyncio.create_task(self._run())

    async def stop(self):
        tasks = tuple(self._messages) + ((self._task,) if self._task else ())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self._task = None
        self._messages.clear()
        if self._http is not None:
            await self._http.aclose()
            self._http = None

    async def _run(self):
        while True:
            try:
                await self._on_state('connecting', '')
                await self._connect()
                await self._on_state('reconnecting', '')
            except asyncio.CancelledError:
                raise
            except Exception:
                # WebSocket errors can also contain credential-bearing URLs.
                await self._on_state('reconnecting', f'{self.DISPLAY_NAME} 连接中断，请检查凭证、权限及网络')
            await asyncio.sleep(5)

    def _dispatch(self, message):
        async def deliver():
            try:
                await self._on_message(message)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.warning('%s 消息处理失败', self.DISPLAY_NAME)
        task = asyncio.create_task(deliver())
        self._messages.add(task)
        task.add_done_callback(self._messages.discard)

    async def _drain_messages(self):
        await asyncio.gather(*tuple(self._messages))
