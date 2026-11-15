"""Shared, private Qwen interpreter and dependencies, installed only on download."""
import asyncio
import hashlib
import json
import os
import platform
import shutil
import sys
import uuid
import zipfile
from pathlib import Path

import httpx
from packaging.tags import sys_tags
from packaging.utils import parse_wheel_filename

from engines.core.process_cleanup import finish_cleanup, terminate_owned_process

UV_VERSION = '0.9.26'
PACKAGES = ['qwen-tts==0.1.1', 'torch==2.10.0', 'torchaudio==2.10.0', 'numpy==2.2.6',
            'transformers==4.57.3', 'accelerate==1.12.0', 'librosa==0.11.0', 'soundfile==0.13.1',
            'sox==1.5.0', 'onnxruntime==1.23.2', 'einops==0.8.1']


async def io(operation, *args, **kwargs):
    task = asyncio.create_task(asyncio.to_thread(operation, *args, **kwargs))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        await asyncio.gather(task, return_exceptions=True)
        raise


async def run(command, timeout=1800, capture=False, env=None):
    proc = None
    async def spawn():
        nonlocal proc
        proc = await asyncio.create_subprocess_exec(*map(str, command),
            stdout=asyncio.subprocess.PIPE if capture else asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL, env=env)
    try:
        await finish_cleanup(spawn())
        data, _ = await asyncio.wait_for(proc.communicate(), timeout)
        if proc.returncode:
            raise ValueError('Qwen 运行环境安装或校验失败')
        return data.decode().strip() if capture else ''
    finally:
        if proc is not None and proc.returncode is None:
            await finish_cleanup(terminate_owned_process(proc))


def installed(root):
    root = Path(root)
    try:
        marker = json.loads((root / 'qwen-runtime/installed.json').read_text())
        return (marker['packages'] == PACKAGES and marker['platform'] == [sys.platform, platform.machine()]
                and Path(marker['python']).is_file()
                and Path(marker['python']).resolve().is_relative_to((root / 'python').resolve())
                and all((root / 'qwen-runtime/lib' / name).is_dir() for name in ('qwen_tts', 'torch', 'transformers')))
    except (OSError, KeyError, ValueError, TypeError):
        return False


async def ensure(root, state):
    root = Path(root)
    if await io(installed, root):
        return
    stage = root / ('.qwen-runtime-' + uuid.uuid4().hex)
    await io(stage.mkdir, parents=True)
    state['stage'] = 'installing'
    try:
        # Bootstrap a hash-checked native uv wheel even in packaged desktop apps
        # without pip. Python stays under this host's speech-output directory.
        async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
            response = await client.get(f'https://pypi.org/pypi/uv/{UV_VERSION}/json')
            response.raise_for_status()
            ranks = {tag: i for i, tag in enumerate(sys_tags())}
            candidates = []
            for entry in response.json()['urls']:
                if not entry['filename'].endswith('.whl') or entry.get('yanked'):
                    continue
                rank = min((ranks[t] for t in parse_wheel_filename(entry['filename'])[3] if t in ranks), default=None)
                if rank is not None:
                    candidates.append((rank, entry))
            if not candidates:
                raise ValueError('当前平台没有 Qwen 运行组件')
            wheel = min(candidates, key=lambda item: item[0])[1]
            archive = stage / 'uv.whl'
            digest, count = hashlib.sha256(), 0
            out = await io(archive.open, 'wb')
            try:
                async with client.stream('GET', wheel['url']) as response:
                    response.raise_for_status()
                    async for chunk in response.aiter_bytes(256 * 1024):
                        count += len(chunk)
                        if count > wheel['size']:
                            raise ValueError('运行组件大小不符')
                        digest.update(chunk)
                        await io(out.write, chunk)
            finally:
                await io(out.close)
            if count != wheel['size'] or digest.hexdigest() != wheel['digests']['sha256']:
                raise ValueError('运行组件校验失败')
        def unpack():
            with zipfile.ZipFile(archive) as zip:
                members = [n for n in zip.namelist() if n.endswith('/uv.exe' if os.name == 'nt' else '/uv')]
                if len(members) != 1:
                    raise ValueError('运行组件不完整')
                binary = stage / ('uv.exe' if os.name == 'nt' else 'uv')
                binary.write_bytes(zip.read(members[0]))
                binary.chmod(0o700)
                return binary
        uv = await io(unpack)
        env = {**os.environ, 'UV_PYTHON_INSTALL_DIR': str(root / 'python'),
               'UV_PYTHON_BIN_DIR': str(root / 'python-bin'),
               'UV_CACHE_DIR': str(root / 'runtime-cache'), 'UV_NO_PROGRESS': '1', 'PIP_NO_INPUT': '1'}
        await run([uv, '--no-config', 'python', 'install', '3.12'], env=env)
        python = await run([uv, '--no-config', 'python', 'find', '3.12', '--system', '--no-project',
                            '--managed-python', '--no-python-downloads'],
                           capture=True, env=env)
        if not await io(lambda: Path(python).is_file() and Path(python).resolve().is_relative_to((root / 'python').resolve())):
            raise ValueError('未找到专用 Python 3.12 解释器')
        packages = list(PACKAGES)
        cmd = [uv, '--no-config', 'pip', 'install', '--python', python, '--target', stage / 'lib',
               '--index-url', 'https://pypi.org/simple', '--no-compile']
        if sys.platform.startswith('linux') or sys.platform == 'win32':
            packages[1] += '+cpu'
            packages[2] += '+cpu'
            cmd += ['--extra-index-url', 'https://download.pytorch.org/whl/cpu', '--index-strategy', 'unsafe-best-match']
        # Install inference dependencies, excluding the package's Gradio demo.
        await run([*cmd, *packages[1:]], env=env)
        await run([*cmd, '--no-deps', packages[0]], env=env)
        await run([python, '-I', '-c',
            'import sys;sys.path.insert(0,sys.argv[1]);import qwen_tts,torch;assert hasattr(qwen_tts,"Qwen3TTSModel")',
            stage / 'lib'], timeout=120, env=env)
        def publish():
            (stage / 'installed.json').write_text(json.dumps(dict(packages=PACKAGES, python=python,
                platform=[sys.platform, platform.machine()])))
            archive.unlink()
            uv.unlink()
            target = root / 'qwen-runtime'
            if target.exists():
                shutil.rmtree(target)
            stage.rename(target)
        await io(publish)
    finally:
        await io(shutil.rmtree, stage, True)


def worker_command(bundle, check=False):
    bundle = Path(bundle)
    root = bundle.parent.parent
    marker = json.loads((root / 'qwen-runtime/installed.json').read_text())
    return [marker['python'], '-I', str(Path(__file__).with_name('tts_qwen_worker.py')),
            str(bundle), str(root / 'qwen-runtime/lib'), *(['--check'] if check else [])]
