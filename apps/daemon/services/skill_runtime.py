"""Engine-specific projections of a SkillCenter project whitelist."""

from __future__ import annotations

import errno
import json
import os
import shutil
import tempfile
from pathlib import Path

from services.skill_center import ProjectSkillSelection


def _projection_source(skill) -> Path | None:
    if skill.source == "builtin":
        bundled = Path(skill.source_path)
        if bundled.is_dir():
            return bundled
    return skill.runtime_path


def codex_skills_config(
    selection: ProjectSkillSelection,
    *,
    enabled_paths: list[Path] | None = None,
) -> str:
    entries: list[dict[str, object]] = []
    if enabled_paths is None:
        enabled_paths = [
            skill.runtime_path / "SKILL.md"
            for skill in selection.enabled
            if skill.runtime_path
        ]
    for path in enabled_paths:
        entries.append({"path": str(path), "enabled": True})
    for path in selection.disabled_source_paths:
        entries.append({"path": str(path / "SKILL.md"), "enabled": False})
    values = ",".join(
        "{path=" + json.dumps(str(item["path"])) + ",enabled="
        + ("true" if item["enabled"] else "false") + "}"
        for item in entries
    )
    return f"skills.config=[{values}]"


def _replace_directory(source: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    temp_root = Path(tempfile.mkdtemp(prefix=f".{target.name}-", dir=target.parent))
    staged = temp_root / target.name
    backup = target.parent / f".{target.name}-previous"
    try:
        shutil.copytree(source, staged, symlinks=False)
        if backup.exists():
            shutil.rmtree(backup)
        if target.exists():
            os.replace(target, backup)
        os.replace(staged, target)
        if backup.exists():
            shutil.rmtree(backup)
    except Exception:
        if not target.exists() and backup.exists():
            os.replace(backup, target)
        raise
    finally:
        shutil.rmtree(temp_root, ignore_errors=True)


def _file_sizes(root: Path, *, ignored: set[str] | None = None) -> dict[str, int]:
    ignored = ignored or set()
    sizes: dict[str, int] = {}
    for current, dirs, files in os.walk(root, followlinks=False):
        dirs.sort()
        files.sort()
        current_path = Path(current)
        for name in files:
            path = current_path / name
            relative = path.relative_to(root).as_posix()
            if relative not in ignored:
                sizes[relative] = path.stat().st_size
    return sizes


def _same_directory_sizes(
    source: Path, target: Path, *, ignored_target: set[str] | None = None
) -> bool:
    skill_file = target / "SKILL.md"
    return (
        target.is_dir()
        and skill_file.is_file()
        and skill_file.stat().st_size > 0
        and _file_sizes(source) == _file_sizes(target, ignored=ignored_target)
    )


def prepare_codex_skills(selection: ProjectSkillSelection) -> tuple[Path, str]:
    """Materialize enabled skills in a directory Codex actually discovers.

    ``skills.config`` only enables or disables skills already found by Codex; it
    is not an additional search-path setting.  Keep WorkStep's canonical mirror
    under ``.workstep`` and copy its enabled projection into project-local
    ``.agents/skills`` for cross-platform discovery.
    """
    skills_root = selection.project_root / ".agents" / "skills"
    skills_root.mkdir(parents=True, exist_ok=True)
    state_dir = selection.project_root / ".workstep" / "runtime" / "codex"
    state_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = state_dir / "managed-skills.json"
    try:
        previous = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        previous = {"directories": []}

    managed: list[str] = []
    enabled_paths: list[Path] = []
    for skill in selection.enabled:
        source = _projection_source(skill)
        if not source:
            continue
        directory = skill.name
        destination = skills_root / directory
        marker = destination / ".workstep-managed"
        if destination.exists() and not marker.is_file():
            raise ValueError(f"Codex 技能目录已存在且不属于 WorkStep：{destination}")
        if not _same_directory_sizes(
            source, destination, ignored_target={".workstep-managed"}
        ):
            _replace_directory(source, destination)
            marker.write_text(
                json.dumps({"skill_id": skill.skill_id}),
                encoding="utf-8",
            )
        managed.append(directory)
        enabled_paths.append(destination / "SKILL.md")

    for directory in previous.get("directories", []):
        if not isinstance(directory, str) or directory in managed:
            continue
        stale = skills_root / directory
        marker = stale / ".workstep-managed"
        if marker.is_file():
            shutil.rmtree(stale)

    manifest_text = json.dumps(
        {"directories": managed}, ensure_ascii=False, indent=2
    ) + "\n"
    if not manifest_path.is_file() or manifest_path.read_text(encoding="utf-8") != manifest_text:
        manifest_path.write_text(manifest_text, encoding="utf-8")
    return skills_root, codex_skills_config(selection, enabled_paths=enabled_paths)


def _replace_tree(source_dirs: list[tuple[str, Path]], target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = Path(tempfile.mkdtemp(prefix=f".{target.name}-", dir=target.parent))
    backup = target.parent / f".{target.name}-previous"
    try:
        for name, source in source_dirs:
            destination = temp / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(source, destination, symlinks=False)
        if backup.exists():
            shutil.rmtree(backup)
        if target.exists():
            try:
                os.replace(target, backup)
            except OSError as exc:
                if exc.errno != errno.EXDEV:
                    raise
                # OverlayFS can reject renaming a directory from an image layer.
                # Copy before removing it so the existing rollback stays usable.
                shutil.copytree(target, backup, symlinks=True)
                shutil.rmtree(target)
        os.replace(temp, target)
        if backup.exists():
            shutil.rmtree(backup)
    except Exception:
        if not target.exists() and backup.exists():
            os.replace(backup, target)
        raise
    finally:
        if temp.exists():
            shutil.rmtree(temp, ignore_errors=True)


def _projection_sizes(source_dirs: list[tuple[str, Path]]) -> dict[str, int]:
    sizes: dict[str, int] = {}
    for destination, source in source_dirs:
        for relative, size in _file_sizes(source).items():
            sizes[f"{destination}/{relative}"] = size
    return sizes


def _replace_tree_if_sizes_changed(
    source_dirs: list[tuple[str, Path]],
    target: Path,
    *,
    ignored_roots: set[str] | None = None,
) -> bool:
    ignored_roots = ignored_roots or set()
    actual = {
        relative: size
        for relative, size in _file_sizes(target).items()
        if not any(
            relative == root or relative.startswith(f"{root}/")
            for root in ignored_roots
        )
    } if target.is_dir() else {}
    expected = _projection_sizes(source_dirs)
    required_skills = [target / destination / "SKILL.md" for destination, _ in source_dirs]
    if (
        actual == expected
        and all(path.is_file() and path.stat().st_size > 0 for path in required_skills)
    ):
        return False
    _replace_tree(source_dirs, target)
    return True


def _write_text_if_changed(path: Path, content: str) -> None:
    if path.is_file() and path.stat().st_size == len(content.encode("utf-8")):
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def prepare_claude_plugin(selection: ProjectSkillSelection) -> tuple[Path, list[str]]:
    plugin = selection.project_root / ".workstep" / "runtime" / "claude-plugin"
    sources = [
        (f"skills/{skill.name}", source)
        for skill in selection.enabled
        if (source := _projection_source(skill))
    ]
    _replace_tree_if_sizes_changed(sources, plugin, ignored_roots={".claude-plugin"})
    manifest_dir = plugin / ".claude-plugin"
    manifest_dir.mkdir(parents=True, exist_ok=True)
    _write_text_if_changed(
        manifest_dir / "plugin.json",
        json.dumps({"name": "workstep", "version": "1.0.0"}, indent=2) + "\n",
    )
    return plugin, [f"workstep:{skill.name}" for skill in selection.enabled]


def prepare_qoder_plugin(selection: ProjectSkillSelection) -> tuple[Path, list[str]]:
    plugin = selection.project_root / ".workstep" / "runtime" / "qoder-plugin"
    sources = [
        (f"skills/{skill.name}", source)
        for skill in selection.enabled
        if (source := _projection_source(skill))
    ]
    _replace_tree_if_sizes_changed(sources, plugin, ignored_roots={".qoder-plugin"})
    manifest_dir = plugin / ".qoder-plugin"
    manifest_dir.mkdir(parents=True, exist_ok=True)
    _write_text_if_changed(
        manifest_dir / "plugin.json",
        json.dumps({"name": "workstep", "version": "1.0.0"}, indent=2) + "\n",
    )
    return plugin, [skill.name for skill in selection.enabled]


def write_openclaw_config(selection: ProjectSkillSelection) -> Path:
    runtime = selection.project_root / ".workstep" / "runtime" / "openclaw"
    runtime.mkdir(parents=True, exist_ok=True)
    path = runtime / "openclaw.json"
    content = json.dumps({
        "skills": {"load": {"extraDirs": [str(selection.project_root / ".workstep" / "skills")]}},
        "agents": {"defaults": {"skills": [skill.name for skill in selection.enabled]}},
    }, ensure_ascii=False, indent=2) + "\n"
    _write_text_if_changed(path, content)
    return path


def deepseek_skill_provider_config(selection: ProjectSkillSelection) -> dict:
    return {
        "includeDefaultRoots": False,
        "customSkillDirs": [str(selection.project_root / ".workstep" / "skills")],
    }


def prepare_deepseek_composition(
    selection: ProjectSkillSelection, base_composition: Path
) -> Path:
    """Derive a project-local Cordis composition with default roots disabled."""
    runtime = selection.project_root / ".workstep" / "runtime" / "deepseek"
    runtime.mkdir(parents=True, exist_ok=True)
    target = runtime / "controlled-skills.cordis.yml"
    text = base_composition.read_text(encoding="utf-8")
    marker = "    workspaceContext:\n      maxBytes: 65536\n"
    config = deepseek_skill_provider_config(selection)
    replacement = marker + (
        "    skillFilesystem:\n"
        "      includeDefaultRoots: false\n"
        f"      customSkillDirs: [{json.dumps(config['customSkillDirs'][0])}]\n"
    )
    if marker not in text:
        raise ValueError("DeepSeek Harness composition lacks agent-spine config seam")
    _write_text_if_changed(target, text.replace(marker, replacement, 1))
    return target


def prepare_deepseek_patch(
    selection: ProjectSkillSelection, base_patch: Path
) -> Path:
    """Derive a project-local Cordis patch for the ``sdk`` profile (SDK >= 0.1.5).

    The new-generation runtime no longer accepts a full composition file
    (``DSH_CORDIS_CONFIG`` was removed); WorkStep instead layers a patch list
    above the profile's base tree, overriding the ``skill-filesystem`` entry
    so the harness only loads WorkStep-controlled project skills.
    """
    runtime = selection.project_root / ".workstep" / "runtime" / "deepseek"
    runtime.mkdir(parents=True, exist_ok=True)
    target = runtime / "controlled-skills.workstep-patch.yml"
    text = base_patch.read_text(encoding="utf-8")
    marker = "<WORKSTEP_SKILL_DIRS>"
    if marker not in text:
        raise ValueError("DeepSeek Harness patch lacks skill dirs seam")
    dirs = json.dumps(deepseek_skill_provider_config(selection)["customSkillDirs"][0])
    _write_text_if_changed(target, text.replace(marker, dirs, 1))
    return target
