"""Safely materialize signed Gateway Skill versions in one project."""

from services.project_storage import data_directory
import hashlib
import io
import json
import os
import re
import shutil
import stat
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

from services.skill_center import MANIFEST_NAME, MANIFEST_VERSION, SkillCenter

MAX_ARCHIVE_BYTES = 8 * 1024 * 1024
MAX_FILE_BYTES = 1024 * 1024
MAX_TOTAL_BYTES = 10 * 1024 * 1024
MAX_FILES = 100


def project_needs_sync(project_root: Path, desired: dict) -> bool:
    manifest_path = data_directory(project_root) / "skills" / MANIFEST_NAME
    if not manifest_path.is_file() or manifest_path.is_symlink():
        return True
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if manifest.get("gateway_skill_revision") != desired["revision"]:
            return True
        entries = manifest["entries"]
        expected = {f"gateway:{item['skill_id']}" for item in desired["skills"]}
        actual = {key for key, entry in entries.items()
                  if isinstance(entry, dict) and entry.get("source") == "gateway"}
        if expected != actual:
            return True
        for item in desired["skills"]:
            entry = entries[f"gateway:{item['skill_id']}"]
            path = manifest_path.parent / item["slug"]
            if (entry.get("version_id") != item["skill_version_id"]
                    or entry.get("digest") != item["digest"]
                    or entry.get("destination") != item["slug"]
                    or path.is_symlink() or not path.is_dir()
                    or not (path / "SKILL.md").is_file()
                    or SkillCenter._fingerprint(path) != entry.get("fingerprint")):
                return True
        return False
    except (OSError, ValueError, KeyError, TypeError):
        return True


def _extract_archive(raw: bytes, target: Path, entry: dict) -> None:
    if len(raw) > MAX_ARCHIVE_BYTES or hashlib.sha256(raw).hexdigest() != entry["digest"]:
        raise ValueError("Skill archive digest mismatch")
    count = total = 0
    names: set[str] = set()
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            for info in archive.infolist():
                name = info.filename
                mode = info.external_attr >> 16
                if (not name or name.startswith("/") or "\\" in name or ":" in name
                        or any(part in ("", ".", "..") for part in name.rstrip("/").split("/"))
                        or len(name) > 512 or len(PurePosixPath(name).parts) > 12
                        or stat.S_ISLNK(mode)):
                    raise ValueError("Invalid Skill archive path")
                destination = target.joinpath(*PurePosixPath(name).parts)
                if info.is_dir():
                    destination.mkdir(parents=True, exist_ok=True)
                    continue
                if name in names or info.file_size > MAX_FILE_BYTES:
                    raise ValueError("Invalid Skill archive file")
                names.add(name)
                count += 1
                total += info.file_size
                if count > MAX_FILES or total > MAX_TOTAL_BYTES:
                    raise ValueError("Skill archive exceeds limits")
                destination.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(info) as source, destination.open("xb") as output:
                    size = 0
                    while chunk := source.read(65536):
                        size += len(chunk)
                        if size > MAX_FILE_BYTES:
                            raise ValueError("Skill file exceeds limit")
                        output.write(chunk)
                    if size != info.file_size:
                        raise ValueError("Skill archive size mismatch")
    except (zipfile.BadZipFile, OSError, RuntimeError) as exc:
        raise ValueError("Invalid Skill archive") from exc
    if ("SKILL.md" not in names or count != entry["file_count"]
            or total != entry["total_size"]):
        raise ValueError("Skill archive contents mismatch")


def apply_project_skills(project_root: Path, desired: dict,
                         archives: dict[str, bytes]) -> None:
    root = Path(project_root).expanduser().resolve()
    revision = desired.get("revision")
    skills = desired.get("skills")
    if (type(revision) is not int or revision < 0 or not isinstance(skills, list)
            or len(skills) > 100):
        raise ValueError("Invalid Skill project revision")
    checked: dict[str, dict] = {}
    slugs: set[str] = set()
    for entry in skills:
        if (not isinstance(entry, dict)
                or not isinstance(entry.get("skill_id"), str)
                or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", entry["skill_id"])
                or not isinstance(entry.get("slug"), str)
                or not re.fullmatch(r"[a-z0-9][a-z0-9-]*", entry["slug"])
                or not isinstance(entry.get("skill_version_id"), str)
                or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", entry["skill_version_id"])
                or not isinstance(entry.get("digest"), str)
                or not re.fullmatch(r"[0-9a-f]{64}", entry["digest"])
                or type(entry.get("file_count")) is not int
                or not 1 <= entry["file_count"] <= MAX_FILES
                or type(entry.get("total_size")) is not int
                or not 1 <= entry["total_size"] <= MAX_TOTAL_BYTES
                or not isinstance(entry.get("source_group_id"), str)
                or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", entry["source_group_id"])
                or entry["skill_id"] in checked or entry["slug"] in slugs):
            raise ValueError("Invalid Skill project entry")
        checked[entry["skill_id"]] = entry
        slugs.add(entry["slug"])

    with SkillCenter._lock_for(root):
        skills_root = data_directory(root) / "skills"
        if skills_root.is_symlink():
            raise ValueError("Skill root cannot be a symlink")
        skills_root.mkdir(parents=True, exist_ok=True)
        manifest_path = skills_root / MANIFEST_NAME
        if manifest_path.is_symlink():
            raise ValueError("Skill manifest cannot be a symlink")
        if manifest_path.exists():
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            except (OSError, ValueError) as exc:
                raise ValueError("Invalid Skill manifest") from exc
            if not isinstance(manifest, dict) or not isinstance(manifest.get("entries"), dict):
                raise ValueError("Invalid Skill manifest")
        else:
            manifest = {"version": MANIFEST_VERSION, "entries": {}}
        entries = manifest["entries"]
        if revision < manifest.get("gateway_skill_revision", -1):
            raise ValueError("Stale Skill revision")
        for skill_id, entry in checked.items():
            slug = entry["slug"]
            destination = skills_root / slug
            key = f"gateway:{skill_id}"
            previous = entries.get(key)
            if (destination.is_symlink() or any(
                other_key != key and isinstance(other, dict)
                and str(other.get("destination") or other.get("name")) == slug
                for other_key, other in entries.items()
            ) or destination.exists() and (
                not isinstance(previous, dict) or previous.get("source") != "gateway"
                or previous.get("destination") != slug
            )):
                raise ValueError(f"name_conflict:{slug}")
        stage = Path(tempfile.mkdtemp(prefix=".gateway-skills-", dir=skills_root))
        replaced: list[tuple[Path, Path | None]] = []
        try:
            staged: dict[str, Path] = {}
            for skill_id, entry in checked.items():
                key = f"gateway:{skill_id}"
                current = entries.get(key)
                destination = skills_root / entry["slug"]
                if (isinstance(current, dict) and current.get("source") == "gateway"
                        and current.get("version_id") == entry["skill_version_id"]
                        and current.get("digest") == entry["digest"]
                        and current.get("destination") == entry["slug"]
                        and destination.is_dir()
                        and SkillCenter._fingerprint(destination) == current.get("fingerprint")):
                    continue
                raw = archives.get(entry["skill_version_id"])
                if not isinstance(raw, bytes):
                    raise ValueError("Missing Skill archive")
                candidate = stage / f"new-{skill_id}"
                candidate.mkdir()
                _extract_archive(raw, candidate, entry)
                staged[skill_id] = candidate
            for key, old in list(entries.items()):
                if not key.startswith("gateway:") or not isinstance(old, dict):
                    continue
                if old.get("source") != "gateway":
                    raise ValueError("Invalid managed Skill manifest entry")
                if key.removeprefix("gateway:") not in checked:
                    old_slug = old.get("destination")
                    if not isinstance(old_slug, str) or not re.fullmatch(
                            r"[a-z0-9][a-z0-9-]*", old_slug):
                        raise ValueError("Invalid managed Skill destination")
                    destination = skills_root / old_slug
                    if destination.is_symlink():
                        raise ValueError("Invalid managed Skill destination")
                    if destination.exists():
                        backup = stage / f"old-{len(replaced)}"
                        os.replace(destination, backup)
                        replaced.append((destination, backup))
                    entries.pop(key)
            for skill_id, candidate in staged.items():
                entry = checked[skill_id]
                destination = skills_root / entry["slug"]
                old = entries.get(f"gateway:{skill_id}")
                if isinstance(old, dict):
                    old_slug = old.get("destination")
                    if not isinstance(old_slug, str) or not re.fullmatch(
                            r"[a-z0-9][a-z0-9-]*", old_slug):
                        raise ValueError("Invalid managed Skill destination")
                    previous_dest = skills_root / old_slug
                    if previous_dest.is_symlink():
                        raise ValueError("Invalid managed Skill destination")
                    if previous_dest != destination and previous_dest.exists():
                        backup = stage / f"old-{len(replaced)}"
                        os.replace(previous_dest, backup)
                        replaced.append((previous_dest, backup))
                backup = None
                if destination.exists():
                    backup = stage / f"old-{len(replaced)}"
                    os.replace(destination, backup)
                replaced.append((destination, backup))
                os.replace(candidate, destination)
            for skill_id, entry in checked.items():
                destination = skills_root / entry["slug"]
                entries[f"gateway:{skill_id}"] = {
                    "name": entry["slug"], "description": "",
                    "source": "gateway", "source_path": str(destination),
                    "destination": entry["slug"], "enabled": True,
                    "valid": True, "error": None, "ui": {},
                    "sync_status": "synced", "fingerprint": SkillCenter._fingerprint(destination),
                    "gateway_skill_id": skill_id,
                    "version_id": entry["skill_version_id"],
                    "version": entry["version"], "digest": entry["digest"],
                    "source_group_id": entry["source_group_id"],
                    "revision": revision,
                }
            manifest["gateway_skill_revision"] = revision
            SkillCenter._write_manifest(manifest_path, manifest)
        except Exception:
            for destination, backup in reversed(replaced):
                if destination.exists():
                    shutil.rmtree(destination)
                if backup is not None and backup.exists():
                    os.replace(backup, destination)
            raise
        finally:
            shutil.rmtree(stage, ignore_errors=True)
