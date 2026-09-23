from pathlib import Path

from services.skill_center import SkillCenter


BUILTIN_SKILLS = Path(__file__).parent.parent / "data" / "skills"


def test_builtin_workstep_cli_skill_is_enabled_and_mirrored_by_default(tmp_path):
    project = tmp_path / "project"
    center = SkillCenter(source_roots={"builtin": BUILTIN_SKILLS})

    selection = center.runtime_selection(project)

    skill = next(item for item in selection.skills if item.name == "workstep-cli")
    assert skill.source == "builtin"
    assert skill.enabled is True
    assert skill in selection.enabled
    mirrored = project / ".workstep" / "skills" / "workstep-cli" / "SKILL.md"
    assert mirrored.is_file()
    text = mirrored.read_text(encoding="utf-8")
    assert "python -m cli workflow list" in text
    assert "python -m cli workflow get" in text
    assert "python -m cli task create" in text
    assert "--workflow" in text
    assert "python -m cli schedule create" in text
    assert "--mode agent" in text
    assert "WORKSTEP_CLI_PYTHON" in text
    assert "WORKSTEP_DAEMON_DIR" in text
    assert "uv run --directory apps/daemon python -m cli" in text
    assert 'uv run --directory "$WORKSTEP_DAEMON_DIR" python -m cli' in text
    assert "Do not probe the shell with `echo`, `pwd`, or" in text
    assert "`which`; restricted engines" in text
    assert "The CLI is the supported HTTP adapter" in text
    assert "Do not inspect `cli.py`," in text
    assert "`settings.py`, or the daemon source" in text
    assert "Do not construct daemon HTTP requests directly" in text
    assert "## First-run improvement" in text
    assert "data/skills/workstep-cli/SKILL.md" in text
    assert "Never edit generated copies under `.agents/skills`" in text
    assert "Never persist temporary tokens," in text
    assert "ports, resource IDs" in text
    assert text.index("uv run --directory apps/daemon") < text.index(
        "When the `workstep` executable is already known"
    )


def test_disabled_builtin_workstep_cli_skill_stays_disabled(tmp_path):
    project = tmp_path / "project"
    center = SkillCenter(source_roots={"builtin": BUILTIN_SKILLS})
    skill = next(
        item for item in center.list_project(project)
        if item.name == "workstep-cli"
    )

    center.set_enabled(project, skill.skill_id, False)
    selection = center.runtime_selection(project)

    assert not any(item.name == "workstep-cli" for item in selection.enabled)
    assert not (project / ".workstep" / "skills" / "workstep-cli").exists()


def test_project_local_workstep_cli_skill_wins_over_new_builtin(tmp_path):
    project = tmp_path / "project"
    local = project / ".workstep" / "skills" / "workstep-cli"
    local.mkdir(parents=True)
    local.joinpath("SKILL.md").write_text(
        "---\nname: workstep-cli\ndescription: Local override\n---\nlocal\n",
        encoding="utf-8",
    )
    center = SkillCenter(source_roots={"builtin": BUILTIN_SKILLS})

    selection = center.runtime_selection(project)

    enabled = [item for item in selection.enabled if item.name == "workstep-cli"]
    assert len(enabled) == 1
    assert enabled[0].source == "project"
    assert local.joinpath("SKILL.md").read_text(encoding="utf-8").endswith("local\n")
