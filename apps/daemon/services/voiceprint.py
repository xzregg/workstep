"""Host-local speaker verification. Persist only encrypted embeddings, never audio."""
from __future__ import annotations

import asyncio
import json
import math
import os
import shutil
import sys
import uuid
from pathlib import Path

import httpx
from cryptography.fernet import Fernet

from engines.core.process_cleanup import finish_cleanup, terminate_owned_process
from services.resource_download import ResourceDownload
from services.speech_runtime import SpeechRuntime
from services.voice_model_source import HUGGING_FACE, model_origin

MODEL = '3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx'
REVISION = 'a8055d6daef723a6a4ecf4de233708575bf4994f'
SIZE = 28281165
SHA256 = '53cab20ba8f2eb2f6e2d89ecc18e88ef3222169b61b4419cbc13666744a4574b'
SOURCE = 'https://modelscope.cn/models/iic/speech_campplus_sv_zh_en_16k-common_advanced'
MAX_AUDIO = 16000 * 2 * 20
MIN_VERIFY_SAMPLES = 16000
MIN_ENROLL_SAMPLES = 16000 * 6
THRESHOLD = .5


def normalized(vector):
    if not isinstance(vector, list) or not 1 <= len(vector) <= 1024:
        raise ValueError('voiceprint.invalidFeatures')
    if any(not isinstance(x, (float, int)) or not math.isfinite(x) for x in vector):
        raise ValueError('voiceprint.invalidFeatures')
    norm = math.sqrt(sum(x*x for x in vector))
    if norm <= 1e-8:
        raise ValueError('voiceprint.invalidFeatures')
    return [x/norm for x in vector]


class VoiceprintService:
    def __init__(self, speech_root: Path, runtime_path):
        self.root = speech_root / 'voiceprint'
        self.runtime_path = runtime_path
        self.resources = ResourceDownload(speech_root, 'voiceprint-campplus')
        self.lock = asyncio.Lock()
        self.worker = SpeechRuntime()
        self.task = None
        self.install = dict(stage='idle', downloaded_bytes=0, total_bytes=SIZE, error='')

    def available(self):
        try:
            return ((self.root / MODEL).stat().st_size == SIZE
                    and (self.runtime_path() / 'sherpa_onnx').is_dir())
        except (OSError, ValueError):
            return False

    def _read(self):
        try:
            data = (self.root / 'profile.enc').read_bytes()
        except FileNotFoundError:
            return dict(enabled=False, scope='calls')
        try:
            profile = json.loads(Fernet((self.root / 'vault.key').read_bytes()).decrypt(data))
            if profile.get('model') != REVISION or profile.get('scope') not in ('calls', 'all'):
                raise ValueError()
            profile['embedding'] = normalized(profile['embedding'])
            return profile
        except Exception as error:
            raise ValueError('voiceprint.profileUnavailable') from error

    def _write(self, profile):
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        key = self.root / 'vault.key'
        try:
            fd = os.open(key, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            pass
        else:
            with os.fdopen(fd, 'wb') as file:
                file.write(Fernet.generate_key())
        stage = self.root / ('.profile-' + uuid.uuid4().hex)
        try:
            fd = os.open(stage, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            with os.fdopen(fd, 'wb') as file:
                file.write(Fernet(key.read_bytes()).encrypt(json.dumps(profile).encode()))
            stage.replace(self.root / 'profile.enc')
        finally:
            stage.unlink(missing_ok=True)

    async def profile(self):
        return await asyncio.to_thread(self._read)

    async def snapshot(self):
        error = ''
        try:
            profile = await self.profile()
        except ValueError:
            # Keep deletion reachable without allowing a corrupt profile to
            # silently disable verification in the recording path.
            profile = dict(enabled=False, scope='calls', embedding=True)
            error = 'voiceprint.profileUnavailable'
        def state():
            return dict(available=self.available(), runtime_available=(self.runtime_path() / 'sherpa_onnx').is_dir(),
                        install={**self.install, 'partial_bytes': self.resources.cached_bytes()})
        return dict(await asyncio.to_thread(state), enrolled=bool(profile.get('embedding')),
                    enabled=bool(profile.get('enabled')), scope=profile.get('scope', 'calls'),
                    model_bytes=SIZE, source=SOURCE, error=error)

    async def configure(self, enabled, scope):
        async with self.lock:
            profile = await self.profile()
            if scope not in ('calls', 'all'):
                raise ValueError('voiceprint.invalidScope')
            if enabled and (not profile.get('embedding') or not await asyncio.to_thread(self.available)):
                raise ValueError('voiceprint.enrollFirst')
            if not profile.get('embedding'):
                return
            await finish_cleanup(asyncio.to_thread(self._write, {**profile, 'enabled': enabled, 'scope': scope}))

    async def delete(self):
        async with self.lock:
            def remove():
                (self.root / 'profile.enc').unlink(missing_ok=True)
                (self.root / 'vault.key').unlink(missing_ok=True)
            await finish_cleanup(asyncio.to_thread(remove))

    @staticmethod
    def validate_audio(pcm):
        if not pcm or len(pcm) % 2 or len(pcm) > MAX_AUDIO:
            raise ValueError('voiceprint.invalidAudio')

    async def extract(self, pcm):
        self.validate_audio(pcm)
        if not await asyncio.to_thread(self.available):
            raise ValueError('voiceprint.downloadFirst')
        command = [sys.executable, '-I', str(Path(__file__).with_name('voiceprint_worker.py')),
                   str(await asyncio.to_thread(self.runtime_path)), str(self.root / MODEL)]
        try:
            raw = await self.worker.infer(command, pcm, uuid.uuid4().hex, True)
            return json.loads(raw)
        finally:
            await self.worker.close()

    async def enroll(self, pcm):
        self.validate_audio(pcm)
        async with self.lock:
            result = await self.extract(pcm)
            if result['voiced_samples'] < MIN_ENROLL_SAMPLES:
                raise ValueError('voiceprint.needMoreSpeech')
            vector = normalized(result['embedding'])
            previous = await self.profile()
            await finish_cleanup(asyncio.to_thread(self._write, dict(model=REVISION, embedding=vector,
                enabled=previous.get('enabled', False), scope=previous.get('scope', 'calls'))))

    async def verify(self, pcm, profile=None):
        self.validate_audio(pcm)
        async with self.lock:
            profile = profile or await self.profile()
            if not profile.get('embedding'):
                raise ValueError('voiceprint.enrollFirst')
            result = await self.extract(pcm)
            if result['voiced_samples'] < MIN_VERIFY_SAMPLES:
                return 'insufficient'
            vector, reference = normalized(result['embedding']), normalized(profile['embedding'])
            if len(vector) != len(reference):
                raise ValueError('voiceprint.invalidFeatures')
            return 'matched' if sum(a*b for a, b in zip(vector, reference)) >= THRESHOLD else 'unmatched'

    async def download(self, mirror=None):
        if self.task and not self.task.done():
            return
        origin = model_origin(mirror)
        if not await asyncio.to_thread(lambda: (self.runtime_path() / 'sherpa_onnx').is_dir()):
            raise ValueError('voiceprint.runtimeRequired')
        if await asyncio.to_thread(self.available):
            return
        self.install = dict(stage='downloading', downloaded_bytes=0, total_bytes=SIZE, error='')
        self.task = asyncio.create_task(self._download(origin))

    async def _download(self, origin):
        try:
            url = f'{origin}/csukuangfj/speaker-embedding-models/resolve/{REVISION}/{MODEL}'
            stage = self.resources.stage
            await asyncio.to_thread(stage.mkdir, parents=True, exist_ok=True)
            async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
                await self.resources.fetch(client, url, stage / MODEL, SIZE, SHA256, self.install)
            self.install['stage'] = 'installing'
            await self._check_model(stage / MODEL)
            def publish():
                self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
                (stage / MODEL).replace(self.root / MODEL)
                (self.root / 'source.txt').write_text(f'CAMPPlus speaker verification\nUpstream: {SOURCE}\n'
                    f'ONNX conversion: {HUGGING_FACE}/csukuangfj/speaker-embedding-models/tree/{REVISION}\n')
                self.install['stage'] = 'installed'
            await finish_cleanup(asyncio.to_thread(publish))
            await asyncio.to_thread(self.resources.discard)
        except asyncio.CancelledError:
            if self.install['stage'] != 'installed':
                self.install['stage'] = 'cancelled'
            raise
        except Exception:
            self.install.update(stage='error', error='voiceprint.downloadFailed')
        finally:
            await finish_cleanup(asyncio.to_thread(shutil.rmtree, self.resources.stage, True))

    async def _check_model(self, path):
        runtime = await asyncio.to_thread(self.runtime_path)
        proc = None
        async def spawn():
            nonlocal proc
            proc = await asyncio.create_subprocess_exec(sys.executable, '-I',
                str(Path(__file__).with_name('voiceprint_worker.py')), str(runtime), str(path), '--check',
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
        try:
            await finish_cleanup(spawn())
            if await asyncio.wait_for(proc.wait(), 30) != 0:
                raise ValueError('voiceprint.downloadFailed')
        finally:
            if proc is not None and proc.returncode is None:
                await finish_cleanup(terminate_owned_process(proc))

    async def cancel_download(self):
        if self.task and not self.task.done():
            self.task.cancel()
            await finish_cleanup(asyncio.gather(self.task, return_exceptions=True))

    async def close(self):
        await self.cancel_download()
        await self.worker.close()
