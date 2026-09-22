"""Engine-specific projections of a SkillCenter project whitelist."""

from __future__ import annotations

import errno
import json
import os
import shutil
import tempfile
from pathlib import Path

from services.skill_center import ProjectSkillSelection


def codex_skills_config(selection: ProjectSkillSelection) -> str:
    entries: list[dict[str, object]] = []
    for skill in selection.enabled:
        if skill.runtime_path:
            entries.append({"path": str(skill.runtime_path / "SKILL.md"), "enabled": True})
    for path in selection.disabled_source_paths:
        entries.append({"path": str(path / "SKILL.md"), "enabled": False})
    values = ",".join(
        "{path=" + json.dumps(str(item["path"])) + ",enabled="
        + ("true" if item["enabled"] else "false") + "}"
        for item in entries
    )
    return f"skills.config=[{values}]"


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


def prepare_claude_plugin(selection: ProjectSkillSelection) -> tuple[Path, list[str]]:
    plugin = selection.project_root / ".workstep" / "runtime" / "claude-plugin"
    sources = [
        (f"skills/{skill.name}", skill.runtime_path)
        for skill in selection.enabled
        if skill.runtime_path
    ]
    _replace_tree(sources, plugin)
    manifest_dir = plugin / ".claude-plugin"
    manifest_dir.mkdir(parents=True, exist_ok=True)
    (manifest_dir / "plugin.json").write_text(
        json.dumps({"name": "workstep", "version": "1.0.0"}, indent=2) + "\n",
        encoding="utf-8",
    )
    return plugin, [f"workstep:{skill.name}" for skill in selection.enabled]


def prepare_qoder_plugin(selection: ProjectSkillSelection) -> tuple[Path, list[str]]:
    plugin = selection.project_root / ".workstep" / "runtime" / "qoder-plugin"
    sources = [
        (f"skills/{skill.name}", skill.runtime_path)
        for skill in selection.enabled
        if skill.runtime_path
    ]
    _replace_tree(sources, plugin)
    manifest_dir = plugin / ".qoder-plugin"
    manifest_dir.mkdir(parents=True, exist_ok=True)
    (manifest_dir / "plugin.json").write_text(
        json.dumps({"name": "workstep", "version": "1.0.0"}, indent=2) + "\n",
        encoding="utf-8",
    )
    return plugin, [skill.name for skill in selection.enabled]


def prepare_hermes_home(
    selection: ProjectSkillSelection,
    project_id: str,
    *,
    source_home: Path | None = None,
    runtime_root: Path | None = None,
) -> Path:
    runtime_root = runtime_root or (Path.home() / ".workstep" / "runtime" / "skills" / "hermes")
    home = runtime_root / project_id
    sources = [
        (f"skills/{skill.name}", skill.runtime_path)
        for skill in selection.enabled
        if skill.runtime_path
    ]
    _replace_tree(sources, home)
    home.chmod(0o700)
    source_home = source_home or (Path.home() / ".hermes")
    auth = source_home / "auth.json"
    if auth.is_file():
        shutil.copy2(auth, home / "auth.json")
        (home / "auth.json").chmod(0o600)
    config = source_home / "config.yaml"
    if config.is_file():
        try:
            import yaml

            payload = yaml.safe_load(config.read_text(encoding="utf-8")) or {}
            if not isinstance(payload, dict):
                payload = {}
            skill_config = payload.get("skills")
            if not isinstance(skill_config, dict):
                skill_config = {}
            skill_config["external_dirs"] = []
            payload["skills"] = skill_config
            derived = home / "config.yaml"
            derived.write_text(
                yaml.safe_dump(payload, allow_unicode=True, sort_keys=False),
                encoding="utf-8",
            )
            derived.chmod(0o600)
        except (OSError, ValueError, TypeError):
            # Authentication remains available, but a malformed user config is
            # never copied into the isolated runtime.
            pass
    return home


def write_openclaw_config(selection: ProjectSkillSelection) -> Path:
    runtime = selection.project_root / ".workstep" / "runtime" / "openclaw"
    runtime.mkdir(parents=True, exist_ok=True)
    path = runtime / "openclaw.json"
    path.write_text(json.dumps({
        "skills": {"load": {"extraDirs": [str(selection.project_root / ".workstep" / "skills")]}},
        "agents": {"defaults": {"skills": [skill.name for skill in selection.enabled]}},
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
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
    target.write_text(text.replace(marker, replacement, 1), encoding="utf-8")
    return target
