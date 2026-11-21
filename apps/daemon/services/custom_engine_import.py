"""Stage portable engine ZIPs in the shared workspace before local acceptance."""
import asyncio
import io
from pathlib import Path, PurePosixPath
import shutil
import stat
import uuid
import zipfile

from engines.core.custom_package import exported_files, load_manifest

MAX_PACKAGE = 32 * 1024 * 1024


def stage_package(data: bytes, workspace: Path) -> Path:
    root = workspace / f'engine-import-{uuid.uuid4().hex}'
    try:
        if len(data) > MAX_PACKAGE:
            raise ValueError('The engine package must not exceed 32 MiB')
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = archive.infolist()
            if len(entries) > 1003 or sum(item.file_size for item in entries) > MAX_PACKAGE:
                raise ValueError('Engine package is too large or contains too many files after extraction')
            names = set()
            for item in entries:
                path = PurePosixPath(item.filename)
                mode = item.external_attr >> 16
                if (not path.parts or path.is_absolute() or '..' in path.parts
                        or '\\' in item.filename or ':' in item.filename
                        or str(path) != item.filename or item.is_dir()
                        or (stat.S_IFMT(mode) not in {0, stat.S_IFREG})
                        or item.filename in names):
                    raise ValueError('Engine package contains invalid path or special file')
                names.add(item.filename)
            if any(str(parent) in names for name in names for parent in PurePosixPath(name).parents):
                raise ValueError('Engine package file and directory path conflict')
            root.mkdir(parents=True)
            for item in entries:
                target = root / item.filename
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(item) as source, target.open('wb') as destination:
                    shutil.copyfileobj(source, destination)
            manifest = load_manifest(root)
            allowed = set(exported_files(root, manifest)) | {'validation-summary.json'}
            if names != allowed and names != allowed - {'validation-summary.json'}:
                raise ValueError('The engine package can only contain source code, resources, and acceptance summaries declared in the manifest.')
            # An exported summary is informational, never a local acceptance report.
            (root / 'validation-summary.json').unlink(missing_ok=True)
            return root
    except (zipfile.BadZipFile, RuntimeError, NotImplementedError) as exc:
        shutil.rmtree(root, ignore_errors=True)
        raise ValueError('A valid custom engine ZIP package is required') from exc
    except BaseException:
        shutil.rmtree(root, ignore_errors=True)
        raise


async def import_package(data: bytes, title: str | None = None) -> dict:
    from services.custom_engine_onboarding import create_onboarding, workspace_parent
    root = await asyncio.to_thread(lambda: stage_package(data, workspace_parent()))
    try:
        return await create_onboarding(package_path=root, **({"title": title} if title else {}))
    except BaseException:
        await asyncio.to_thread(shutil.rmtree, root, True)
        raise
