"""Directory provider protocol; adapters opt in with DIRECTORY_PROVIDER."""
from abc import ABC, abstractmethod
import asyncio
import json

import httpx

from services.channels.directory import DirectoryError


class ChannelDirectoryProvider(ABC):
    # Extra credential fields exposed as metadata, never values.
    fields = ()

    def __init__(self, bot, work):
        self.bot, self.work = bot, work

    @abstractmethod
    async def fetch_snapshot(self): ...

    async def request(self, client, method, url, **kwargs):
        for attempt in range(3):
            async with client.stream(method, url, **kwargs) as response:
                if response.status_code in (429, 502, 503, 504) and attempt < 2:
                    await asyncio.sleep(0.5 * 2 ** attempt)
                    continue
                response.raise_for_status()
                body = bytearray()
                async for chunk in response.aiter_bytes():
                    body.extend(chunk)
                    if len(body) > 16 * 1024 * 1024:
                        raise DirectoryError('directory_too_large', '通讯录响应过大，请缩小应用授权范围')
            data = await self.work(json.loads, body)
            if data.get('errcode', data.get('code', 0)) not in (0, '0', None):
                raise DirectoryError('directory_permission', '通讯录接口拒绝请求，请检查应用凭证、权限及可见范围')
            return data
        raise RuntimeError('Directory request exhausted')

    @staticmethod
    def client():
        return httpx.AsyncClient(timeout=httpx.Timeout(20, connect=5), follow_redirects=False)

    @staticmethod
    def add(people, id, name, departments, *, send=True):
        if not id or not name:
            raise DirectoryError('directory_incomplete', '通讯录缺少姓名或用户 ID，请检查读取权限')
        key = str(id)
        old = people.get(key, {})
        people[key] = {'contact_id':key, 'name':str(name), 'user_id':key if send else '',
            'departments':sorted(set(old.get('departments', [])) | set(departments))}
        if len(people) > 50000:
            raise DirectoryError('directory_too_large', '通讯录超过 50000 人，请缩小应用授权范围')

    @staticmethod
    def next_page(data, seen, key='page_token'):
        if not data.get('has_more'):
            return None
        token = data.get(key)
        if token is None or str(token) in seen:
            raise DirectoryError('directory_incomplete', '通讯录分页异常，请稍后重试')
        seen.add(str(token))
        return token
