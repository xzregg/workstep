"""Project-scoped skill discovery, selection and safe mirroring.

This is the only module allowed to scan personal skill roots. Engines consume
the resolved project selection instead of guessing native skill directories.
"""

from __future__ import annotations

from services.project_storage import data_directory
import hashlib
import json
import os
import shutil
import tempfile
import threading
from dataclasses import asdict, dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Mapping


MANIFEST_NAME = ".workstep-manifest.json"
MANIFEST_VERSION = 1
BUILTIN_SKILLS_DIR = Path(__file__).resolve().parent.parent / "data" / "skills"


class SkillSyncStatus(str, Enum):
    DISABLED = "disabled"
    SYNCED = "synced"
    ERROR = "error"
    MISSING = "missing"


@dataclass(frozen=True)
class SkillDescriptor:
    skill_id: str
    name: str
    description: str
    source: str
    source_path: str
    valid: bool = True
    error: str | None = None
    enabled: bool = False
    sync_status: SkillSyncStatus = SkillSyncStatus.DISABLED
    sync_error: str | None = None
    conflict: bool = False
    ui: dict[str, Any] = field(default_factory=dict)
    runtime_path: Path | None = field(default=None, repr=False, compare=False)

    def to_dict(self) -> dict[str, Any]:
        result = asdict(self)
        result["sync_status"] = self.sync_status.value
        result["runtime_path"] = str(self.runtime_path) if self.runtime_path else None
        return result


@dataclass(frozen=True)
class ProjectSkillSelection:
    project_root: Path
    skills: tuple[SkillDescriptor, ...]
    enabled: tuple[SkillDescriptor, ...]
    disabled_source_paths: tuple[Path, ...]


class SkillCenter:
    """Discover personal skills and materialize one project-owned whitelist."""

    _locks: dict[str, threading.RLock] = {}
    _locks_guard = threading.Lock()

    def __init__(self, source_roots: Mapping[str, Path] | None = None) -> None:
        home = Path.home()
        roots = source_roots or {
            "builtin": BUILTIN_SKILLS_DIR,
            "agents": home / ".agents" / "skills",
            "claude": home / ".claude" / "skills",
            "codex": home / ".codex" / "skills",
        }
        self.source_roots = {
            str(source): Path(path).expanduser().resolve()
            for source, path in roots.items()
        }

    @classmethod
    def _lock_for(cls, project_root: Path) -> threading.RLock:
        key = str(project_root.resolve())
        with cls._locks_guard:
            return cls._locks.setdefault(key, threading.RLock())

    @staticmethod
    def _skill_id(path: Path) -> str:
        normalized = os.path.normcase(str(path.expanduser().resolve()))
        return hashlib.sha256(normalized.encode()).hexdigest()[:24]

    @staticmethod
    def _parse_frontmatter(path: Path) -> tuple[str, str, dict[str, Any], str | None]:
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeError) as exc:
            return path.parent.name, "", {}, f"无法读取 SKILL.md：{exc}"
        if not text.startswith("---"):
            return path.parent.name, "", {}, "SKILL.md 缺少 YAML frontmatter"
        lines = text.splitlines()
        try:
            end = lines.index("---", 1)
        except ValueError:
            return path.parent.name, "", {}, "SKILL.md frontmatter 未闭合"
        try:
            import yaml

            # BaseLoader keeps YAML 1.1 words such as ``on``/``off`` as skill
            # names instead of coercing them to booleans.
            values = yaml.load("\n".join(lines[1:end]), Loader=yaml.BaseLoader) or {}
        except Exception as exc:
            return path.parent.name, "", {}, f"frontmatter 解析失败：{exc}"
        if not isinstance(values, dict):
            return path.parent.name, "", {}, "frontmatter 必须是对象"
        name = str(values.get("name") or "").strip()
        description = str(values.get("description") or "").strip()
        ui = values.get("ui") if isinstance(values.get("ui"), dict) else {}
        if not name:
            return path.parent.name, description, ui, "frontmatter 缺少 name"
        if not description:
            return name, "", ui, "frontmatter 缺少 description"
        if "/" in name or "\\" in name or name in {".", ".."}:
            return name, description, ui, "技能名称不能包含路径分隔符"
        return name, description, ui, None

    def _discover_root(self, source: str, root: Path) -> list[SkillDescriptor]:
        if not root.is_dir():
            return []
        found: list[SkillDescriptor] = []
        for current, dirs, files in os.walk(root, followlinks=False):
            dirs[:] = sorted(
                name for name in dirs if not (Path(current) / name).is_symlink()
            )
            if "SKILL.md" not in files:
                continue
            skill_root = Path(current).resolve()
            name, description, ui, error = self._parse_frontmatter(skill_root / "SKILL.md")
            found.append(
                SkillDescriptor(
                    skill_id=self._skill_id(skill_root),
                    name=name,
                    description=description,
                    source=source,
                    source_path=str(skill_root),
                    valid=error is None,
                    error=error,
                    ui=ui,
                )
            )
            dirs[:] = []
        return found

    def discover(self) -> list[SkillDescriptor]:
        found: list[SkillDescriptor] = []
        for source, root in self.source_roots.items():
            found.extend(self._discover_root(source, root))
        return sorted(found, key=lambda item: (item.name.casefold(), item.source, item.source_path))

    @staticmethod
    def _paths(project_root: Path) -> tuple[Path, Path, Path]:
        workstep = data_directory(project_root)
        skills = workstep / "skills"
        return skills, skills / MANIFEST_NAME, workstep / "skills-disabled"

    def _load_manifest(self, project_root: Path) -> dict[str, Any]:
        skills_root, manifest_path, _ = self._paths(project_root)
        if manifest_path.is_file():
            try:
                payload = json.loads(manifest_path.read_text(encoding="utf-8"))
                if isinstance(payload.get("entries"), dict):
                    return payload
            except (OSError, ValueError, TypeError):
                pass
        manifest: dict[str, Any] = {"version": MANIFEST_VERSION, "entries": {}}
        if skills_root.is_dir():
            for child in sorted(skills_root.iterdir()):
                if not child.is_dir() or child.is_symlink() or not (child / "SKILL.md").is_file():
                    continue
                name, description, ui, error = self._parse_frontmatter(child / "SKILL.md")
                skill_id = self._skill_id(child)
                manifest["entries"][skill_id] = {
                    "name": name,
                    "description": description,
                    "source": "project",
                    "source_path": str(child.resolve()),
                    "enabled": True,
                    "valid": error is None,
                    "error": error,
                    "ui": ui,
                    "sync_status": SkillSyncStatus.SYNCED.value,
                    "destination": name,
                    "fingerprint": self._fingerprint(child) if error is None else "",
                }
        self._write_manifest(manifest_path, manifest)
        return manifest

    @staticmethod
    def _write_manifest(path: Path, manifest: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, temp_name = tempfile.mkstemp(prefix=".manifest-", dir=path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                json.dump(manifest, stream, ensure_ascii=False, indent=2, sort_keys=True)
                stream.write("\n")
            os.replace(temp_name, path)
        finally:
            if os.path.exists(temp_name):
                os.unlink(temp_name)

    @staticmethod
    def _safe_entries(root: Path):
        resolved_root = root.resolve()
        for current, dirs, files in os.walk(root, followlinks=False):
            current_path = Path(current)
            for name in sorted(dirs + files):
                item = current_path / name
                if not item.is_symlink():
                    continue
                try:
                    item.resolve(strict=True).relative_to(resolved_root)
                except (OSError, ValueError):
                    raise ValueError(f"技能包含越出根目录的符号链接：{item}") from None
            yield current_path, sorted(dirs), sorted(files)

    @classmethod
    def _fingerprint(cls, root: Path) -> str:
        digest = hashlib.sha256()
        for current, _dirs, files in cls._safe_entries(root):
            for name in files:
                path = current / name
                relative = path.relative_to(root).as_posix()
                digest.update(relative.encode())
                digest.update(path.read_bytes())
        return digest.hexdigest()

    @classmethod
    def _atomic_copy(cls, source: Path, destination: Path) -> str:
        fingerprint = cls._fingerprint(source)
        destination.parent.mkdir(parents=True, exist_ok=True)
        temp = Path(tempfile.mkdtemp(prefix=f".{destination.name}-", dir=destination.parent))
        backup = destination.parent / f".{destination.name}-previous"
        try:
            shutil.copytree(source, temp / "content", symlinks=False)
            copied = temp / "content"
            if backup.exists():
                shutil.rmtree(backup)
            if destination.exists():
                os.replace(destination, backup)
            os.replace(copied, destination)
            if backup.exists():
                shutil.rmtree(backup)
            return fingerprint
        except Exception:
            if not destination.exists() and backup.exists():
                os.replace(backup, destination)
            raise
        finally:
            shutil.rmtree(temp, ignore_errors=True)

    def _sync_enabled(
        self,
        project_root: Path,
        manifest: dict[str, Any],
        discovered: Mapping[str, SkillDescriptor],
    ) -> None:
        skills_root, _manifest_path, _disabled = self._paths(project_root)
        for skill_id, entry in manifest["entries"].items():
            if not entry.get("enabled"):
                continue
            if entry.get("source") in ("project", "gateway"):
                local = skills_root / str(entry.get("destination") or entry.get("name"))
                if local.is_dir():
                    entry["sync_status"] = SkillSyncStatus.SYNCED.value
                else:
                    entry["sync_status"] = SkillSyncStatus.MISSING.value
                    entry["sync_error"] = "项目本地技能副本不存在"
                continue
            descriptor = discovered.get(skill_id)
            destination = skills_root / str(entry.get("name") or "")
            if descriptor is None or not Path(descriptor.source_path).is_dir():
                entry["sync_status"] = SkillSyncStatus.MISSING.value
                entry["sync_error"] = "技能来源已不存在"
                if destination.is_dir():
                    shutil.rmtree(destination)
                continue
            previous_destination = skills_root / str(
                entry.get("destination") or entry.get("name") or ""
            )
            if not descriptor.valid:
                entry["sync_status"] = SkillSyncStatus.ERROR.value
                entry["sync_error"] = descriptor.error or "技能定义无效"
                for stale in {destination, previous_destination}:
                    if stale.is_dir():
                        shutil.rmtree(stale)
                continue
            try:
                fingerprint = self._fingerprint(Path(descriptor.source_path))
                if fingerprint != entry.get("fingerprint") or not destination.is_dir():
                    fingerprint = self._atomic_copy(Path(descriptor.source_path), destination)
                entry.update(
                    fingerprint=fingerprint,
                    description=descriptor.description,
                    valid=descriptor.valid,
                    error=descriptor.error,
                    sync_status=SkillSyncStatus.SYNCED.value,
                    sync_error=None,
                    destination=descriptor.name,
                )
                if previous_destination != destination and previous_destination.is_dir():
                    shutil.rmtree(previous_destination)
            except Exception as exc:
                entry["sync_status"] = SkillSyncStatus.ERROR.value
                entry["sync_error"] = str(exc)
                if destination.is_dir():
                    shutil.rmtree(destination)

    def _rescan_locked(self, project_root: Path) -> tuple[dict[str, Any], list[SkillDescriptor]]:
        manifest = self._load_manifest(project_root)
        discovered_list = self.discover()
        discovered = {skill.skill_id: skill for skill in discovered_list}
        for skill in discovered_list:
            is_new = skill.skill_id not in manifest["entries"]
            previous = manifest["entries"].get(skill.skill_id, {})
            same_name_enabled = any(
                entry.get("name") == skill.name and entry.get("enabled")
                for other_id, entry in manifest["entries"].items()
                if other_id != skill.skill_id
            )
            enabled = bool(previous.get("enabled", False))
            if is_new and skill.source == "builtin" and not same_name_enabled:
                enabled = True
            manifest["entries"][skill.skill_id] = {
                **previous,
                "name": skill.name,
                "description": skill.description,
                "source": skill.source,
                "source_path": skill.source_path,
                "valid": skill.valid,
                "error": skill.error,
                "ui": skill.ui,
                "enabled": enabled,
                "sync_status": previous.get("sync_status", SkillSyncStatus.DISABLED.value),
            }
        self._sync_enabled(project_root, manifest, discovered)
        self._write_manifest(self._paths(project_root)[1], manifest)
        return manifest, discovered_list

    def list_project(self, project_root: str | Path) -> list[SkillDescriptor]:
        root = Path(project_root).expanduser().resolve()
        with self._lock_for(root):
            manifest, discovered = self._rescan_locked(root)
            visible_ids = {item.skill_id for item in discovered}
            visible_ids.update(
                skill_id
                for skill_id, entry in manifest["entries"].items()
                if entry.get("source") == "project" or entry.get("enabled")
            )
            name_counts: dict[str, int] = {}
            for skill_id in visible_ids:
                name = str(manifest["entries"][skill_id].get("name") or "")
                name_counts[name] = name_counts.get(name, 0) + 1
            skills_root = self._paths(root)[0]
            result = []
            for skill_id in visible_ids:
                entry = manifest["entries"][skill_id]
                status = SkillSyncStatus(entry.get("sync_status", "disabled"))
                enabled = bool(entry.get("enabled")) and status is SkillSyncStatus.SYNCED
                destination = skills_root / str(entry.get("destination") or entry.get("name"))
                result.append(SkillDescriptor(
                    skill_id=skill_id,
                    name=str(entry.get("name") or ""),
                    description=str(entry.get("description") or ""),
                    source=str(entry.get("source") or ""),
                    source_path=str(entry.get("source_path") or ""),
                    valid=bool(entry.get("valid", False)),
                    error=entry.get("error"),
                    enabled=enabled,
                    sync_status=status,
                    sync_error=entry.get("sync_error"),
                    conflict=name_counts.get(str(entry.get("name") or ""), 0) > 1,
                    ui=entry.get("ui") if isinstance(entry.get("ui"), dict) else {},
                    runtime_path=destination if enabled else None,
                ))
            return sorted(result, key=lambda item: (item.name.casefold(), item.source))

    def rescan(self, project_root: str | Path) -> list[SkillDescriptor]:
        return self.list_project(project_root)

    def set_enabled(
        self, project_root: str | Path, skill_id: str, enabled: bool
    ) -> list[SkillDescriptor]:
        root = Path(project_root).expanduser().resolve()
        with self._lock_for(root):
            manifest, discovered_list = self._rescan_locked(root)
            discovered = {item.skill_id: item for item in discovered_list}
            entry = manifest["entries"].get(skill_id)
            if entry is None:
                raise KeyError("未知技能")
            if entry.get("source") == "gateway":
                raise PermissionError("受管技能由 Gateway 管理")
            if enabled and not entry.get("valid"):
                raise ValueError("无效技能不能启用")
            skills_root, manifest_path, disabled_root = self._paths(root)
            name = str(entry.get("name") or "")
            if enabled:
                descriptor = discovered.get(skill_id)
                if entry.get("source") != "project" and descriptor is None:
                    raise ValueError("技能来源已不存在")
                # Prepare the selected version first. Only after a successful
                # copy do we commit the same-name selection change.
                if entry.get("source") != "project":
                    destination = skills_root / name
                    local_variant = next((
                        other
                        for other_id, other in manifest["entries"].items()
                        if other_id != skill_id
                        and other.get("name") == name
                        and other.get("source") == "project"
                        and other.get("enabled")
                    ), None)
                    preserved: Path | None = None
                    if local_variant is not None and destination.is_dir():
                        disabled_root.mkdir(parents=True, exist_ok=True)
                        local_id = next(
                            other_id for other_id, other in manifest["entries"].items()
                            if other is local_variant
                        )
                        preserved = disabled_root / f"{name}-{local_id[:8]}"
                        if preserved.exists():
                            shutil.rmtree(preserved)
                        os.replace(destination, preserved)
                    try:
                        fingerprint = self._atomic_copy(
                            Path(str(entry["source_path"])), destination
                        )
                    except Exception:
                        if preserved is not None and not destination.exists():
                            os.replace(preserved, destination)
                        raise
                    if local_variant is not None and preserved is not None:
                        local_variant["source_path"] = str(preserved.resolve())
                    entry["fingerprint"] = fingerprint
                for other_id, other in manifest["entries"].items():
                    if other_id != skill_id and other.get("name") == name:
                        other["enabled"] = False
                        other["sync_status"] = SkillSyncStatus.DISABLED.value
                entry["enabled"] = True
                entry["destination"] = name
                entry["sync_status"] = SkillSyncStatus.SYNCED.value
                entry["sync_error"] = None
            else:
                entry["enabled"] = False
                entry["sync_status"] = SkillSyncStatus.DISABLED.value
                destination = skills_root / str(entry.get("destination") or name)
                if destination.is_dir():
                    if entry.get("source") == "project":
                        disabled_root.mkdir(parents=True, exist_ok=True)
                        target = disabled_root / f"{name}-{skill_id[:8]}"
                        if target.exists():
                            shutil.rmtree(target)
                        os.replace(destination, target)
                        entry["source_path"] = str(target.resolve())
                    else:
                        shutil.rmtree(destination)
            self._write_manifest(manifest_path, manifest)
        return self.list_project(root)

    def set_enabled_batch(
        self,
        project_root: str | Path,
        skill_ids: list[str],
        enabled: bool,
    ) -> list[SkillDescriptor]:
        """Apply one state to several skills after validating the whole request.

        Enabling same-name variants follows request order, so the last selected
        variant becomes the project's active version.
        """
        root = Path(project_root).expanduser().resolve()
        ordered_ids = list(dict.fromkeys(skill_ids))
        if not ordered_ids:
            raise ValueError("请至少选择一个技能")
        with self._lock_for(root):
            manifest, discovered_list = self._rescan_locked(root)
            discovered = {item.skill_id: item for item in discovered_list}
            for skill_id in ordered_ids:
                entry = manifest["entries"].get(skill_id)
                if entry is None:
                    raise KeyError(f"未知技能：{skill_id}")
                if entry.get("source") == "gateway":
                    raise PermissionError("受管技能由 Gateway 管理")
                if enabled and not entry.get("valid"):
                    raise ValueError(f"无效技能不能启用：{entry.get('name') or skill_id}")
                if (
                    enabled
                    and entry.get("source") != "project"
                    and skill_id not in discovered
                ):
                    raise ValueError(f"技能来源已不存在：{entry.get('name') or skill_id}")
            for skill_id in ordered_ids:
                self.set_enabled(root, skill_id, enabled)
        return self.list_project(root)

    def runtime_selection(self, project_root: str | Path) -> ProjectSkillSelection:
        root = Path(project_root).expanduser().resolve()
        skills = tuple(self.list_project(root))
        return ProjectSkillSelection(
            project_root=root,
            skills=skills,
            enabled=tuple(skill for skill in skills if skill.enabled),
            disabled_source_paths=tuple(
                Path(skill.source_path)
                for skill in skills
                if skill.source != "project" and not skill.enabled and skill.source_path
            ),
        )


skill_center = SkillCenter()
