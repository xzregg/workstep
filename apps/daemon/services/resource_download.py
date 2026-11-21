"""Resumable downloads for immutable, hash-pinned resources."""
import asyncio
import hashlib
import re
import shutil

from engines.core.process_cleanup import finish_cleanup


class ResourceDownload:
    def __init__(self, root, resource_id):
        if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_-]*', resource_id):
            raise ValueError('Invalid download resource identifier')
        self.folder = root / '.downloads' / resource_id
        self.stage = root / ('.install-' + resource_id)

    def cached_bytes(self):
        total = 0
        for part in self.folder.glob('*.part'):
            try:
                total += part.stat().st_size
            except FileNotFoundError:
                continue
        return total

    def discard(self):
        for path in (self.stage, self.folder):
            try:
                shutil.rmtree(path)
            except FileNotFoundError:
                continue
            except OSError as exc:
                raise ValueError('Failed to clean up resource download files. Please check disk permissions and try again:') from exc

    @staticmethod
    def append(path, chunk):
        with path.open('ab') as out:
            out.write(chunk)

    @staticmethod
    def matches(path, size, expected, kind):
        hasher = hashlib.sha256() if kind == 'sha256' else hashlib.sha1()
        if kind == 'git':
            hasher.update(f'blob {size}\0'.encode())
        with path.open('rb') as source:
            return hashlib.file_digest(source, lambda: hasher).hexdigest() == expected

    async def fetch(self, client, url, target, size, expected, state, kind='sha256'):
        length = {'sha256': 64, 'git': 40}.get(kind)
        if length is None or len(expected) != length or not re.fullmatch(r'[a-f0-9]+', expected) or size < 0:
            raise ValueError('Invalid resource download manifest')
        name = target.relative_to(self.stage) if target.is_relative_to(self.stage) else target.name
        # Include the manifest entry name so parallel entries with equal content have separate writers.
        key = hashlib.sha256(f'{name}:{kind}:{size}:{expected}'.encode()).hexdigest()
        part = self.folder / (key + '.part')

        def prepare():
            self.folder.mkdir(parents=True, exist_ok=True)
            target.parent.mkdir(parents=True, exist_ok=True)
            part.touch(exist_ok=True)
            count = part.stat().st_size
            if count > size:
                part.write_bytes(b'')
                return 0
            return count

        offset = await finish_cleanup(asyncio.to_thread(prepare))
        state['downloaded_bytes'] += offset
        while True:
            count = await self._transfer(client, url, part, offset, size, state) if offset < size else offset
            if count is not None:
                if count != size:
                    break
                if await finish_cleanup(asyncio.to_thread(self.matches, part, size, expected, kind)):
                    await finish_cleanup(asyncio.to_thread(shutil.copyfile, part, target))
                    return
            await finish_cleanup(asyncio.to_thread(part.unlink, missing_ok=True))
            state['downloaded_bytes'] -= count if count is not None else offset
            if not offset:
                break
            offset = 0
        raise ValueError('Resource validation failed')

    async def _transfer(self, client, url, part, offset, size, state):
        headers = {'Accept-Encoding': 'identity'}
        if offset:
            headers['Range'] = f'bytes={offset}-'
        async with client.stream('GET', url, headers=headers) as response:
            if offset and response.status_code == 416:
                return None
            response.raise_for_status()
            if response.headers.get('Content-Encoding', 'identity').lower() != 'identity':
                raise ValueError('Resource encoding does not support resumable transfers')
            if response.status_code == 206:
                match = re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)', response.headers.get('Content-Range', ''))
                if not offset or not match or tuple(map(int, match.groups())) != (offset, size - 1, size):
                    if offset:
                        return None
                    raise ValueError('Invalid resource scope')
            elif response.status_code == 200 and offset:
                # A mirror may ignore the Range header. Its body starts at zero.
                await finish_cleanup(asyncio.to_thread(part.unlink, missing_ok=True))
                state['downloaded_bytes'] -= offset
                offset = 0
            elif response.status_code != 200:
                raise ValueError('Invalid resource response')
            count = offset
            async for chunk in response.aiter_bytes():
                if count + len(chunk) > size:
                    await finish_cleanup(asyncio.to_thread(part.unlink, missing_ok=True))
                    state['downloaded_bytes'] -= count
                    raise ValueError('Resource size mismatch')
                await finish_cleanup(asyncio.to_thread(self.append, part, chunk))
                count += len(chunk)
                state['downloaded_bytes'] += len(chunk)
            return count
