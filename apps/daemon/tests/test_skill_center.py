from __future__ import annotations

import json
from pathlib import Path

import pytest

from services.skill_center import SkillCenter, SkillSyncStatus
from services.skill_runtime import (
    codex_skills_config,
    deepseek_skill_provider_config,
    prepare_codex_skills,
    prepare_claude_plugin,
    prepare_qoder_plugin,
    write_openclaw_config,
)


def write_skill(root: Path, name: str, description: str = "说明") -> Path:
    root.mkdir(parents=True, exist_ok=True)
    (root / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: {description}\n---\n\n# {name}\n",
        encoding="utf-8",
    )
    return root


@pytest.fixture
def roots(tmp_path: Path) -> dict[str, Path]:
    return {
        "agents": tmp_path / "home" / ".agents" / "skills",
        "claude": tmp_path / "home" / ".claude" / "skills",
        "codex": tmp_path / "home" / ".codex" / "skills",
    }


def test_discovers_recursively_but_stops_at_skill_root(
    tmp_path: Path, roots: dict[str, Path]
) -> None:
    outer = write_skill(roots["agents"] / "group" / "outer", "outer")
    write_skill(outer / "references" / "nested", "nested")
    write_skill(roots["claude"] / "deep" / "standalone", "standalone")

    center = SkillCenter(source_roots=roots)
    skills = center.list_project(tmp_path / "project")

    assert {(skill.name, skill.source) for skill in skills} == {
        ("outer", "agents"),
        ("standalone", "claude"),
    }


def test_invalid_frontmatter_is_visible_but_cannot_be_enabled(
    tmp_path: Path, roots: dict[str, Path]
) -> None:
    invalid = roots["codex"] / "broken"
    invalid.mkdir(parents=True)
    (invalid / "SKILL.md").write_text("# missing frontmatter", encoding="utf-8")
    center = SkillCenter(source_roots=roots)

    descriptor = center.list_project(tmp_path / "project")[0]
    assert descriptor.valid is False
    assert descriptor.error
    with pytest.raises(ValueError, match="无效"):
        center.set_enabled(tmp_path / "project", descriptor.skill_id, True)


def test_skill_id_is_stable_and_source_variants_are_distinct(
    tmp_path: Path, roots: dict[str, Path]
) -> None:
    write_skill(roots["agents"] / "review", "review")
    write_skill(roots["codex"] / "review", "review")
    center = SkillCenter(source_roots=roots)

    first = center.list_project(tmp_path / "project")
    second = center.list_project(tmp_path / "project")

    assert [skill.skill_id for skill in first] == [skill.skill_id for skill in second]
    assert len({skill.skill_id for skill in first}) == 2
    assert all(skill.conflict for skill in first)


def test_enable_syncs_copy_and_switches_same_name_atomically(
    tmp_path: Path, roots: dict[str, Path]
) -> None:
    first_root = write_skill(roots["agents"] / "review", "review", "agents")
    second_root = write_skill(roots["codex"] / "review", "review", "codex")
    project = tmp_path / "project"
    center = SkillCenter(source_roots=roots)
    variants = center.list_project(project)

    first = next(skill for skill in variants if Path(skill.source_path) == first_root)
    second = next(skill for skill in variants if Path(skill.source_path) == second_root)
    center.set_enabled(project, first.skill_id, True)
    center.set_enabled(project, second.skill_id, True)

    current = center.list_project(project)
    assert [skill.skill_id for skill in current if skill.enabled] == [second.skill_id]
    mirrored = project / ".workstep" / "skills" / "review" / "SKILL.md"
    assert "description: codex" in mirrored.read_text(encoding="utf-8")
    manifest = json.loads(
        (project / ".workstep" / "skills" / ".workstep-manifest.json").read_text()
    )
    assert manifest["entries"][second.skill_id]["enabled"] is True
    assert manifest["entries"][first.skill_id]["enabled"] is False


def test_batch_toggle_updates_multiple_skills_and_keeps_same_name_single_select(
    tmp_path: Path, roots: dict[str, Path]
) -> None:
    write_skill(roots["agents"] / "review", "review", "agents")
    write_skill(roots["codex"] / "review", "review", "codex")
    write_skill(roots["claude"] / "research", "research")
    project = tmp_path / "project"
    center = SkillCenter(source_roots=roots)
    skills = center.list_project(project)
    agents_review = next(
        skill for skill in skills if skill.name == "review" and skill.source == "agents"
    )
    codex_review = next(
        skill for skill in skills if skill.name == "review" and skill.source == "codex"
    )
    research = next(skill for skill in skills if skill.name == "research")

    enabled = center.set_enabled_batch(
        project,
        [agents_review.skill_id, research.skill_id, codex_review.skill_id],
        True,
    )

    assert {skill.skill_id for skill in enabled if skill.enabled} == {
        codex_review.skill_id,
        research.skill_id,
    }
    disabled = center.set_enabled_batch(
        project, [codex_review.skill_id, research.skill_id], False
    )
    assert not any(skill.enabled for skill in disabled)


def test_batch_toggle_validates_all_ids_before_changing_anything(
    tmp_path: Path, roots: dict[str, Path]
) -> None:
    write_skill(roots["agents"] / "review", "review")
    project = tmp_path / "project"
    center = SkillCenter(source_roots=roots)
    skill = center.list_project(project)[0]

    with pytest.raises(KeyError, match="未知技能"):
        center.set_enabled_batch(project, [skill.skill_id, "missing"], True)

    assert not center.list_project(project)[0].enabled


def test_source_change_auto_syncs_and_source_missing_fails_closed(
    tmp_path: Path, roots: dict[str, Path]
) -> None:
    source = write_skill(roots["agents"] / "writer", "writer", "v1")
    project = tmp_path / "project"
    center = SkillCenter(source_roots=roots)
    skill = center.list_project(project)[0]
    center.set_enabled(project, skill.skill_id, True)

    (source / "SKILL.md").write_text(
        "---\nname: writer\ndescription: v2\n---\n", encoding="utf-8"
    )
    selection = center.runtime_selection(project)
    assert selection.enabled[0].description == "v2"
    assert "description: v2" in selection.enabled[0].runtime_path.joinpath("SKILL.md").read_text()

    for item in source.iterdir():
        item.unlink()
    source.rmdir()
    selection = center.runtime_selection(project)
    assert selection.enabled == ()
    missing = next(skill for skill in selection.skills if skill.skill_id == skill.skill_id)
    assert missing.sync_status is SkillSyncStatus.MISSING
    assert not (project / ".workstep" / "skills" / "writer").exists()


def test_enabled_skill_becoming_invalid_removes_runtime_copy(
    tmp_path: Path, roots: dict[str, Path]
) -> None:
    source = write_skill(roots["agents"] / "writer", "writer")
    project = tmp_path / "project"
    center = SkillCenter(source_roots=roots)
    skill = center.list_project(project)[0]
    center.set_enabled(project, skill.skill_id, True)

    (source / "SKILL.md").write_text("# invalid", encoding="utf-8")
    selection = center.runtime_selection(project)

    assert selection.enabled == ()
    assert not (project / ".workstep" / "skills" / "writer").exists()


def test_enabled_skill_rename_does_not_leave_old_runtime_directory(
    tmp_path: Path, roots: dict[str, Path]
) -> None:
    source = write_skill(roots["agents"] / "writer", "writer")
    project = tmp_path / "project"
    center = SkillCenter(source_roots=roots)
    skill = center.list_project(project)[0]
    center.set_enabled(project, skill.skill_id, True)

    (source / "SKILL.md").write_text(
        "---\nname: editor\ndescription: renamed\n---\n", encoding="utf-8"
    )
    selection = center.runtime_selection(project)

    assert [item.name for item in selection.enabled] == ["editor"]
    assert not (project / ".workstep" / "skills" / "writer").exists()
    assert (project / ".workstep" / "skills" / "editor").is_dir()


def test_rejects_symlink_that_escapes_skill_root(
    tmp_path: Path, roots: dict[str, Path]
) -> None:
    source = write_skill(roots["agents"] / "unsafe", "unsafe")
    secret = tmp_path / "secret.txt"
    secret.write_text("secret", encoding="utf-8")
    (source / "escape.txt").symlink_to(secret)
    center = SkillCenter(source_roots=roots)
    skill = center.list_project(tmp_path / "project")[0]

    with pytest.raises(ValueError, match="符号链接"):
        center.set_enabled(tmp_path / "project", skill.skill_id, True)


def test_adopts_existing_project_skill_and_disables_recoverably(
    tmp_path: Path, roots: dict[str, Path]
) -> None:
    project = tmp_path / "project"
    write_skill(project / ".workstep" / "skills" / "local", "local")
    center = SkillCenter(source_roots=roots)

    local = center.list_project(project)[0]
    assert local.source == "project"
    assert local.enabled is True
    center.set_enabled(project, local.skill_id, False)

    assert not (project / ".workstep" / "skills" / "local").exists()
    assert any((project / ".workstep" / "skills-disabled").iterdir())


def test_claude_plugin_refresh_handles_overlay_directory_rename(
    tmp_path: Path, roots: dict[str, Path], monkeypatch
) -> None:
    import errno
    import os

    project = tmp_path / "project"
    selection = SkillCenter(source_roots=roots).runtime_selection(project)
    plugin, _ = prepare_claude_plugin(selection)
    (plugin / "stale.txt").write_text("old")
    original_replace = os.replace

    def overlay_replace(source, destination):
        if Path(source) == plugin:
            raise OSError(errno.EXDEV, "Invalid cross-device link")
        return original_replace(source, destination)

    monkeypatch.setattr(os, "replace", overlay_replace)
    refreshed, names = prepare_claude_plugin(selection)
    assert refreshed == plugin
    assert names == []
    assert (plugin / ".claude-plugin" / "plugin.json").is_file()
    assert not (plugin / "stale.txt").exists()
    assert not (plugin.parent / ".claude-plugin-previous").exists()


def test_engine_runtime_projections_only_expose_enabled_skills(
    tmp_path: Path, roots: dict[str, Path]
) -> None:
    write_skill(roots["agents"] / "on", "on")
    write_skill(roots["codex"] / "off", "off")
    project = tmp_path / "project"
    center = SkillCenter(source_roots=roots)
    enabled = next(skill for skill in center.list_project(project) if skill.name == "on")
    center.set_enabled(project, enabled.skill_id, True)
    selection = center.runtime_selection(project)

    codex = codex_skills_config(selection)
    assert str(project / ".workstep" / "skills" / "on" / "SKILL.md") in codex
    assert str(roots["codex"] / "off" / "SKILL.md") in codex
    assert "enabled=false" in codex

    codex_runtime, codex_runtime_config = prepare_codex_skills(selection)
    managed = codex_runtime / "on" / "SKILL.md"
    assert "name: on" in managed.read_text()
    assert str(managed) in codex_runtime_config
    assert str(roots["codex"] / "off" / "SKILL.md") in codex_runtime_config

    claude_plugin, claude_names = prepare_claude_plugin(selection)
    assert (claude_plugin / "skills" / "on" / "SKILL.md").is_file()
    assert not (claude_plugin / "skills" / "off").exists()
    assert claude_names == ["workstep:on"]

    qoder_plugin, qoder_names = prepare_qoder_plugin(selection)
    assert (qoder_plugin / "skills" / "on" / "SKILL.md").is_file()
    assert qoder_names == ["on"]

    deepseek = deepseek_skill_provider_config(selection)
    assert deepseek["includeDefaultRoots"] is False
    assert deepseek["customSkillDirs"] == [str(project / ".workstep" / "skills")]

    openclaw = json.loads(write_openclaw_config(selection).read_text())
    assert openclaw["agents"]["defaults"]["skills"] == ["on"]


def test_codex_runtime_refresh_only_removes_workstep_managed_skills(
    tmp_path: Path, roots: dict[str, Path]
) -> None:
    write_skill(roots["agents"] / "on", "on")
    project = tmp_path / "project"
    personal = write_skill(project / ".agents" / "skills" / "personal", "personal")
    center = SkillCenter(source_roots=roots)
    enabled = next(skill for skill in center.list_project(project) if skill.name == "on")
    center.set_enabled(project, enabled.skill_id, True)

    runtime, _ = prepare_codex_skills(center.runtime_selection(project))
    managed = runtime / "on"
    center.set_enabled(project, enabled.skill_id, False)
    prepare_codex_skills(center.runtime_selection(project))

    assert personal.is_dir()
    assert not managed.exists()


def test_codex_runtime_reuses_unchanged_skill_projection(
    tmp_path: Path, roots: dict[str, Path], monkeypatch
) -> None:
    write_skill(roots["agents"] / "on", "on")
    project = tmp_path / "project"
    center = SkillCenter(source_roots=roots)
    enabled = next(skill for skill in center.list_project(project) if skill.name == "on")
    center.set_enabled(project, enabled.skill_id, True)
    selection = center.runtime_selection(project)
    prepare_codex_skills(selection)

    def unexpected_copy(*_args, **_kwargs):
        raise AssertionError("unchanged Codex skill must not be copied again")

    monkeypatch.setattr("services.skill_runtime._replace_directory", unexpected_copy)
    prepare_codex_skills(selection)


def test_codex_runtime_refreshes_when_file_size_changes(
    tmp_path: Path, roots: dict[str, Path]
) -> None:
    write_skill(roots["agents"] / "on", "on")
    project = tmp_path / "project"
    center = SkillCenter(source_roots=roots)
    enabled = next(skill for skill in center.list_project(project) if skill.name == "on")
    center.set_enabled(project, enabled.skill_id, True)
    selection = center.runtime_selection(project)
    runtime, _ = prepare_codex_skills(selection)

    (selection.enabled[0].runtime_path / "SKILL.md").write_text(
        "---\nname: on\ndescription: changed and longer\n---\n"
    )
    prepare_codex_skills(selection)

    assert "changed and longer" in (runtime / "on" / "SKILL.md").read_text()


def test_codex_runtime_repairs_empty_skill_file(
    tmp_path: Path, roots: dict[str, Path]
) -> None:
    write_skill(roots["agents"] / "on", "on")
    project = tmp_path / "project"
    center = SkillCenter(source_roots=roots)
    enabled = next(skill for skill in center.list_project(project) if skill.name == "on")
    center.set_enabled(project, enabled.skill_id, True)
    selection = center.runtime_selection(project)
    runtime, _ = prepare_codex_skills(selection)
    projected = runtime / "on" / "SKILL.md"
    projected.write_text("")

    prepare_codex_skills(selection)

    assert projected.stat().st_size > 0


def test_plugin_runtimes_reuse_unchanged_skill_projections(
    tmp_path: Path, roots: dict[str, Path], monkeypatch
) -> None:
    write_skill(roots["agents"] / "on", "on")
    project = tmp_path / "project"
    center = SkillCenter(source_roots=roots)
    enabled = next(skill for skill in center.list_project(project) if skill.name == "on")
    center.set_enabled(project, enabled.skill_id, True)
    selection = center.runtime_selection(project)
    prepare_claude_plugin(selection)
    prepare_qoder_plugin(selection)

    def unexpected_rebuild(*_args, **_kwargs):
        raise AssertionError("unchanged engine projection must not be rebuilt")

    monkeypatch.setattr("services.skill_runtime._replace_tree", unexpected_rebuild)
    prepare_claude_plugin(selection)
    prepare_qoder_plugin(selection)


def test_switching_from_project_local_preserves_original_recoverably(
    tmp_path: Path, roots: dict[str, Path]
) -> None:
    project = tmp_path / "project"
    local = write_skill(project / ".workstep" / "skills" / "review", "review", "local")
    write_skill(roots["agents"] / "review", "review", "personal")
    center = SkillCenter(source_roots=roots)
    personal = next(skill for skill in center.list_project(project) if skill.source == "agents")

    center.set_enabled(project, personal.skill_id, True)

    assert "description: personal" in (local / "SKILL.md").read_text()
    disabled = list((project / ".workstep" / "skills-disabled").glob("review-*"))
    assert len(disabled) == 1
    assert "description: local" in (disabled[0] / "SKILL.md").read_text()


@pytest.mark.parametrize("enabled", [True, False])
def test_builtin_relocation_migrates_legacy_selection(tmp_path: Path, enabled: bool) -> None:
    old = write_skill(tmp_path / "old-package" / "review", "review", "old")
    current = write_skill(tmp_path / "new-package" / "review", "review", "new")
    project = tmp_path / "project"
    center = SkillCenter(source_roots={"builtin": current.parent})
    manifest_path = center._paths(project)[1]
    legacy_id = center._skill_id(old)
    center._write_manifest(manifest_path, {"version": 1, "entries": {
        legacy_id: {"name": "review", "source": "builtin", "source_path": str(tmp_path / "removed-package" / "review"),
                    "enabled": enabled, "valid": True, "sync_status": "synced"},
    }})
    skills = center.list_project(project)
    assert len(skills) == 1
    assert skills[0].source_path == str(current)
    assert skills[0].enabled is enabled
    assert skills[0].skill_id != legacy_id
    relocated = SkillCenter(source_roots={"builtin": old.parent}).list_project(project)
    assert relocated[0].skill_id == skills[0].skill_id
    assert relocated[0].enabled is enabled


def test_builtin_migration_preserves_personal_selection(tmp_path: Path) -> None:
    builtin = write_skill(tmp_path / "bundle" / "review", "review")
    personal = write_skill(tmp_path / "personal" / "review", "review")
    center = SkillCenter(source_roots={"builtin": builtin.parent, "agents": personal.parent})
    project = tmp_path / "project"
    center._write_manifest(center._paths(project)[1], {"version": 1, "entries": {
        "old-builtin": {"name": "review", "source": "builtin", "source_path": "/missing/review",
                        "enabled": True, "valid": True, "sync_status": "missing"},
        center._skill_id(personal): {"name": "review", "source": "agents", "source_path": str(personal),
                                    "enabled": True, "valid": True, "sync_status": "synced"},
    }})
    skills = center.list_project(project)
    assert len(skills) == 2
    assert [skill.source for skill in skills if skill.enabled] == ["agents"]


def test_builtin_stable_choice_wins_over_duplicate_legacy_records(tmp_path: Path) -> None:
    builtin = write_skill(tmp_path / "bundle" / "review", "review")
    center = SkillCenter(source_roots={"builtin": builtin.parent})
    project = tmp_path / "project"
    skill = center.list_project(project)[0]
    center.set_enabled(project, skill.skill_id, False)
    manifest_path = center._paths(project)[1]
    manifest = json.loads(manifest_path.read_text())
    for key in ("old-package", "another-package"):
        manifest["entries"][key] = {
            "name": "review", "source": "builtin", "source_path": f"/missing/{key}/review",
            "enabled": True, "valid": True, "sync_status": "missing",
        }
    center._write_manifest(manifest_path, manifest)
    skills = center.list_project(project)
    assert len(skills) == 1
    assert skills[0].enabled is False
    assert skills[0].conflict is False
    assert set(json.loads(manifest_path.read_text())["entries"]) == {skill.skill_id}
