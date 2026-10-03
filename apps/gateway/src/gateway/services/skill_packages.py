"""Validate bounded Skill archives before they enter the reviewed catalog."""

import base64
import binascii
import hashlib
import io
import os
import stat
import zipfile
from pathlib import Path, PurePosixPath


MAX_ARCHIVE_BYTES = 8 * 1024 * 1024
MAX_FILE_BYTES = 1024 * 1024
MAX_TOTAL_BYTES = 10 * 1024 * 1024
MAX_FILES = 100


def validate_archive(encoded: str) -> tuple[bytes, str, int, int]:
    if len(encoded) > (MAX_ARCHIVE_BYTES * 4 // 3 + 8):
        raise ValueError("Skill archive too large")
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("Invalid Skill archive encoding") from exc
    if len(raw) > MAX_ARCHIVE_BYTES:
        raise ValueError("Skill archive too large")
    names: set[str] = set()
    count = total = 0
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            for info in archive.infolist():
                path = PurePosixPath(info.filename)
                mode = info.external_attr >> 16
                if (not info.filename or info.filename.startswith("/")
                        or "\\" in info.filename or ":" in info.filename
                        or any(part in ("", ".", "..")
                        for part in info.filename.rstrip("/").split("/"))
                        or len(info.filename) > 512 or len(path.parts) > 12
                        or stat.S_ISLNK(mode)):
                    raise ValueError("Invalid Skill archive path")
                if info.is_dir():
                    continue
                if info.filename in names or info.file_size > MAX_FILE_BYTES:
                    raise ValueError("Invalid Skill archive file")
                names.add(info.filename)
                count += 1
                total += info.file_size
                if count > MAX_FILES or total > MAX_TOTAL_BYTES:
                    raise ValueError("Skill archive exceeds file limits")
                with archive.open(info) as source:
                    size = 0
                    while chunk := source.read(65536):
                        size += len(chunk)
                        if size > MAX_FILE_BYTES:
                            raise ValueError("Skill archive file too large")
                    if size != info.file_size:
                        raise ValueError("Skill archive size mismatch")
    except (zipfile.BadZipFile, OSError, RuntimeError) as exc:
        raise ValueError("Invalid Skill archive") from exc
    if "SKILL.md" not in names:
        raise ValueError("Skill archive requires SKILL.md")
    return raw, hashlib.sha256(raw).hexdigest(), count, total


def save_archive(directory: Path, storage_name: str, raw: bytes) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / storage_name
    with path.open("xb") as output:
        output.write(raw)
        output.flush()
        os.fsync(output.fileno())
