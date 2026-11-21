"""Verified on-demand model and binary-wheel installation, outside the application."""
import asyncio
import json
import os
import shutil
import sys
from pathlib import Path
from urllib.parse import quote

import httpx
from packaging.tags import sys_tags
from packaging.utils import parse_wheel_filename

from engines.core.process_cleanup import finish_cleanup
from services.speech import PACKAGES, unpack_wheel
from services.tts_catalog import APPLE_SILICON, LOCAL_MODELS, MODELS, file_source
from services.voice_model_source import model_origin
from services.resource_download import ResourceDownload
from services import tts_qwen_resources

MOSS_PACKAGES = [('onnxruntime', '1.29.0'), ('sentencepiece', '0.2.2'),
                 ('protobuf', '6.33.5'), ('flatbuffers', '25.9.23'), PACKAGES[-1]]
OMNI_RUNTIME = f'design-runtime-cp{sys.version_info.major}{sys.version_info.minor}-v1'
# Validated together on Apple Silicon. Only the inference libraries are installed.
OMNI_PACKAGES = [
    ('mlx-audio', '0.5.0'), ('mlx', '0.32.1'), ('mlx-metal', '0.32.1'), ('numpy', '2.2.6'),
    ('transformers', '5.15.1'), ('tokenizers', '0.22.2'), ('huggingface-hub', '1.28.0'),
    ('miniaudio', '1.71'), ('sounddevice', '0.5.6'), ('scipy', '1.17.1'),
    ('pyyaml', '6.0.3'), ('filelock', '4.2.4'), ('packaging', '26.3'), ('tqdm', '4.70.0'),
    ('safetensors', '0.8.0'), ('regex', '2026.7.19'), ('hf-xet', '1.6.0'), ('fsspec', '2026.7.0'),
    ('httpx', '0.28.1'), ('httpcore', '1.0.9'), ('h11', '0.16.0'), ('anyio', '4.14.2'),
    ('certifi', '2026.10.23'), ('idna', '3.19'), ('typing-extensions', '4.16.0'),
    ('click', '8.4.2'), ('typer', '0.27.1'), ('shellingham', '1.5.4'), ('rich', '15.0.0'),
    ('annotated-doc', '0.0.5'), ('markdown-it-py', '4.2.0'), ('mdurl', '0.1.2'),
    ('pygments', '2.21.0'), ('cffi', '2.1.1'), ('pycparser', '3.0'),
]
NATIVE_EXECUTABLES = {'cosyvoice3': 'cosyvoice3_server', 'omnivoice': 'soniqo-tts-sidecar'}


def local_worker_command(root, model_id, bundle, check=False, *, design_runtime=None):
    return [sys.executable, '-I', str(Path(__file__).with_name('tts_local_worker.py')),
            model_id, str(bundle), str(root), *(['--design-runtime', str(design_runtime)] if design_runtime else []),
            *(['--check'] if check else [])]


class TtsResources:
    def __init__(self, root):
        self.root = Path(root)
        self.states = {}
        self.task = None
        self.target = None

    def path(self, model_id):
        if model_id not in MODELS:
            raise ValueError('Unsupported voice output model')
        return self.root / model_id

    def platform_error(self, model_id):
        if model_id in NATIVE_EXECUTABLES and not APPLE_SILICON:
            return 'This speech model requires an Apple Silicon Mac'
        return ''

    def runtime_error(self, model_id):
        binary = NATIVE_EXECUTABLES.get(model_id)
        if not binary:
            return ''
        runtime = self.root.parent / 'model-runtimes' / model_id
        dependencies = ('libmlx.dylib', 'libjaccl.dylib', 'mlx.metallib') if model_id == 'cosyvoice3' else ('mlx.metallib',)
        if not (runtime / binary).is_file() or not os.access(runtime / binary, os.X_OK) or not all(
            (runtime / file).is_file() for file in dependencies
        ):
            return 'The host is missing the native runtime for this model'
        return ''

    def omni_design_ready(self):
        return (self.path('omnivoice') / OMNI_RUNTIME / 'verified').is_file()

    def installed(self, model_id):
        path = self.path(model_id)
        try:
            marker = json.loads((path / 'installed.json').read_text())
            if model_id in LOCAL_MODELS:
                expected = [[name, size] for name, size, _, _ in MODELS[model_id]['files']]
                return (not self.platform_error(model_id)
                        and marker['revision'] == MODELS[model_id]['revision']
                        and marker['files'] == expected
                        and (model_id != 'moss-nano' or (
                            marker['python'] == f'{sys.version_info.major}.{sys.version_info.minor}'
                            and all((path / 'runtime' / name).is_dir() for name in ('onnxruntime', 'sentencepiece', 'numpy'))))
                        and all((path / name).stat().st_size == size for name, size in expected))
            return (marker['revision'] == MODELS[model_id]['revision']
                    and ((tts_qwen_resources.installed(self.root.parent)) if MODELS[model_id]['runtime'] == 'qwen' else (
                        marker['python'] == f'{sys.version_info.major}.{sys.version_info.minor}'
                        and (path / 'runtime/sherpa_onnx').is_dir()))
                    and all((path / name).stat().st_size == size for name, size in marker['files']))
        except (OSError, ValueError, KeyError, TypeError):
            return False

    async def download(self, model_id, mirror=None):
        origin = model_origin(mirror)
        self.path(model_id)
        error = await asyncio.to_thread(self.platform_error, model_id)
        if error:
            raise ValueError(error)
        if self.task and not self.task.done():
            if self.target != model_id:
                raise ValueError('Wait for the current model download to finish or cancel it')
            return
        installed = await asyncio.to_thread(self.installed, model_id)
        upgrade = installed and model_id == 'omnivoice' and not await asyncio.to_thread(self.omni_design_ready)
        if installed and not upgrade:
            return
        self.target = model_id
        self.states[model_id] = dict(stage='resolving', downloaded_bytes=0, total_bytes=None, error='')
        self.task = asyncio.create_task(self._download(model_id, origin, runtime_only=upgrade))

    async def cancel(self):
        task = self.task
        if task and not task.done():
            task.cancel()
            await finish_cleanup(asyncio.gather(task, return_exceptions=True))
            if self.task is task and self.states[self.target]['stage'] == 'resolving':
                self.states[self.target]['stage'] = 'cancelled'

    async def _download(self, model_id, origin, *, runtime_only=False):
        spec = MODELS[model_id]
        state = self.states[model_id]
        cache = ResourceDownload(self.root, model_id)
        stage = cache.stage
        try:
            def prepare():
                shutil.rmtree(stage, ignore_errors=True)
                stage.mkdir(parents=True)
            await finish_cleanup(asyncio.to_thread(prepare))
            async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
                # The immutable manifest comes with the application and is independent of the mirror.
                entries = [] if runtime_only else spec['files']
                ranks = {tag: i for i, tag in enumerate(sys_tags())}
                wheel_packages = {'sherpa': PACKAGES, 'moss': MOSS_PACKAGES, 'omnivoice': OMNI_PACKAGES}.get(spec['runtime'], ())
                metadata_gate = asyncio.Semaphore(6)

                async def resolve_wheel(package, version):
                    async with metadata_gate:
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
                        raise ValueError('No compatible speech runtime for this platform')
                    return min(candidates, key=lambda item: item[0])[1]

                async with asyncio.TaskGroup() as group:
                    pending_wheels = [group.create_task(resolve_wheel(*package)) for package in wheel_packages]
                wheels = [wheel.result() for wheel in pending_wheels]
                state['total_bytes'] = sum(size for _, size, _, _ in entries) + sum(w['size'] for w in wheels)
                free = await asyncio.to_thread(lambda: shutil.disk_usage(stage).free + cache.cached_bytes())
                if free < state['total_bytes'] * 3 + (6 * 1024**3 if spec['runtime'] == 'qwen' else 0):
                    raise ValueError('Insufficient disk space')
                state['stage'] = 'downloading'
                gate = asyncio.Semaphore(6)

                async def fetch(url, name, size, digest, kind='sha256'):
                    async with gate:
                        await cache.fetch(client, url, stage / name, size, digest, state, kind)

                async with asyncio.TaskGroup() as group:
                    for name, size, digest, kind in entries:
                        repo, revision, remote_name = file_source(model_id, name)
                        url = f"{origin}/{repo}/resolve/{revision}/{quote(remote_name)}"
                        group.create_task(fetch(url, name, size, digest, kind))
                    for wheel in wheels:
                        group.create_task(fetch(wheel['url'], wheel['filename'], wheel['size'], wheel['digests']['sha256']))
                state['stage'] = 'installing'
                runtime_dir = stage / (OMNI_RUNTIME if model_id == 'omnivoice' else 'runtime')
                for wheel in wheels:
                    await finish_cleanup(asyncio.to_thread(unpack_wheel, stage / wheel['filename'], runtime_dir))
                    await finish_cleanup(asyncio.to_thread((stage / wheel['filename']).unlink))
            if model_id == 'omnivoice':
                bundle = self.path(model_id) if runtime_only else stage
                command = local_worker_command(self.root.parent, model_id, bundle, True, design_runtime=runtime_dir)
            elif model_id in LOCAL_MODELS:
                await asyncio.to_thread((self.root.parent / 'references').mkdir, parents=True, exist_ok=True)
                native_missing = await asyncio.to_thread(self.runtime_error, model_id)
                command = None if native_missing else local_worker_command(self.root.parent, model_id, stage, True)
            elif spec['runtime'] == 'qwen':
                await tts_qwen_resources.ensure(self.root.parent, state)
                command = await asyncio.to_thread(tts_qwen_resources.worker_command, stage, True)
            else:
                command = [sys.executable, '-I', str(Path(__file__).with_name('tts_worker.py')), str(stage), '--check']
            if command:
                await tts_qwen_resources.run(command, timeout=360)
            def publish():
                target = self.path(model_id)
                if model_id == 'omnivoice':
                    (runtime_dir / 'verified').touch()
                    if runtime_only:
                        runtime_dir.rename(target / OMNI_RUNTIME)
                        return
                (stage / 'installed.json').write_text(json.dumps(dict(revision=spec['revision'],
                    python=f'{sys.version_info.major}.{sys.version_info.minor}',
                    files=[(name, size) for name, size, _, _ in entries])))
                if target.exists():
                    shutil.rmtree(target)
                stage.rename(target)
            async def complete():
                await asyncio.to_thread(publish)
                state['stage'] = 'installed'
                await asyncio.to_thread(shutil.rmtree, cache.folder, True)
            await finish_cleanup(complete())
        except asyncio.CancelledError:
            if state['stage'] != 'installed':
                state['stage'] = 'cancelled'
            raise
        except Exception:
            state.update(stage='error', error='Could not install the speech model. Check the network, free space, and platform compatibility.')
        finally:
            await finish_cleanup(asyncio.to_thread(shutil.rmtree, stage, True))

    def install_status(self, model_id):
        return dict(self.states.get(model_id, dict(stage='idle', downloaded_bytes=0, total_bytes=None, error='')),
                    partial_bytes=ResourceDownload(self.root, model_id).cached_bytes())

    async def delete(self, model_id, partial_only=False):
        path = self.path(model_id)
        await finish_cleanup(self._delete(model_id, path, partial_only))

    async def _delete(self, model_id, path, partial_only):
        if self.target == model_id:
            await self.cancel()
        await asyncio.to_thread(ResourceDownload(self.root, model_id).discard)
        if not partial_only:
            await asyncio.to_thread(shutil.rmtree, path, True)
        self.states.pop(model_id, None)
