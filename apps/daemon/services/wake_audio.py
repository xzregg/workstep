"""Persist one bounded wake greeting for the host's current voice configuration."""
import asyncio
import hashlib
import json
import logging
import os
import tempfile
import time
from pathlib import Path

from services.digital_person import get_voice_wake
from services.speech_output import service as speech_output

logger = logging.getLogger(__name__)
MAX_AUDIO_CHARS = 1024 * 1024


class WakeAudioCache:
    def __init__(self, path: Path, speech):
        self.path = path
        self.speech = speech
        self.lock = asyncio.Lock()
        self.task: asyncio.Task | None = None
        self.key = None
        self.retry_after = 0.0

    def _read(self, key):
        try:
            with self.path.open('rb') as source:
                content = source.read(MAX_AUDIO_CHARS * 2 + 1)
            if len(content) <= MAX_AUDIO_CHARS * 2:
                saved = json.loads(content)
                if saved['key'] == key and isinstance(saved['chunks'], list) and saved['chunks']:
                    return saved['chunks']
        except (OSError, ValueError, TypeError, KeyError):
            pass
        return None

    def _write(self, key, chunks):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=self.path.parent, prefix='.wake-audio-', delete=False) as target:
            temporary = Path(target.name)
            try:
                target.write(json.dumps({'key': key, 'chunks': chunks}, separators=(',', ':')).encode())
                target.close()
                os.replace(temporary, self.path)
            finally:
                temporary.unlink(missing_ok=True)

    async def _generate(self, key, text, settings, previous):
        project, owner = '', 'wake-greeting'
        try:
            async with asyncio.timeout(120):
                if previous and not previous.done():
                    await asyncio.gather(previous, return_exceptions=True)
                sid = (await self.speech.start(project, owner, text, settings_snapshot=settings))['id']
                try:
                    chunks = []
                    size = 0
                    while True:
                        event = await self.speech.next(sid, project, owner)
                        if event.get('error'):
                            raise ValueError('Wake greeting synthesis failed')
                        if audio := event.get('audio'):
                            size += len(audio)
                            if size > MAX_AUDIO_CHARS or len(chunks) >= 512:
                                raise ValueError('Wake greeting exceeds its audio limit')
                            chunks.append({'audio': audio, 'format': event['format'], 'sampleRate': event['sample_rate']})
                        if event.get('done'):
                            break
                finally:
                    await self.speech.cancel(sid, project, owner)
                if not chunks:
                    raise ValueError('Wake greeting returned no audio')
                async with self.lock:
                    if self.key == key and self.task is asyncio.current_task():
                        await asyncio.to_thread(self._write, key, chunks)
        except asyncio.CancelledError:
            raise
        except Exception:
            if self.task is asyncio.current_task():
                self.retry_after = time.monotonic() + 15
            logger.warning('Unable to prepare the wake greeting audio')

    async def prepare(self, *, retry=False):
        async with self.lock:
            config = await asyncio.to_thread(get_voice_wake)
            text = config.get('greeting', '') if config.get('sound_enabled', True) else ''
            settings = await self.speech.settings() if text else None
            playback = {name: settings[name] for name in ('mode', 'rate', 'volume')} if settings else {}
            if not settings or settings['mode'] == 'system' or settings['volume'] <= 0:
                if self.task and not self.task.done():
                    self.task.cancel()
                self.key = None
                await asyncio.to_thread(self.path.unlink, missing_ok=True)
                status = 'none' if not settings or settings['volume'] <= 0 else 'system'
                return {'status': status, 'text': text, **playback}

            key = hashlib.sha256(json.dumps([text, settings], sort_keys=True).encode()).hexdigest()
            previous = self.task
            if key != self.key:
                if self.task and not self.task.done():
                    self.task.cancel()
                self.task = None
                self.key, self.retry_after = key, 0.0
            if chunks := await asyncio.to_thread(self._read, key):
                return {'status': 'ready', 'text': text, 'chunks': chunks, **playback}
            if not self.task or self.task.done():
                if not retry and time.monotonic() < self.retry_after:
                    return {'status': 'failed', 'text': text}
                self.task = asyncio.create_task(self._generate(key, text, settings, previous))
            return {'status': 'pending', 'text': text}

    async def close(self):
        if self.task and not self.task.done():
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)


wake_audio = WakeAudioCache(speech_output.root / 'wake-greeting.json', speech_output)
