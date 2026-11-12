"""User-triggered staged resources; inference dependencies stay outside the daemon."""
import asyncio
import hashlib
import json
import os
import platform
import shutil
import sys
import uuid
from pathlib import Path

import httpx

from engines.core.base import _has_pip

from services.decision_catalog import REVISION, MODELS, resource_entry
from services import decision_native

RUNTIMES = ('runtime', 'runtime-gguf')

MODEL_BASE = resource_entry('model')['base_url']
MODEL_FILES = resource_entry('model')['files']
PACKAGES = ['laya==0.4.17', 'torch==2.15.0', 'transformers==5.21.0']


async def resource_io(operation, *args, **kwargs):
    """Do not clean staging files while a cancelled filesystem worker still writes."""
    task = asyncio.create_task(asyncio.to_thread(operation, *args, **kwargs))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        await asyncio.gather(task, return_exceptions=True)
        raise


class DecisionResources:
    def __init__(self, root):
        self.root = Path(root)
        self.states = {k: self.empty() for k in (*RUNTIMES, *(m['resource_kind'] for m in MODELS))}
        self.task = None
        self.target = None
        self.lock = asyncio.Lock()

    @staticmethod
    def empty():
        return {'stage': 'idle', 'downloaded_bytes': 0, 'total_bytes': None, 'error': ''}

    def path(self, kind):
        if kind not in self.states:
            raise ValueError('未知决策资源')
        return self.root / (kind if kind in RUNTIMES else 'models/' + resource_entry(kind)['id'])

    @staticmethod
    def files(kind):
        return MODEL_FILES if kind == 'model' else resource_entry(kind)['files']

    def installed(self, kind):
        path = self.path(kind)
        if kind == 'runtime-gguf':
            return decision_native.installed(path)
        try:
            marker = json.loads((path / 'installed.json').read_text())
            if kind == 'runtime':
                return (marker['python'] == list(sys.version_info[:2]) and marker['packages'] == PACKAGES
                        and marker['platform'] == [sys.platform, platform.machine()]
                        and all((path / 'lib' / name).is_dir() for name in ('laya', 'torch', 'transformers')))
            return marker['revision'] == resource_entry(kind).get('revision', REVISION) and all(
                not (path / name).is_symlink() and (path / name).stat().st_size == size
                for name, size, _ in self.files(kind))
        except (OSError, KeyError, ValueError):
            return False

    def snapshot(self):
        return {k: {**v, 'installed': self.installed(k), 'path': str(self.path(k)),
                    'size_bytes': sum(f[1] for f in self.files(k)) if k not in RUNTIMES else None}
                for k, v in self.states.items()}

    def verify_model(self, kind='model'):
        for name, _, expected in self.files(kind):
            path = self.path(kind) / name
            if path.is_symlink():
                raise ValueError('模型资源无效')
            with path.open('rb') as file:
                if hashlib.file_digest(file, 'sha256').hexdigest() != expected:
                    raise ValueError('模型资源校验失败，请删除后重新下载')

    async def download(self, kind):
        self.path(kind)
        async with self.lock:
            if self.task and not self.task.done():
                raise ValueError('请等待当前下载完成或取消下载')
            if await resource_io(self.installed, kind):
                return
            self.target = kind
            self.states[kind] = {**self.empty(), 'stage': 'resolving'}
            self.task = asyncio.create_task(self._download(kind))

    async def _download(self, kind):
        stage = self.root / ('.install-' + uuid.uuid4().hex)
        try:
            await resource_io(stage.mkdir, parents=True)
            await self._install(kind, stage)
            self.states[kind]['stage'] = 'verifying'
            marker = {'revision': resource_entry(kind).get('revision', REVISION)} if kind not in RUNTIMES else {
                'python': list(sys.version_info[:2]), 'packages': PACKAGES,
                'platform': [sys.platform, platform.machine()],
            }
            if kind == 'runtime-gguf':
                marker = await resource_io(decision_native.marker, stage)
            def publish():
                (stage / 'installed.json').write_text(json.dumps(marker))
                target = self.path(kind)
                target.parent.mkdir(parents=True, exist_ok=True)
                if target.exists():
                    shutil.rmtree(target)
                stage.rename(target)
            publishing = asyncio.create_task(asyncio.to_thread(publish))
            try:
                await asyncio.shield(publishing)
            except asyncio.CancelledError:
                # Publication is a filesystem commit: finish it before cleanup.
                await publishing
                self.states[kind]['stage'] = 'installed'
                return
            self.states[kind]['stage'] = 'installed'
        except asyncio.CancelledError:
            self.states[kind]['stage'] = 'cancelled'
            raise
        except Exception:
            self.states[kind].update(stage='error', error='决策资源安装失败，请检查网络、磁盘空间与平台兼容性后重试')
        finally:
            await resource_io(shutil.rmtree, stage, True)

    async def _install(self, kind, stage):
        state = self.states[kind]
        if kind == 'runtime-gguf':
            name, size, digest = decision_native.asset()
            state.update(stage='downloading', total_bytes=size)
            archive = stage / name
            async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
                await self.fetch(client, f'{decision_native.BASE}/{name}', archive, size, digest, state)
            state['stage'] = 'installing'
            await resource_io(decision_native.unpack, archive, stage)
            await resource_io(archive.unlink)
            binary = await resource_io(decision_native.find_binary, stage)
            await self.run_process([str(binary), '--version'], 30)
            return
        if kind not in RUNTIMES:
            files = self.files(kind)
            base_url = MODEL_BASE if kind == 'model' else resource_entry(kind)['base_url']
            state.update(stage='downloading', total_bytes=sum(f[1] for f in files))
            if await resource_io(lambda: shutil.disk_usage(stage).free) < state['total_bytes'] * 2:
                raise ValueError('磁盘空间不足')
            async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
                for name, size, digest in files:
                    path = stage / name
                    await resource_io(path.parent.mkdir, parents=True, exist_ok=True)
                    await self.fetch(client, f'{base_url}/{name}', path, size, digest, state)
            return
        # Use the bundled interpreter; install ONLY into this resource's staging directory.
        # Desktop includes pip. Development uv environments may use uv instead.
        uv = await resource_io(shutil.which, 'uv')
        if await resource_io(_has_pip):
            cmd = [sys.executable, '-I', '-m', 'pip', 'install', '--disable-pip-version-check']
        elif uv:
            cmd = [uv, 'pip', 'install', '--python', sys.executable]
        else:
            raise ValueError('宿主缺少 pip 或 uv')
        packages = list(PACKAGES)
        cmd += ['--only-binary=:all:', '--no-compile', '--index-url', 'https://pypi.org/simple',
                '--target', str(stage / 'lib')]
        if sys.platform.startswith('linux'):
            # Avoid downloading CUDA libraries on CPU desktop/container installations.
            packages[1] += '+cpu'
            cmd += ['--extra-index-url', 'https://download.pytorch.org/whl/cpu']
        state['stage'] = 'installing'
        await self.run_process([*cmd, *packages], 1800)
        await self.run_process([sys.executable, '-I', str(Path(__file__).with_name('decision_worker.py')),
                                str(stage / 'lib'), '--check'], 120)

    @staticmethod
    async def run_process(command, timeout):
        process = await asyncio.create_subprocess_exec(*command, stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL, env={**os.environ, 'PIP_NO_INPUT': '1'})
        try:
            if await asyncio.wait_for(process.wait(), timeout) != 0:
                raise ValueError('推理运行组件安装或校验失败')
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()

    @staticmethod
    async def fetch(client, url, path, size, expected, state):
        digest, count = hashlib.sha256(), 0
        file = await resource_io(path.open, 'wb')
        try:
            async with client.stream('GET', url, headers={'Accept-Encoding': 'identity'}) as response:
                response.raise_for_status()
                async for chunk in response.aiter_bytes(256 * 1024):
                    count += len(chunk)
                    if count > size:
                        raise ValueError('模型文件大小不符')
                    digest.update(chunk)
                    await resource_io(file.write, chunk)
                    state['downloaded_bytes'] += len(chunk)
        finally:
            await resource_io(file.close)
        if count != size or digest.hexdigest() != expected:
            raise ValueError('模型文件校验失败')

    async def cancel(self, kind):
        self.path(kind)
        async with self.lock:
            if self.target == kind and self.task and not self.task.done():
                self.task.cancel()
                await asyncio.gather(self.task, return_exceptions=True)
                if self.states[kind]['stage'] != 'installed':
                    self.states[kind]['stage'] = 'cancelled'

    async def delete(self, kind):
        await self.cancel(kind)
        async with self.lock:
            await resource_io(shutil.rmtree, self.path(kind), True)
            self.states[kind] = self.empty()

    async def close(self):
        if self.target:
            await self.cancel(self.target)
