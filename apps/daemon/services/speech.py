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


ZIPFORMER_ID = 'streaming-zipformer-zh-en-int8'
MODELS = {
    MODEL_ID: dict(name='Streaming Paraformer 三语版 INT8', kind='paraformer', base=MODEL_BASE,
                   languages=['zh', 'yue', 'en'],
                   license_url='https://modelscope.cn/models/dengcunqin/speech_paraformer-large_asr_nat-zh-cantonese-en-16k-vocab8501-online/summary'),
    ZIPFORMER_ID: dict(name='Streaming Zipformer 中英版 INT8', kind='zipformer',
        base='https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20/resolve/98590b7ed6443e77b714204da2757d75e1a642f4',
        languages=['zh', 'en'], license_url='https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20',
        files=[
            ('encoder-epoch-99-avg-1.int8.onnx', 181895032, '8fa764187a261844f859d7143ebaa563af5d10adfece4c18a8f414c88cba2a9b'),
            ('decoder-epoch-99-avg-1.int8.onnx', 13091040, '1a70c593d71e53f023f5f55b0b4cfff5055abb786ee3992e5f63dc2e273cc4fa'),
            ('joiner-epoch-99-avg-1.int8.onnx', 3228404, '1ed689c5ed19dbaa725d9d191bb4822b5f4855a39e1ffd28cbc1f340d25b2ee0'),
            ('tokens.txt', 56317, 'a8e0e4ec53810e433789b54a5c0134a7eaa2ffca595a6334d54c00da858841d3'),
            ('README.md', 296, 'b6f9458f4208ae821beaaf11dc983486916a4089a2f3677b40f9ff06ec4e6440'),
        ]),
}

def model_spec(model_id):
    if model_id not in MODELS:
        raise ValueError('不支持的语音模型')
    return MODELS[model_id]


def unpack_wheel(path: Path, target: Path):
    """Only unpack verified binary wheels; no setup scripts or executable .pth."""
    with zipfile.ZipFile(path) as archive:
        for item in archive.infolist():
            parts = Path(item.filename).parts
            if (not parts or Path(item.filename).is_absolute() or '..' in parts
                    or (item.external_attr >> 16) & 0o170000 == 0o120000):
                raise ValueError('运行库包含非法路径')
            if item.filename.endswith('.pth'):
                raise ValueError('运行库包含不支持的启动文件')
        archive.extractall(target)


class SpeechService:
    def __init__(self, root: Path | None = None, model_id: str = MODEL_ID):
        self.root = root or CONFIG_DIR / 'speech'
        self._use_model(model_id)
        self.settings: dict | None = None
        self.install_state: dict = {'stage': 'idle', 'downloaded_bytes': 0, 'total_bytes': None, 'error': ''}
        self.install_states = {model_id: self.install_state}
        self.install_target = model_id
        self.download_task: asyncio.Task | None = None
        self.sessions: dict[str, dict] = {}
        self.workers: list[SpeechRuntime] = []
        self.session_lock = asyncio.Lock()
        self.last_used = time.monotonic()
        self.reaper: asyncio.Task | None = None

    def _use_model(self, model_id):
        self.model = model_spec(model_id)
        self.model_id = model_id
        self.bundle = self.root / model_id

    @property
    def files(self):
        return MODEL_FILES if self.model_id == MODEL_ID else self.model['files']

    def model_installed(self, model_id):
        model_spec(model_id)
        return self.installed() if model_id == self.model_id else SpeechService(self.root, model_id).installed()

    async def get_settings(self):
        if self.settings is None:
            def load():
                try:
                    return json.loads((self.root / 'settings.json').read_text())
                except (OSError, ValueError):
                    return {}
            saved = await asyncio.to_thread(load)
            self._use_model(saved.get('model_id') if saved.get('model_id') in MODELS else MODEL_ID)
            self.settings = {'enabled': bool(saved.get('enabled', False)),
                             'model_id': self.model_id,
                             'language': saved.get('language', 'auto') if saved.get('language', 'auto') in LANGUAGES else 'auto'}
        return dict(self.settings)

    async def configure(self, enabled: bool, language: str, model_id: str | None = None):
        async with self.session_lock:
            return await self._configure(enabled, language, model_id)

    async def _configure(self, enabled: bool, language: str, model_id: str | None = None):
        if self.sessions:
            raise ValueError('录音期间不能修改语音设置')
        if language not in LANGUAGES:
            raise ValueError('不支持的识别语言')
        await self.get_settings()
        target = model_id or self.model_id
        model_spec(target)
        if self.download_task and not self.download_task.done():
            raise ValueError('安装期间不能切换语音设置')
        if target != self.model_id and not await asyncio.to_thread(self.model_installed, target):
            raise ValueError('请先下载所选语音模型')
        value = {'enabled': enabled, 'language': language, 'model_id': target}
        def save():
            self.root.mkdir(parents=True, exist_ok=True)
            stage = self.root / 'settings.tmp'
            stage.write_text(json.dumps(value), encoding='utf-8')
            stage.replace(self.root / 'settings.json')
        await asyncio.to_thread(save)
        self.settings = value
        if target != self.model_id:
            await self.stop_worker()
            self._use_model(target)
        if not enabled:
            await self.stop_worker()
        return value

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
                rows.append(dict(id=mid, name=spec['name'], license='模型来源与使用说明',
                    license_url=spec['license_url'], languages=spec['languages'],
                    model_bytes=sum(f[1] for f in resource.files) + PUNCTUATION_FILE[1],
                    installed=resource.installed(), punctuation=resource.punctuation_installed(),
                    streaming='native', install=dict(self.install_states.get(mid, {'stage': 'idle', 'downloaded_bytes': 0, 'total_bytes': None, 'error': ''}))))
            return rows
        return {**settings, 'model_id': self.model_id, 'languages': list(LANGUAGES),
                'service': 'busy' if self.sessions else 'ready' if any(w.process and w.process.returncode is None for w in self.workers) else 'stopped',
                'active_sessions': len(self.sessions), 'max_sessions': MAX_SESSIONS,
                'models': await asyncio.to_thread(models)}

    async def download(self, model_id: str | None = None):
        async with self.session_lock:
            await self._begin_download(model_id)

    async def _begin_download(self, model_id: str | None = None):
        await self.get_settings()
        target = model_id or self.model_id
        model_spec(target)
        if self.sessions:
            raise ValueError('录音期间不能安装模型')
        if self.download_task and not self.download_task.done():
            if target != self.install_target:
                raise ValueError('请等待当前模型下载完成或取消下载')
            return
        resource = self if target == self.model_id else SpeechService(self.root, target)
        if await asyncio.to_thread(resource.installed) and await asyncio.to_thread(resource.punctuation_installed):
            return
        await self.stop_worker()
        self.install_state = {'stage': 'resolving', 'downloaded_bytes': 0, 'total_bytes': None, 'error': ''}
        self.install_target = target
        self.install_states[target] = self.install_state
        resource.install_state = self.install_state
        self.download_task = asyncio.create_task(resource._download())

    async def _download(self):
        stage = self.root / ('.install-' + uuid.uuid4().hex)
        try:
            await asyncio.to_thread(stage.mkdir, parents=True)
            await self._install(stage)
            await asyncio.to_thread((stage / 'punctuation-source.txt').write_text,
                'CT-Transformer Chinese/English INT8 punctuation model.\n'
                'Upstream model and usage terms: https://modelscope.cn/models/iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch/summary\n'
                'Conversion: https://k2-fsa.github.io/sherpa/onnx/punctuation/pretrained_models.html\n', encoding='utf-8')
            # Validate imports and model construction in the isolated runtime before publishing it.
            proc = await asyncio.create_subprocess_exec(*self.worker_command(stage), '--check',
                                                       stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
            try:
                if await asyncio.wait_for(proc.wait(), 120) != 0:
                    raise ValueError('语音运行库或模型加载失败')
            finally:
                if proc.returncode is None:
                    proc.kill()
                    await proc.wait()
            def publish():
                (stage / 'installed.json').write_text(json.dumps({
                    'version': RESOURCE_VERSION, 'python': f'{sys.version_info.major}.{sys.version_info.minor}',
                }))
                if self.bundle.exists():
                    shutil.rmtree(self.bundle)
                stage.rename(self.bundle)
            await asyncio.to_thread(publish)
            self.install_state['stage'] = 'installed'
        except asyncio.CancelledError:
            self.install_state['stage'] = 'cancelled'
            raise
        except Exception:
            # Do not include signed download URLs, credentials, or audio in errors/logs.
            self.install_state.update(stage='error', error='语音资源安装失败，请检查网络、磁盘空间与平台兼容性后重试')
        finally:
            await asyncio.to_thread(shutil.rmtree, stage, True)

    async def _install(self, stage: Path):
        # Existing ASR remains usable on failure; upgrade only the missing model.
        if await asyncio.to_thread(self.installed):
            def copy_verified():
                for name, _, digest in self.files:
                    with (self.bundle / name).open('rb') as source:
                        if hashlib.file_digest(source, 'sha256').hexdigest() != digest:
                            raise ValueError('已有语音模型校验失败，请删除后重新下载')
                shutil.copytree(self.bundle, stage, dirs_exist_ok=True)
            copying = asyncio.create_task(asyncio.to_thread(copy_verified))
            try:
                await asyncio.shield(copying)
            except asyncio.CancelledError:
                await asyncio.gather(copying, return_exceptions=True)
                raise
            self.install_state.update(stage='downloading', total_bytes=PUNCTUATION_FILE[1])
            async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
                await self._fetch(client, PUNCTUATION_URL, stage / PUNCTUATION_FILE[0], *PUNCTUATION_FILE[1:])
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
                    raise ValueError('当前 Python 或系统没有兼容语音运行库')
                wheels.append(min(choices, key=lambda item: item[0])[1])
            entries = [(f"{self.model['base']}/{name}", name, size, digest) for name, size, digest in self.files]
            entries.append((PUNCTUATION_URL, *PUNCTUATION_FILE))
            entries += [(w['url'], w['filename'], w['size'], w['digests']['sha256']) for w in wheels]
            self.install_state['total_bytes'] = sum(e[2] for e in entries)
            free = await asyncio.to_thread(lambda: shutil.disk_usage(stage).free)
            if free < self.install_state['total_bytes'] * 3:
                raise ValueError('磁盘空间不足')
            self.install_state['stage'] = 'downloading'
            for url, name, size, digest in entries:
                await self._fetch(client, url, stage / name, size, digest)
            self.install_state['stage'] = 'installing'
            for wheel in wheels:
                path = stage / wheel['filename']
                extraction = asyncio.create_task(asyncio.to_thread(unpack_wheel, path, stage / 'runtime'))
                try:
                    await asyncio.shield(extraction)
                except asyncio.CancelledError:
                    # Cleanup must wait until the filesystem worker has stopped
                    # writing, otherwise cancellation can leave orphan files.
                    await asyncio.gather(extraction, return_exceptions=True)
                    raise
                await asyncio.to_thread(path.unlink)

    async def _fetch(self, client, url, path, size, expected):
        digest = hashlib.sha256()
        count = 0
        file = await asyncio.to_thread(path.open, 'wb')
        try:
            async with client.stream('GET', url, headers={'Accept-Encoding': 'identity'}) as response:
                response.raise_for_status()
                async for chunk in response.aiter_bytes(256 * 1024):
                    count += len(chunk)
                    if count > size:
                        raise ValueError('资源大小不符')
                    digest.update(chunk)
                    await asyncio.to_thread(file.write, chunk)
                    self.install_state['downloaded_bytes'] += len(chunk)
        finally:
            await asyncio.to_thread(file.close)
        if count != size or digest.hexdigest() != expected:
            raise ValueError('资源校验失败')

    async def cancel_download(self):
        if self.download_task and not self.download_task.done():
            self.download_task.cancel()
            await asyncio.gather(self.download_task, return_exceptions=True)

    async def delete(self, model_id: str | None = None):
        async with self.session_lock:
            target = model_id or self.model_id
            model_spec(target)
            if target == self.model_id:
                await self._delete()
            else:
                if self.sessions:
                    raise ValueError('录音期间不能删除模型')
                if target == self.install_target:
                    await self.cancel_download()
                await asyncio.to_thread(shutil.rmtree, self.root / target, True)
            self.install_states.setdefault(target, {})['stage'] = 'idle'

    async def _delete(self):
        if self.sessions:
            raise ValueError('录音期间不能删除模型')
        await self.cancel_download()
        await self.stop_worker()
        await asyncio.to_thread(shutil.rmtree, self.bundle, True)
        self.install_states.setdefault(self.model_id, {})['stage'] = 'idle'

    def worker_command(self, bundle=None):
        return [sys.executable, '-I', str(Path(__file__).with_name('speech_worker.py')), str(bundle or self.bundle), '--model-type', self.model['kind']]

    async def infer(self, pcm: bytes, session_id: str, final: bool):
        session = self.sessions.get(session_id)
        if session is None:
            raise LookupError('录音已结束')
        return await session['worker'].infer(self.worker_command(), pcm, session_id, final)

    async def _release(self, session, terminate=False):
        sid = session['id']
        if self.sessions.get(sid) is not session:
            return
        self.sessions.pop(sid)
        session['advanced'].set()
        worker = session['worker']
        if terminate:
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
                    # Reserve it while closing so a new recording cannot reuse it.
                    self.workers.remove(worker)
                    await worker.close()
            if not self.sessions and not self.workers:
                return

    async def start(self, project_id: str, owner: str):
        async with self.session_lock:
            if self.download_task and not self.download_task.done():
                raise ValueError('正在安装语音资源，请稍后重试')
            settings = await self.get_settings()
            if not settings['enabled'] or not await asyncio.to_thread(self.installed):
                raise ValueError('请先在设置中下载模型并启用语音输入')
            worker = next((w for w in self.workers if w.session_id is None), None)
            if worker is None:
                if len(self.workers) >= MAX_SESSIONS:
                    raise ValueError(f'语音并发已达上限（{MAX_SESSIONS} 路），请稍后重试')
                worker = SpeechRuntime()
                self.workers.append(worker)
            sid = uuid.uuid4().hex
            worker.session_id = sid
            self.sessions[sid] = {'id': sid, 'project_id': project_id, 'owner': owner,
                                 'sequence': 0, 'bytes': 0, 'worker': worker,
                                 'touched': time.monotonic(), 'started': time.monotonic(),
                                 'lock': asyncio.Lock(), 'advanced': asyncio.Event()}
            self._maintain()
            return {'id': sid, 'sample_rate': SAMPLE_RATE, 'max_seconds': 120, 'max_frame_samples': MAX_FRAME // 2}

    def _session(self, sid, project, owner):
        s = self.sessions.get(sid)
        if not s or s['id'] != sid or s['project_id'] != project or s['owner'] != owner:
            raise LookupError('录音已结束或无权访问')
        return s

    async def audio(self, sid, project, owner, sequence, pcm, final):
        s = self._session(sid, project, owner)
        if not final:
            return await self._audio(sid, project, owner, sequence, pcm, False)
        if s.get('final_pending'):
            raise ValueError('录音正在完成，请勿重复提交')
        if sequence not in (s['sequence'], s['sequence'] + 1):
            raise ValueError('音频顺序错误')
        if len(pcm) % 2 or len(pcm) > MAX_FRAME:
            raise ValueError('音频格式或大小错误')
        s['final_pending'] = True
        try:
            # Final and preview may travel on different HTTP connections. Wait
            # for exactly one preceding request if the final arrives first.
            if sequence > s['sequence']:
                try:
                    await asyncio.wait_for(s['advanced'].wait(), 15)
                except TimeoutError as error:
                    raise ValueError('等待上一段音频超时，请重试') from error
            return await self._audio(sid, project, owner, sequence, pcm, True)
        finally:
            s.pop('final_pending', None)

    async def _audio(self, sid, project, owner, sequence, pcm, final):
        s = self._session(sid, project, owner)
        if s['lock'].locked() and not final:
            raise ValueError('音频处理中，请勿重叠提交')
        async with s['lock']:
            self._session(sid, project, owner)
            if sequence != s['sequence']:
                raise ValueError('音频顺序错误')
            if len(pcm) % 2 or len(pcm) > MAX_FRAME:
                raise ValueError('音频格式或大小错误')
            if s['bytes'] + len(pcm) > MAX_BYTES or time.monotonic() - s['started'] > 150:
                await self._release(s, terminate=True)
                raise ValueError('录音超过两分钟限制')
            s['sequence'] += 1
            advanced, s['advanced'] = s['advanced'], asyncio.Event()
            advanced.set()
            s['bytes'] += len(pcm)
            s['touched'] = time.monotonic()
            try:
                # Only new samples enter the persistent decoder. The worker owns
                # encoder/decoder caches and returns the complete hypothesis.
                inference_started = time.monotonic()
                text = (await self.infer(pcm, sid, final)).strip()
                processing_ms = round((time.monotonic() - inference_started) * 1000, 1)
                self._session(sid, project, owner)
            except BaseException:
                await self._release(s, terminate=True)
                raise
            self.last_used = s['touched'] = time.monotonic()
            if final:
                await self._release(s)
            return {'id': sid, 'sequence': sequence, 'text': text, 'final': final, 'processing_ms': processing_ms}

    async def cancel(self, sid, project, owner):
        session = self._session(sid, project, owner)
        await self._release(session, terminate=True)

    async def stop_worker(self):
        workers, self.workers = self.workers, []
        await asyncio.gather(*(worker.close() for worker in workers))

    async def close(self):
        self.sessions.clear()
        if self.reaper:
            self.reaper.cancel()
            await asyncio.gather(self.reaper, return_exceptions=True)
            self.reaper = None
        await self.cancel_download()
        await self.stop_worker()


service = SpeechService()
