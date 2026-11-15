"""Verified on-demand model and binary-wheel installation, outside the application."""
import asyncio
import hashlib
import json
import shutil
import sys
import uuid
from pathlib import Path

import httpx
from packaging.tags import sys_tags
from packaging.utils import parse_wheel_filename

from services.speech import PACKAGES, unpack_wheel
from services.tts_catalog import MODELS
from services import tts_qwen_resources


class TtsResources:
    def __init__(self, root):
        self.root = Path(root)
        self.states = {}
        self.task = None
        self.target = None

    def path(self, model_id):
        if model_id not in MODELS:
            raise ValueError('不支持的语音输出模型')
        return self.root / model_id

    def installed(self, model_id):
        path = self.path(model_id)
        try:
            marker = json.loads((path / 'installed.json').read_text())
            return (marker['revision'] == MODELS[model_id]['revision']
                    and ((tts_qwen_resources.installed(self.root.parent)) if MODELS[model_id]['runtime'] == 'qwen' else (
                        marker['python'] == f'{sys.version_info.major}.{sys.version_info.minor}'
                        and (path / 'runtime/sherpa_onnx').is_dir()))
                    and all((path / name).stat().st_size == size for name, size in marker['files']))
        except (OSError, ValueError, KeyError, TypeError):
            return False

    async def download(self, model_id):
        self.path(model_id)
        if self.task and not self.task.done():
            if self.target != model_id:
                raise ValueError('请等待当前模型下载完成或取消下载')
            return
        if await asyncio.to_thread(self.installed, model_id):
            return
        self.target = model_id
        self.states[model_id] = dict(stage='resolving', downloaded_bytes=0, total_bytes=None, error='')
        self.task = asyncio.create_task(self._download(model_id))

    async def cancel(self):
        if self.task and not self.task.done():
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)

    async def _download(self, model_id):
        spec = MODELS[model_id]
        state = self.states[model_id]
        stage = self.root / ('.install-' + uuid.uuid4().hex)
        try:
            await asyncio.to_thread(stage.mkdir, parents=True, exist_ok=True)
            async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
                # Resolve only an immutable upstream tree. Both ordinary Git
                # blobs and large-file objects are hash checked before publish.
                tree = await client.get(f"https://huggingface.co/api/models/{spec['repo']}/tree/{spec['revision']}",
                                        params={'recursive': 'true', 'limit': 1000})
                tree.raise_for_status()
                if tree.links.get('next'):
                    raise ValueError('模型资源清单不完整')
                entries = []
                for entry in tree.json():
                    if entry['type'] != 'file':
                        continue
                    name = entry['path']
                    parts = Path(name).parts
                    if (Path(name).is_absolute() or '..' in parts or '\\' in name
                            or name == 'installed.json' or name.startswith('runtime/')):
                        raise ValueError('模型资源路径无效')
                    if name.startswith('.') or name.endswith('.py'):
                        continue
                    lfs = entry.get('lfs')
                    entries.append(dict(name=name, size=entry['size'],
                        digest=lfs['oid'] if lfs else entry['oid'], kind='sha256' if lfs else 'git'))
                required = ({'model.safetensors', 'config.json', 'speech_tokenizer/model.safetensors'}
                            if spec['runtime'] == 'qwen' else {'model.onnx', 'voices.bin', 'tokens.txt'})
                if not required.issubset({e['name'] for e in entries}):
                    raise ValueError('模型资源不完整')
                ranks = {tag: i for i, tag in enumerate(sys_tags())}
                wheels = []
                for package, version in (PACKAGES if spec['runtime'] == 'sherpa' else []):
                    response = await client.get(f'https://pypi.org/pypi/{package}/{version}/json')
                    response.raise_for_status()
                    candidates = []
                    for entry in response.json()['urls']:
                        if not entry['filename'].endswith('.whl') or entry.get('yanked'):
                            continue
                        tags = parse_wheel_filename(entry['filename'])[3]
                        rank = min((ranks[t] for t in tags if t in ranks), default=None)
                        if rank is not None:
                            candidates.append((rank, entry))
                    if not candidates:
                        raise ValueError('当前平台没有兼容的语音运行库')
                    wheels.append(min(candidates, key=lambda item: item[0])[1])
                state['total_bytes'] = sum(e['size'] for e in entries) + sum(w['size'] for w in wheels)
                free = await asyncio.to_thread(lambda: shutil.disk_usage(stage).free)
                if free < state['total_bytes'] * 3 + (6 * 1024**3 if spec['runtime'] == 'qwen' else 0):
                    raise ValueError('磁盘空间不足')
                state['stage'] = 'downloading'
                gate = asyncio.Semaphore(6)

                async def fetch(url, name, size, digest, kind='sha256'):
                    async with gate:
                        target = stage / name
                        await asyncio.to_thread(target.parent.mkdir, parents=True, exist_ok=True)
                        hasher = hashlib.sha256() if kind == 'sha256' else hashlib.sha1()
                        if kind == 'git':
                            hasher.update(f'blob {size}\0'.encode())
                        count = 0
                        out = await asyncio.to_thread(target.open, 'wb')
                        try:
                            async with client.stream('GET', url, headers={'Accept-Encoding': 'identity'}) as response:
                                response.raise_for_status()
                                async for chunk in response.aiter_bytes(256 * 1024):
                                    count += len(chunk)
                                    if count > size:
                                        raise ValueError('资源大小不符')
                                    hasher.update(chunk)
                                    # Shield writes so cancellation cannot race staging cleanup.
                                    writing = asyncio.create_task(asyncio.to_thread(out.write, chunk))
                                    try:
                                        await asyncio.shield(writing)
                                    except asyncio.CancelledError:
                                        await writing
                                        raise
                                    state['downloaded_bytes'] += len(chunk)
                        finally:
                            await asyncio.to_thread(out.close)
                        if count != size or hasher.hexdigest() != digest:
                            raise ValueError('资源校验失败')

                async with asyncio.TaskGroup() as group:
                    for entry in entries:
                        url = f"https://huggingface.co/{spec['repo']}/resolve/{spec['revision']}/{entry['name']}"
                        group.create_task(fetch(url, **entry))
                    for wheel in wheels:
                        group.create_task(fetch(wheel['url'], wheel['filename'], wheel['size'], wheel['digests']['sha256']))
                state['stage'] = 'installing'
                for wheel in wheels:
                    operation = asyncio.create_task(asyncio.to_thread(unpack_wheel, stage / wheel['filename'], stage / 'runtime'))
                    try:
                        await asyncio.shield(operation)
                    except asyncio.CancelledError:
                        await operation
                        raise
                    await asyncio.to_thread((stage / wheel['filename']).unlink)
            if spec['runtime'] == 'qwen':
                await tts_qwen_resources.ensure(self.root.parent, state)
                command = await asyncio.to_thread(tts_qwen_resources.worker_command, stage, True)
            else:
                command = [sys.executable, '-I', str(Path(__file__).with_name('tts_worker.py')), str(stage), '--check']
            await tts_qwen_resources.run(command, timeout=360)
            def publish():
                (stage / 'installed.json').write_text(json.dumps(dict(revision=spec['revision'],
                    python=f'{sys.version_info.major}.{sys.version_info.minor}',
                    files=[(e['name'], e['size']) for e in entries])))
                target = self.path(model_id)
                if target.exists():
                    shutil.rmtree(target)
                stage.rename(target)
            publishing = asyncio.create_task(asyncio.to_thread(publish))
            try:
                await asyncio.shield(publishing)
            except asyncio.CancelledError:
                await publishing
                raise
            state['stage'] = 'installed'
        except asyncio.CancelledError:
            state['stage'] = 'cancelled'
            raise
        except Exception:
            state.update(stage='error', error='语音模型安装失败，请检查网络、磁盘空间和平台兼容性后重试')
        finally:
            await asyncio.to_thread(shutil.rmtree, stage, True)

    async def delete(self, model_id):
        path = self.path(model_id)
        if self.target == model_id:
            await self.cancel()
        await asyncio.to_thread(shutil.rmtree, path, True)
        self.states.pop(model_id, None)
