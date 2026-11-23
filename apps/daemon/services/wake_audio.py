"""Persist bounded wake greeting audio for the host's current voice configuration."""
import asyncio
import base64
import hashlib
import io
import json
import logging
import math
import os
import struct
import tempfile
import time
import wave
from pathlib import Path

from services.digital_person import get_voice_wake
from services.speech_output import service as speech_output

logger = logging.getLogger(__name__)
MAX_AUDIO_CHARS = 1024 * 1024


def normalize_greeting(chunks):
    """Match the level across a complete 16-bit greeting, preserving its chunk boundaries."""
    raw = [base64.b64decode(chunk['audio'], validate=True) for chunk in chunks]
    if all(chunk['format'] == 'pcm' for chunk in chunks):
        packets = [b''.join(raw)]
        wave_params = []
    elif all(chunk['format'] == 'wav' for chunk in chunks):
        packets, wave_params = [], []
        for data in raw:
            with wave.open(io.BytesIO(data), 'rb') as source:
                if source.getsampwidth() != 2:
                    raise ValueError('Wake greeting normalization requires 16-bit WAV')
                wave_params.append(source.getparams())
                packets.append(source.readframes(source.getnframes()))
    else:
        raise ValueError('Wake greeting normalization requires a single audio format')
    samples = [struct.unpack(f'<{len(data) // 2}h', data) for data in packets]
    count = sum(map(len, samples))
    energy = sum(sample * sample for packet in samples for sample in packet)
    if not energy or not count:
        return chunks
    rms = math.sqrt(energy / count) / 32768
    gain = min(8, max(1, .16 / rms))

    def limit(value):
        level = abs(value) * gain / 32768
        if level > .68:
            level = .68 + .22 * math.tanh((level - .68) / .22)
        return round(math.copysign(level * 32767, value))

    encoded = [struct.pack(f'<{len(packet)}h', *map(limit, packet)) for packet in samples]
    if wave_params:
        for index, params in enumerate(wave_params):
            target = io.BytesIO()
            with wave.open(target, 'wb') as output:
                output.setparams(params)
                output.writeframes(encoded[index])
            encoded[index] = target.getvalue()
    else:
        data = encoded[0]
        encoded = []
        offset = 0
        for packet in raw:
            end = offset + len(packet)
            encoded.append(data[offset:end])
            offset = end
    return [{**chunk, 'audio': base64.b64encode(data).decode()} for chunk, data in zip(chunks, encoded)]


class WakeAudioCache:
    def __init__(self, path: Path, speech):
        self.path = path
        self.speech = speech
        self.lock = asyncio.Lock()
        self.task: asyncio.Task | None = None
        self.key = None
        self.retry_after = 0.0

    def _read(self, key, phrases, single):
        try:
            with self.path.open('rb') as source:
                content = source.read(MAX_AUDIO_CHARS * 2 + 1)
            if len(content) <= MAX_AUDIO_CHARS * 2:
                saved = json.loads(content)
                if saved['key'] != key:
                    return None
                if single and isinstance(saved['chunks'], list) and saved['chunks']:
                    return self._ready(key, saved, {'chunks': saved['chunks']})
                if not single:
                    alternatives = saved['alternatives']
                    if [item['text'] for item in alternatives] == phrases and all(
                        isinstance(item['chunks'], list) and item['chunks'] for item in alternatives
                    ):
                        return self._ready(key, saved, {'alternatives': alternatives})
        except (OSError, ValueError, TypeError, KeyError):
            pass
        return None

    def _ready(self, key, saved, audio):
        if 'normalized' in saved:
            return {**audio, 'normalized': saved['normalized']}
        return self._write_normalized(key, audio)

    def _write_normalized(self, key, audio):
        entries = audio.get('alternatives') or [audio]
        try:
            normalized = [normalize_greeting(entry['chunks']) for entry in entries]
        except (ValueError, struct.error, wave.Error, EOFError):
            audio['normalized'] = False
        else:
            for entry, chunks in zip(entries, normalized):
                entry['chunks'] = chunks
            audio['normalized'] = True
        self._write(key, audio)
        return audio

    def _write(self, key, audio):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=self.path.parent, prefix='.wake-audio-', delete=False) as target:
            temporary = Path(target.name)
            try:
                target.write(json.dumps({'key': key, **audio}, separators=(',', ':')).encode())
                target.close()
                os.replace(temporary, self.path)
            finally:
                temporary.unlink(missing_ok=True)

    async def _generate(self, key, phrases, single, settings, previous):
        project, owner = '', 'wake-greeting'
        try:
            async with asyncio.timeout(120):
                if previous and not previous.done():
                    await asyncio.gather(previous, return_exceptions=True)
                alternatives = []
                size = count = 0
                for phrase in phrases:
                    sid = (await self.speech.start(project, owner, phrase, settings_snapshot=settings))['id']
                    try:
                        chunks = []
                        while True:
                            event = await self.speech.next(sid, project, owner)
                            if event.get('error'):
                                raise ValueError('Wake greeting synthesis failed')
                            if audio := event.get('audio'):
                                size += len(audio)
                                count += 1
                                if size > MAX_AUDIO_CHARS or count > 512:
                                    raise ValueError('Wake greeting exceeds its audio limit')
                                chunks.append({'audio': audio, 'format': event['format'], 'sampleRate': event['sample_rate']})
                            if event.get('done'):
                                break
                    finally:
                        await self.speech.cancel(sid, project, owner)
                    if not chunks:
                        raise ValueError('Wake greeting returned no audio')
                    alternatives.append({'text': phrase, 'chunks': chunks})
                audio = {'chunks': alternatives[0]['chunks']} if single else {'alternatives': alternatives}
                async with self.lock:
                    if self.key == key and self.task is asyncio.current_task():
                        await asyncio.to_thread(self._write_normalized, key, audio)
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
            parts = (part.strip() for part in text.replace('｜', '|').split('|'))
            phrases = list(dict.fromkeys(part for part in parts if part))
            settings = await self.speech.settings() if phrases else None
            playback = {name: settings[name] for name in ('mode', 'rate', 'volume')} if settings else {}
            if not settings or settings['mode'] == 'system' or settings['volume'] <= 0:
                if self.task and not self.task.done():
                    self.task.cancel()
                self.key = None
                await asyncio.to_thread(self.path.unlink, missing_ok=True)
                status = 'none' if not settings or settings['volume'] <= 0 else 'system'
                return {'status': status, 'text': text, **playback}

            single = phrases == [text]
            key = hashlib.sha256(json.dumps([text if single else phrases, settings], sort_keys=True).encode()).hexdigest()
            previous = self.task
            if key != self.key:
                if self.task and not self.task.done():
                    self.task.cancel()
                self.task = None
                self.key, self.retry_after = key, 0.0
            if audio := await asyncio.to_thread(self._read, key, phrases, single):
                return {'status': 'ready', 'text': text, **audio, **playback}
            if not self.task or self.task.done():
                if not retry and time.monotonic() < self.retry_after:
                    return {'status': 'failed', 'text': text}
                self.task = asyncio.create_task(self._generate(key, phrases, single, settings, previous))
            return {'status': 'pending', 'text': text}

    async def close(self):
        if self.task and not self.task.done():
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)


wake_audio = WakeAudioCache(speech_output.root / 'wake-greeting.json', speech_output)
