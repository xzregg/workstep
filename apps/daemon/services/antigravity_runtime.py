"""Official flat agy releases installed only inside WorkStep's runtime root."""
import os
import platform
import re
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path
from tempfile import TemporaryDirectory

import httpx
from packaging.version import Version

from services import config

MANIFEST_HOST = 'antigravity-cli-auto-updater-974169037036.us-central1.run.app'


def managed_binary() -> Path:
    return config.CONFIG_DIR / 'runtime' / 'native' / 'antigravity' / ('agy.exe' if sys.platform == 'win32' else 'agy')


def platform_key() -> str:
    machine = platform.machine().lower()
    arch = {'x86_64': 'amd64', 'amd64': 'amd64', 'aarch64': 'arm64', 'arm64': 'arm64'}.get(machine)
    system = {'darwin': 'darwin', 'linux': 'linux', 'win32': 'windows'}.get(sys.platform)
    if not arch or not system:
        raise ValueError('Antigravity CLI does not support this platform')
    musl = system == 'linux' and (
        platform.libc_ver()[0] == 'musl'
        or Path('/lib/libc.musl-x86_64.so.1').exists()
        or Path('/lib/libc.musl-aarch64.so.1').exists()
    )
    return f'{system}_{arch}' + ('_musl' if musl else '')


def validate_release(entry: dict) -> dict:
    if not isinstance(entry, dict):
        raise ValueError('Invalid Antigravity release manifest')
    url = httpx.URL(entry.get('url', ''))
    if (url.scheme != 'https' or url.host != 'storage.googleapis.com'
            or url.port not in (None, 443) or url.userinfo or url.query or url.fragment
            or not url.path.startswith('/antigravity-public/antigravity-cli/')
            or not url.path.endswith(('.tar.gz', '.exe'))):
        raise ValueError('Invalid official Antigravity download address')
    if not re.fullmatch(r'[a-f0-9]{128}', entry.get('sha512', '')):
        raise ValueError('Invalid Antigravity SHA-512 checksum')
    version = entry.get('version', '')
    if not re.fullmatch(r'[0-9][0-9A-Za-z.+-]{0,99}', version):
        raise ValueError('Invalid Antigravity version')
    Version(version)
    return {**entry, 'filename': 'agy.tar.gz' if url.path.endswith('.tar.gz') else 'agy.exe',
            'prerelease': Version(version).is_prerelease}


async def latest_release(*, transport=None) -> dict:
    # Platform inspection may touch disk / libc metadata.
    import asyncio
    key = await asyncio.to_thread(platform_key)
    async with httpx.AsyncClient(transport=transport, timeout=30) as client:
        response = await client.get(f'https://{MANIFEST_HOST}/manifests/{key}.json')
        response.raise_for_status()
        entry = validate_release(response.json())
        size = await client.head(entry['url'], headers={'Accept-Encoding': 'identity'})
        size.raise_for_status()
        length = size.headers.get('content-length', '')
        if not length.isdigit() or int(length) <= 0:
            raise ValueError('Official Antigravity archive size is unavailable')
        entry.update(size_bytes=int(length), platform=key)
        return entry


def binary_version(binary: Path) -> str | None:
    try:
        options = {'creationflags': subprocess.CREATE_NO_WINDOW} if sys.platform == 'win32' else {}
        result = subprocess.run([str(binary), '--version'], capture_output=True, text=True, timeout=5, **options)
        match = re.search(r'\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?', result.stdout)
        return match.group() if result.returncode == 0 and match else None
    except (OSError, subprocess.TimeoutExpired):
        return None


def stage_binary(archive: Path, target: Path, version: str):
    if archive.name.endswith('.tar.gz'):
        with tarfile.open(archive, 'r:gz') as source:
            member = source.getmember('antigravity')
            if not member.isfile():
                raise ValueError('Antigravity archive does not contain a regular executable')
            # Read only the known regular member; never extract links or paths.
            with source.extractfile(member) as data, target.open('wb') as output:
                shutil.copyfileobj(data, output)
    else:
        shutil.copyfile(archive, target)
    target.chmod(0o755)
    if binary_version(target) != version:
        raise ValueError('Temporary native executable version check failed; original installation remains unchanged')


def install_archive(archive: Path, version: str):
    target = managed_binary()
    target.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix='.agy-stage-', dir=target.parent) as directory:
        stage = Path(directory) / target.name
        stage_binary(archive, stage, version)
        # Single-file native build: same-volume replace is atomic. A locked
        # Windows executable fails here without deleting the previous binary.
        os.replace(stage, target)
