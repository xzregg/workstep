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
                        raise DirectoryError('directory_too_large', 'The address book response is too large. Please reduce the application\'s authorization scope.')
            data = await self.work(json.loads, body)
            if data.get('errcode', data.get('code', 0)) not in (0, '0', None):
                raise DirectoryError('directory_permission', 'Contacts API rejected the request. Please check the application credentials, permissions, and visibility scope.')
            return data
        raise RuntimeError('Directory request exhausted')

    @staticmethod
    def client():
        return httpx.AsyncClient(timeout=httpx.Timeout(20, connect=5), follow_redirects=False)

    @staticmethod
    def add(people, id, name, departments, *, send=True):
        if not id or not name:
            raise DirectoryError('directory_incomplete', 'Contacts are missing a name or user ID; please check read permissions')
        key = str(id)
        old = people.get(key, {})
        people[key] = {'contact_id':key, 'name':str(name), 'user_id':key if send else '',
            'departments':sorted(set(old.get('departments', [])) | set(departments))}
        if len(people) > 50000:
            raise DirectoryError('directory_too_large', 'Address book exceeds 50,000 contacts. Please narrow the app\'s authorization scope.')

    @staticmethod
    def next_page(data, seen, key='page_token'):
        if not data.get('has_more'):
            return None
        token = data.get(key)
        if token is None or str(token) in seen:
            raise DirectoryError('directory_incomplete', 'Contact list pagination error, please try again later')
        seen.add(str(token))
        return token
