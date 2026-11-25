"""On-demand, isolated local speech recognition. Audio is never persisted."""
from __future__ import annotations

import asyncio
import hashlib
import json
import shutil
import sys
import time
import uuid
import zipfile
from pathlib import Path

import httpx
from packaging.tags import sys_tags
from packaging.utils import parse_wheel_filename

from services.config import CONFIG_DIR
from services.speech_runtime import SpeechRuntime
from services.voiceprint import VoiceprintService, MAX_AUDIO as MAX_VOICEPRINT_AUDIO, MIN_VERIFY_SAMPLES
from services.voice_model_source import HUGGING_FACE, model_origin
from services.resource_download import ResourceDownload
from services.speech_remote import RemoteSpeechRuntime
from services import speech_connection
from services import speech_profiles
from engines.core.process_cleanup import finish_cleanup, terminate_owned_process

MODEL_ID = 'streaming-paraformer-zh-yue-en-int8'
REVISION = '86931b152d37c908528b44d30b431c24a19770da'
MODEL_BASE = f'https://huggingface.co/csukuangfj/sherpa-onnx-streaming-paraformer-trilingual-zh-cantonese-en/resolve/{REVISION}'
MODEL_FILES = [
    ('encoder.int8.onnx', 166362800, '6047a644b41b236d9d8e89e3b94ef39d1b7037daab028131b722ca52e10b0357'),
    ('decoder.int8.onnx', 72062549, '545427acf508452b7d89969be082c8128c681e3432ff43aef09f6159f4b61a7e'),
    ('tokens.txt', 81289, '45b31504211675dd52aa88f998a6f6161703a2834e86760c1cda645a22538085'),
    ('README.md', 1082, '2958ed2800cdf9be3d8e3aeef40b7457f792060e9bcf58118b0b2591ee84143b'),
]
# Identical SHA256 verified against the official sherpa-onnx punctuation release.
PUNCTUATION_URL = ('https://huggingface.co/ranger810/'
                   'sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12-int8/'
                   'resolve/5cccf43af83e4fc50d1d55b8410312e87709be70/model.int8.onnx')
PUNCTUATION_FILE = ('punctuation.int8.onnx', 75519198,
                    '65a3fb9f5ad7bfb96bf69e0dc4481df97f6ee60513c1d94ce981ba6effd524b1')
PACKAGES = [('sherpa-onnx', '1.12.32'), ('sherpa-onnx-core', '1.12.32'),
            ('numpy', '2.3.5' if sys.version_info >= (3, 14) else '2.2.6')]
# This multilingual streaming model auto-detects; its decoder has no forced-language option.
LANGUAGES = ('auto',)
MODEL_LANGUAGES = ('zh', 'yue', 'en')
SAMPLE_RATE = 16000
MAX_SESSIONS = 4
MAX_BYTES = SAMPLE_RATE * 2 * 120
MAX_FRAME = SAMPLE_RATE * 2 * 8
RESOURCE_VERSION = '1'


SENSEVOICE_ID = 'sensevoice-small-2024-07-17-int8'
SENSEVOICE_SOURCE = 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17'
MODELS = {
    SENSEVOICE_ID: dict(name='SenseVoiceSmall INT8', kind='sensevoice',
        base=f'{SENSEVOICE_SOURCE}/resolve/6a65851692da9706cbddfac66ea9b96ebb1dee21',
        languages=['zh', 'en', 'yue', 'ja', 'ko'], license_url=SENSEVOICE_SOURCE,
        streaming='segment', files=[
            ('model.int8.onnx', 239233841, 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51'),
            ('tokens.txt', 315894, 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc'),
        ]),
    MODEL_ID: dict(name='Streaming Paraformer 三语版 INT8', kind='paraformer', base=MODEL_BASE,
                   languages=['zh', 'yue', 'en'],
                   license_url='https://modelscope.cn/models/dengcunqin/speech_paraformer-large_asr_nat-zh-cantonese-en-16k-vocab8501-online/summary'),
}

def model_spec(model_id):
    if model_id not in MODELS:
        raise ValueError('Unsupported voice model')
    return MODELS[model_id]


def unpack_wheel(path: Path, target: Path):
    """Only unpack verified binary wheels; no setup scripts or executable .pth."""
    with zipfile.ZipFile(path) as archive:
        for item in archive.infolist():
            parts = Path(item.filename).parts
            if (not parts or Path(item.filename).is_absolute() or '..' in parts
                    or (item.external_attr >> 16) & 0o170000 == 0o120000):
                raise ValueError('Runtime library contains an invalid path')
            if item.filename.endswith('.pth'):
                raise ValueError('Runtime library contains unsupported startup file')
        archive.extractall(target)


class SpeechService:
    def __init__(self, root: Path | None = None, model_id: str = SENSEVOICE_ID):
        self.root = root or CONFIG_DIR / 'speech'
        self._use_model(model_id)
        self.settings: dict | None = None
        self.install_state: dict = {'stage': 'idle', 'downloaded_bytes': 0, 'total_bytes': None, 'error': ''}
        self.install_states = {model_id: self.install_state}
        self.install_target = model_id
        self.download_task: asyncio.Task | None = None
        self.download_origin = HUGGING_FACE
        self.sessions: dict[str, dict] = {}
        self.workers: list[SpeechRuntime] = []
        self.session_lock = asyncio.Lock()
        self.last_used = time.monotonic()
        self.reaper: asyncio.Task | None = None
        self.voiceprint = VoiceprintService(self.root, self.voiceprint_runtime)

    def voiceprint_runtime(self):
        # Reuse an installed isolated CPU runtime; never import it in daemon.
        for mid in MODELS:
            runtime = self.root / mid / 'runtime'
            if (runtime / 'sherpa_onnx').is_dir():
                return runtime
        return self.bundle / 'runtime'

    def _use_model(self, model_id):
        self.model = model_spec(model_id)
        self.model_id = model_id
        self.bundle = self.root / model_id
        self.model_download = ResourceDownload(self.root, model_id)

    @property
    def files(self):
        return MODEL_FILES if self.model_id == MODEL_ID else self.model['files']

    @property
    def segment_model(self):
        return self.model.get('streaming') == 'segment'

    def streaming(self, connection):
        if connection['mode'] == 'local':
            return self.model.get('streaming', 'native')
        return 'final' if connection['provider'] == 'openai' else 'native'

    def model_installed(self, model_id):
        model_spec(model_id)
        return self.installed() if model_id == self.model_id else SpeechService(self.root, model_id).installed()

    async def get_settings(self):
        if self.settings is None:
            saved = await asyncio.to_thread(speech_connection.read, self.root)
            if self.settings is None:
                if saved.get('model_id') in MODELS:
                    self._use_model(saved['model_id'])
                self.settings = {'enabled': bool(saved.get('enabled', False)),
                                 'model_id': self.model_id,
                                 'language': saved.get('language', 'auto') if saved.get('language', 'auto') in LANGUAGES else 'auto',
                                 'connection': saved.get('connection', dict(speech_connection.DEFAULTS)),
                                 'connections': saved.get('connections', [])}
        return {**self.settings, 'connection': {**speech_connection.DEFAULTS, **self.settings.get('connection', {})}}

    async def configure(self, enabled: bool, language: str, model_id: str | None = None, connection=None):
        async with self.session_lock:
            return await finish_cleanup(self._configure(enabled, language, model_id, connection))

    async def _configure(self, enabled: bool, language: str, model_id: str | None = None, connection=None):
        if self.sessions:
            raise ValueError('Voice settings cannot be modified during recording')
        if language not in LANGUAGES:
            raise ValueError('Unsupported recognition language')
        current = await self.get_settings()
        profiles = current['connections']
        connection = speech_connection.validate(connection, profiles) if connection is not None else current['connection']
        if connection['mode'] != 'local' and (await self.voiceprint.profile()).get('enabled'):
            raise ValueError('voiceprint.localOnly')
        target = model_id or self.model_id
        model_spec(target)
        if self.download_task and not self.download_task.done():
            raise ValueError('Cannot switch language settings during installation')
        if connection['mode'] == 'local' and target != self.model_id and not await asyncio.to_thread(self.model_installed, target):
            raise ValueError('Please download the selected voice model first')
        value = {'enabled': enabled, 'language': language, 'model_id': target, 'connection': connection,
                 'connections': speech_profiles.remember(profiles, connection)}
        await asyncio.to_thread(speech_connection.save, self.root, value)
        self.settings = value
        if target != self.model_id or connection != current['connection']:
            await self.stop_worker()
            self._use_model(target)
        if not enabled:
            await self.stop_worker()
        return {**value, 'connection': speech_profiles.public(connection),
                'connections': [speech_profiles.public(row) for row in value['connections']]}

    async def connection_secret(self, target, field):
        settings = await self.get_settings()
        return speech_profiles.find(settings['connections'], {**speech_connection.DEFAULTS, **target}).get(field, '')

    def installed(self):
        try:
            marker = json.loads((self.bundle / 'installed.json').read_text())
            return (marker['version'] == RESOURCE_VERSION
                    and marker['python'] == f'{sys.version_info.major}.{sys.version_info.minor}'
                    and all((self.bundle / name).stat().st_size == size for name, size, _ in self.files)
                    and (self.bundle / 'runtime' / 'sherpa_onnx').is_dir())
        except (OSError, ValueError, KeyError):
            return False

    def punctuation_installed(self):
        try:
            return (self.bundle / PUNCTUATION_FILE[0]).stat().st_size == PUNCTUATION_FILE[1]
        except OSError:
            return False

    async def snapshot(self):
        settings = await self.get_settings()
        def models():
            rows = []
            for mid, spec in MODELS.items():
                resource = self if mid == self.model_id else SpeechService(self.root, mid)
                punctuation = {} if resource.segment_model else {'punctuation': resource.punctuation_installed()}
                rows.append(dict(id=mid, name=spec['name'], license='模型来源与使用说明',
                    license_url=spec['license_url'], languages=spec['languages'],
                    model_bytes=sum(f[1] for f in resource.files) + (0 if resource.segment_model else PUNCTUATION_FILE[1]),
                    installed=resource.installed(), **punctuation,
                    streaming=spec.get('streaming', 'native'), install=dict(
                        self.install_states.get(mid, {'stage': 'idle', 'downloaded_bytes': 0, 'total_bytes': None, 'error': ''}),
                        partial_bytes=resource.model_download.cached_bytes())))
            return rows
        connection = settings['connection']
        try:
            speech_connection.validate(connection)
            configured = True
        except ValueError:
            configured = False
        local = connection['mode'] == 'local'
        ready = settings['enabled'] and (await asyncio.to_thread(self.installed) if local else configured)
        return {**settings, 'connection': speech_profiles.public(connection),
                'connections': [speech_profiles.public(row) for row in settings['connections']],
                'providers': speech_connection.PROVIDERS,
                'ready': ready, 'streaming': self.streaming(connection),
                'model_id': self.model_id, 'languages': list(LANGUAGES),
                'service': 'busy' if self.sessions else 'ready' if any(w.process and w.process.returncode is None for w in self.workers) else 'stopped',
                'active_sessions': len(self.sessions), 'max_sessions': MAX_SESSIONS,
                'voiceprint': await self.voiceprint.snapshot(),
                'models': await asyncio.to_thread(models)}

    async def download(self, model_id: str | None = None, mirror: str | None = None):
        async with self.session_lock:
            await self._begin_download(model_id, model_origin(mirror))

    async def _begin_download(self, model_id: str | None = None, origin: str = HUGGING_FACE):
        await self.get_settings()
        target = model_id or self.model_id
        model_spec(target)
        if self.sessions:
            raise ValueError('Cannot install models during recording')
        if self.download_task and not self.download_task.done():
            if target != self.install_target:
                raise ValueError('Please wait for the current model download to complete or cancel the download')
            return
        resource = self if target == self.model_id else SpeechService(self.root, target)
        if await asyncio.to_thread(resource.installed) and (resource.segment_model or await asyncio.to_thread(resource.punctuation_installed)):
            return
        await self.stop_worker()
        self.install_state = {'stage': 'resolving', 'downloaded_bytes': 0, 'total_bytes': None, 'error': ''}
        self.install_target = target
        self.install_states[target] = self.install_state
        resource.install_state = self.install_state
        resource.download_origin = origin
        self.download_task = asyncio.create_task(resource._download())

    async def _download(self):
        stage = self.model_download.stage
        try:
            def prepare():
                shutil.rmtree(stage, ignore_errors=True)
                stage.mkdir(parents=True)
            await finish_cleanup(asyncio.to_thread(prepare))
            await self._install(stage)
            if not self.segment_model:
                await asyncio.to_thread((stage / 'punctuation-source.txt').write_text,
                    'CT-Transformer Chinese/English INT8 punctuation model.\n'
                    'Upstream model and usage terms: https://modelscope.cn/models/iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch/summary\n'
                    'Conversion: https://k2-fsa.github.io/sherpa/onnx/punctuation/pretrained_models.html\n', encoding='utf-8')
            # Validate imports and model construction in the isolated runtime before publishing it.
            proc = None
            async def spawn_check():
                nonlocal proc
                proc = await asyncio.create_subprocess_exec(*self.worker_command(stage), '--check',
                    stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
            try:
                await finish_cleanup(spawn_check())
                if await asyncio.wait_for(proc.wait(), 120) != 0:
                    raise ValueError('Voice runtime or model loading failed')
            finally:
                if proc is not None and proc.returncode is None:
                    await finish_cleanup(terminate_owned_process(proc))
            def publish():
                (stage / 'installed.json').write_text(json.dumps({
                    'version': RESOURCE_VERSION, 'python': f'{sys.version_info.major}.{sys.version_info.minor}',
                }))
                if self.bundle.exists():
                    shutil.rmtree(self.bundle)
                stage.rename(self.bundle)
            async def complete():
                await asyncio.to_thread(publish)
                self.install_state['stage'] = 'installed'
                await asyncio.to_thread(shutil.rmtree, self.model_download.folder, True)
            await finish_cleanup(complete())
        except asyncio.CancelledError:
            if self.install_state['stage'] != 'installed':
                self.install_state['stage'] = 'cancelled'
            raise
        except Exception:
            # Do not include signed download URLs, credentials, or audio in errors/logs.
            self.install_state.update(stage='error', error='Could not install speech resources. Check the network, free space, and platform compatibility.')
        finally:
            await finish_cleanup(asyncio.to_thread(shutil.rmtree, stage, True))

    async def _install(self, stage: Path):
        # Existing ASR remains usable on failure; upgrade only the missing model.
        if not self.segment_model and await asyncio.to_thread(self.installed):
            def copy_verified():
                for name, _, digest in self.files:
                    with (self.bundle / name).open('rb') as source:
                        if hashlib.file_digest(source, 'sha256').hexdigest() != digest:
                            raise ValueError('Voice model validation failed. Please delete and re-download.')
                shutil.copytree(self.bundle, stage, dirs_exist_ok=True)
            await finish_cleanup(asyncio.to_thread(copy_verified))
            self.install_state.update(stage='downloading', total_bytes=PUNCTUATION_FILE[1])
            async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
                await self._fetch(client, self.download_origin + PUNCTUATION_URL.removeprefix(HUGGING_FACE), stage / PUNCTUATION_FILE[0], *PUNCTUATION_FILE[1:])
            self.install_state['stage'] = 'installing'
            return
        tags = list(sys_tags())
        ranks = {tag: i for i, tag in enumerate(tags)}
        wheels = []
        async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
            for name, version in PACKAGES:
                response = await client.get(f'https://pypi.org/pypi/{name}/{version}/json')
                response.raise_for_status()
                choices = []
                for entry in response.json()['urls']:
                    if not entry['filename'].endswith('.whl') or entry.get('yanked'):
                        continue
                    wheel_tags = parse_wheel_filename(entry['filename'])[3]
                    score = min((ranks[t] for t in wheel_tags if t in ranks), default=None)
                    if score is not None:
                        choices.append((score, entry))
                if not choices:
                    raise ValueError('No compatible speech runtime found for the current Python or system')
                wheels.append(min(choices, key=lambda item: item[0])[1])
            base = self.download_origin + self.model['base'].removeprefix(HUGGING_FACE)
            entries = [(f"{base}/{name}", name, size, digest) for name, size, digest in self.files]
            if not self.segment_model:
                entries.append((self.download_origin + PUNCTUATION_URL.removeprefix(HUGGING_FACE), *PUNCTUATION_FILE))
            entries += [(w['url'], w['filename'], w['size'], w['digests']['sha256']) for w in wheels]
            self.install_state['total_bytes'] = sum(e[2] for e in entries)
            free = await asyncio.to_thread(lambda: shutil.disk_usage(stage).free + self.model_download.cached_bytes())
            if free < self.install_state['total_bytes'] * 3:
                raise ValueError('Disk space is insufficient')
            self.install_state['stage'] = 'downloading'
            for url, name, size, digest in entries:
                await self._fetch(client, url, stage / name, size, digest)
            self.install_state['stage'] = 'installing'
            for wheel in wheels:
                path = stage / wheel['filename']
                await finish_cleanup(asyncio.to_thread(unpack_wheel, path, stage / 'runtime'))
                await finish_cleanup(asyncio.to_thread(path.unlink))

    async def _fetch(self, client, url, path, size, expected):
        await self.model_download.fetch(client, url, path, size, expected, self.install_state)

    async def cancel_download(self):
        task = self.download_task
        if task and not task.done():
            task.cancel()
            await finish_cleanup(asyncio.gather(task, return_exceptions=True))
            if self.download_task is task and self.install_state['stage'] == 'resolving':
                self.install_state['stage'] = 'cancelled'

    async def delete(self, model_id: str | None = None, partial_only=False):
        async with self.session_lock:
            target = model_id or self.model_id
            model_spec(target)
            await finish_cleanup(self._delete(target, partial_only))

    async def _delete(self, target, partial_only):
        if self.sessions and not partial_only:
            raise ValueError('Cannot delete model during recording')
        if target == self.install_target:
            await self.cancel_download()
        await asyncio.to_thread(ResourceDownload(self.root, target).discard)
        if not partial_only:
            if target == self.model_id:
                await self.stop_worker()
            await asyncio.to_thread(shutil.rmtree, self.root / target, True)
        self.install_states.pop(target, None)

    def worker_command(self, bundle=None):
        return [sys.executable, '-I', str(Path(__file__).with_name('speech_worker.py')), str(bundle or self.bundle), '--model-type', self.model['kind']]

    async def infer(self, pcm: bytes, session_id: str, final: bool, preview=True):
        session = self.sessions.get(session_id)
        if session is None:
            raise LookupError('Recording has ended')
        if getattr(session['worker'], 'remote', False):
            return await session['worker'].infer(pcm, final)
        return await session['worker'].infer(self.worker_command(), pcm, session_id, final, preview)

    async def _release(self, session, terminate=False):
        sid = session['id']
        if self.sessions.get(sid) is not session:
            return
        self.sessions.pop(sid)
        session['advanced'].set()
        session['speaker_pcm'].clear()
        worker = session['worker']
        if getattr(worker, 'remote', False):
            if worker in self.workers:
                self.workers.remove(worker)
            await finish_cleanup(worker.close())
        elif terminate:
            await worker.close()
        worker.session_id = None
        self.last_used = worker.last_used = time.monotonic()

    def _maintain(self):
        if self.reaper is None or self.reaper.done():
            self.reaper = asyncio.create_task(self._reap())

    async def _reap(self):
        while True:
            await asyncio.sleep(10)
            now = time.monotonic()
            for session in list(self.sessions.values()):
                if not session['lock'].locked() and now - session['touched'] > 20:
                    await self._release(session, terminate=True)
            for worker in list(self.workers):
                if worker.session_id is None and now - worker.last_used > 300:
                    if (self.segment_model and worker.process and worker.process.returncode is None
                            and worker is next((w for w in self.workers if w.process and w.process.returncode is None), None)):
                        continue  # Retain one loaded SenseVoice model between conversations.
                    # Reserve it while closing so a new recording cannot reuse it.
                    self.workers.remove(worker)
                    await worker.close()
            if not self.sessions and not self.workers:
                return

    async def start(self, project_id: str, owner: str, phone_call=False):
        async with self.session_lock:
            if self.download_task and not self.download_task.done():
                raise ValueError('Installing voice resources, please retry later')
            settings = await self.get_settings()
            local = settings['connection']['mode'] == 'local'
            if not settings['enabled'] or local and not await asyncio.to_thread(self.installed):
                raise ValueError('Please download the model and enable voice input in Settings first')
            if not local:
                speech_connection.validate(settings['connection'])
            profile = await self.voiceprint.profile()
            use_voiceprint = profile.get('enabled') and (phone_call or profile.get('scope') == 'all')
            if use_voiceprint and (not local or not await asyncio.to_thread(self.voiceprint.available)):
                raise ValueError('voiceprint.downloadFirst')
            worker = next((w for w in self.workers if w.session_id is None), None)
            if worker is None:
                if len(self.workers) >= MAX_SESSIONS:
                    raise ValueError(f'Voice concurrency limit reached ({MAX_SESSIONS} channels). Please try again later.')
                worker = SpeechRuntime() if local else RemoteSpeechRuntime(settings['connection'])
                self.workers.append(worker)
            sid = uuid.uuid4().hex
            worker.session_id = sid
            if local and self.segment_model:
                try:
                    await worker.warm(self.worker_command())
                except BaseException:
                    self.workers.remove(worker)
                    await worker.close()
                    raise
            self.sessions[sid] = {'id': sid, 'project_id': project_id, 'owner': owner,
                                 'sequence': 0, 'bytes': 0, 'worker': worker,
                                 'voiceprint': profile if use_voiceprint else None, 'speaker_pcm': bytearray(),
                                 'touched': time.monotonic(), 'started': time.monotonic(),
                                 'lock': asyncio.Lock(), 'advanced': asyncio.Event()}
            self._maintain()
            return {'id': sid, 'sample_rate': SAMPLE_RATE, 'max_seconds': 120, 'max_frame_samples': MAX_FRAME // 2,
                    'streaming': self.streaming(settings['connection'])}

    def _session(self, sid, project, owner):
        s = self.sessions.get(sid)
        if not s or s['id'] != sid or s['project_id'] != project or s['owner'] != owner:
            raise LookupError('Recording has ended or access is not permitted')
        return s

    async def audio(self, sid, project, owner, sequence, pcm, final, preview=True):
        s = self._session(sid, project, owner)
        if not final:
            return await self._audio(sid, project, owner, sequence, pcm, False, preview)
        if s.get('final_pending'):
            raise ValueError('Recording is completing, please do not resubmit')
        if sequence not in (s['sequence'], s['sequence'] + 1):
            raise ValueError('Audio order error')
        if len(pcm) % 2 or len(pcm) > MAX_FRAME:
            raise ValueError('Audio format or size error')
        s['final_pending'] = True
        try:
            # Final and preview may travel on different HTTP connections. Wait
            # for exactly one preceding request if the final arrives first.
            if sequence > s['sequence']:
                try:
                    await asyncio.wait_for(s['advanced'].wait(), 15)
                except TimeoutError as error:
                    raise ValueError('Waiting for the previous audio segment timed out, please retry') from error
            return await self._audio(sid, project, owner, sequence, pcm, True)
        finally:
            s.pop('final_pending', None)

    async def _audio(self, sid, project, owner, sequence, pcm, final, preview=True):
        s = self._session(sid, project, owner)
        if s['lock'].locked() and not final:
            raise ValueError('Do not submit overlapping audio processing tasks')
        async with s['lock']:
            self._session(sid, project, owner)
            if sequence != s['sequence']:
                raise ValueError('Audio order error')
            if len(pcm) % 2 or len(pcm) > MAX_FRAME:
                raise ValueError('Audio format or size error')
            if s['bytes'] + len(pcm) > MAX_BYTES or time.monotonic() - s['started'] > 150:
                await self._release(s, terminate=True)
                raise ValueError('Recording exceeds the two-minute limit')
            s['sequence'] += 1
            advanced, s['advanced'] = s['advanced'], asyncio.Event()
            advanced.set()
            s['bytes'] += len(pcm)
            s['touched'] = time.monotonic()
            try:
                # Only new samples enter the persistent decoder. The worker owns
                # encoder/decoder caches and returns the complete hypothesis.
                inference_started = time.monotonic()
                speaker_status = None
                if s['voiceprint']:
                    s['speaker_pcm'].extend(pcm)
                    del s['speaker_pcm'][:-MAX_VOICEPRINT_AUDIO]
                    speaker_status = 'insufficient'
                    if (final or preview) and len(s['speaker_pcm']) >= MIN_VERIFY_SAMPLES * 2:
                        speaker_status = await self.voiceprint.verify(bytes(s['speaker_pcm']), s['voiceprint'])
                    self._session(sid, project, owner)
                allowed = speaker_status is None or speaker_status == 'matched'
                decode_preview = preview and allowed
                result = await self.infer(pcm, sid, final) if decode_preview else await self.infer(pcm, sid, final, False)
                text = result.strip() if allowed else ''
                processing_ms = round((time.monotonic() - inference_started) * 1000, 1)
                self._session(sid, project, owner)
            except BaseException:
                await self._release(s, terminate=True)
                raise
            self.last_used = s['touched'] = time.monotonic()
            if final:
                await self._release(s)
            return {'id': sid, 'sequence': sequence, 'text': text, 'final': final, 'processing_ms': processing_ms,
                    **({'speaker_status': speaker_status} if speaker_status else {})}

    async def cancel(self, sid, project, owner):
        session = self._session(sid, project, owner)
        await self._release(session, terminate=True)

    async def stop_worker(self):
        workers, self.workers = self.workers, []
        await asyncio.gather(*(worker.close() for worker in workers))

    async def close(self):
        await finish_cleanup(self._close())

    async def _close(self):
        self.sessions.clear()
        try:
            if self.reaper:
                self.reaper.cancel()
                await asyncio.gather(self.reaper, return_exceptions=True)
                self.reaper = None
            await self.cancel_download()
        finally:
            await self.stop_worker()
            await self.voiceprint.close()


service = SpeechService()
