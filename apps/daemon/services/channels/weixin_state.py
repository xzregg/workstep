"""Private bot-local polling state. All filesystem work runs in a worker."""
import asyncio
import hashlib
import json
import os
import tempfile


class WeixinState:
    def __init__(self, bot):
        from services.config import CONFIG_DIR
        identity = hashlib.sha256(f'{bot["id"]}:{bot["app_id"]}'.encode()).hexdigest()
        self.path = CONFIG_DIR / 'channels' / 'weixin' / f'{identity}.json'
        self.cursor = ''
        self.tokens = {}
        self._lock = asyncio.Lock()

    async def load(self):
        def read():
            try:
                value = json.loads(self.path.read_text('utf-8'))
                return value if isinstance(value, dict) else {}
            except (OSError, ValueError):
                return {}
        value = await asyncio.to_thread(read)
        self.cursor = value.get('cursor', '') if isinstance(value.get('cursor', ''), str) else ''
        self.tokens = {k: v for k, v in value.get('tokens', {}).items() if isinstance(k, str) and isinstance(v, str)} if isinstance(value.get('tokens'), dict) else {}

    def _write(self, value):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(dir=self.path.parent, prefix='.state-')
        try:
            with os.fdopen(fd, 'w') as stream:
                json.dump(value, stream)
            os.replace(temporary, self.path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    async def save(self):
        async with self._lock:
            write = asyncio.create_task(asyncio.to_thread(self._write, {'cursor': self.cursor, 'tokens': dict(self.tokens)}))
            try:
                await asyncio.shield(write)
            except asyncio.CancelledError:
                # Finish an in-flight atomic write before stop/delete can remove state.
                await write
                raise

    async def delete(self):
        await asyncio.to_thread(self.path.unlink, missing_ok=True)
