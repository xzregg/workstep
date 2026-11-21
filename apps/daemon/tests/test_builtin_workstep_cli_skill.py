from pathlib import Path
import re

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
    assert "quick buttons" in text.split("---", 2)[1]
    assert len(text) < 3200
    assert len(text.split('description:',1)[1].split('\n',1)[0]) < 260
    references = re.findall(r"\]\((references/[^)]+)\)", text)
    assert len(set(references)) >= 8
    for reference in references:
        source = BUILTIN_SKILLS / "workstep-cli" / reference
        assert (mirrored.parent / reference).read_text() == source.read_text()
    text += "\n" + "\n".join(
        path.read_text() for path in sorted((mirrored.parent / "references").glob("*.md"))
    )
    assert "--fields" in text
    assert "--limit" in text
    assert "--offset" in text
    assert "python -m cli workflow list" in text
    assert "python -m cli workflow get" in text
    assert "python -m cli workflow action-create" in text
    assert "--overwrite" in text
    assert "--input-prompt" in text
    assert "WORKSTEP_ACTION_INPUT" in text
    assert "python -m cli message send --project <project_id> --session <session_id> --content" in text
    assert "workstep_send_message" in text
    assert "python -m cli session archive --project <project_id> --session <session_id> --json" in text
    assert "workstep_archive_chat_session" in text
    assert "python -m cli project action-create" in text
    assert "python -m cli project quick-buttons" in text
    assert "python -m cli workflow quick-buttons" in text
    assert "python -m cli task create" in text
    for action in ("step-message", "step-stop", "step-start"):
        assert f"python -m cli task {action}" in text
    for operation in ("workstep_send_step_message", "workstep_stop_step", "workstep_start_step"):
        assert operation in text
    assert "--reset-session" in text
    assert "queued does not mean delivered" in text
    assert "<project>/.workstep/artifacts/<workflow_id>/<task_id>/.worktrees/<alias>/" in text
    assert "<project>/.workstep/worktrees/<task_id>/" not in text
    assert "--workflow" in text
    assert "python -m cli channel list" in text
    assert "python -m cli channel sessions" in text
    assert "python -m cli channel send" in text
    assert "python -m cli channel bind" in text
    assert "workstep_bind_channel_group" in text
    assert "python -m cli channel unbind" in text
    assert "workstep_unbind_channel_group" in text
    assert "--image" in text
    assert "--file" in text
    assert "workstep_upload_channel_attachment" in text
    assert "workstep_send_channel_message" in text
    assert "Send only when explicitly requested" in text
    assert "python -m cli schedule create" in text
    assert "--mode agent" in text
    assert "--target session --session <session_id>" in text
    assert "--idempotency-key <request_key>" in text
    assert "--after 2h" in text
    assert "context get --json" in text
    assert "WORKSTEP_PROJECT_ID" in text
    assert "WORKSTEP_SESSION_ID" in text
    assert "[WorkStep conversation context]" not in text
    assert "WORKSTEP_CLI_PYTHON" in text
    assert "WORKSTEP_DAEMON_DIR" in text
    assert "uv run --no-sync --directory apps/daemon python -m cli" in text
    assert 'uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli' in text
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
    assert text.index("uv run --no-sync --directory apps/daemon") < text.index(
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


def test_memory_cli_skill_documents_environment_and_parseable_commands():
    import shlex
    from cli import build_parser
    root = BUILTIN_SKILLS / 'workstep-cli'
    skill = (root / 'SKILL.md').read_text()
    assert 'references/memory.md' in skill
    description=skill.split('description:',1)[1].split('\n',1)[0]
    assert 'historical memories, user preferences and reusable experience' in description
    assert 'Decide whether retrieval is needed' in description
    transport = (root / 'references/transport.md').read_text()
    assert 'at startup' in transport and 'daemon interpreter' in transport
    assert "current project's virtualenv" in transport
    assert 'missing environment variables' in transport
    assert 'Normal queries do not require a current conversation' in (root / 'references/memory.md').read_text()
    commands = re.findall(r'^uv run .*python -m cli (memory .+)$', (root / 'references/memory.md').read_text(), re.M)
    assert len(commands) >= 3
    for command in commands:
        parsed = build_parser().parse_args(shlex.split(command))
        assert not parsed.verbose and not parsed.json
        assert not hasattr(parsed,'memory_token')
    reference = (root / 'references/memory.md').read_text()
    assert '--verbose' in reference and 'source_ids' in reference
    assert 'same compact fields' in reference
    assert 'For overviews, omit `--with-sources`' in reference
    assert 'do not expand every result' in reference
    assert 'sufficient to answer' in reference
    assert 'memory search --period ... --with-sources --json' not in reference


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


def test_digital_person_skill_exposes_manual_reflection():
    from cli import build_parser
    root = BUILTIN_SKILLS / 'workstep-cli'
    assert 'references/digital-person.md' in (root / 'SKILL.md').read_text()
    reference = (root / 'references/digital-person.md').read_text()
    assert 'workstep_check_digital_person' in reference
    assert 'no_work' in reference
    assert 'explicitly asks' in reference
    assert 'failed' in reference
    assert build_parser().parse_args(['digital-person', 'check', '--json']).subcommand == 'check'


def test_custom_engine_guides_have_valid_links_commands_and_runtime_mirrors(tmp_path):
    import shlex
    from cli import build_parser

    root = BUILTIN_SKILLS / "workstep-cli"
    project = tmp_path / "project"
    SkillCenter(source_roots={"builtin": BUILTIN_SKILLS}).runtime_selection(project)
    mirrored = project / ".workstep" / "skills" / "workstep-cli"
    documents = ["custom-engine.md", "custom-engine-contract.md", "custom-engine-testing.md"]
    for name in documents:
        source = root / "references" / name
        assert source.is_file()
        text = source.read_text()
        assert (mirrored / "references" / name).read_text() == text
        for target in re.findall(r"\]\(([^)]+\.md(?:#[^)]+)?)\)", text):
            if "://" in target:
                continue
            filename, _, anchor = target.partition("#")
            linked = source.parent / filename
            assert linked.is_file(), target
            if anchor:
                headings = re.findall(r"^#{1,6} (.+)$", linked.read_text(), re.M)
                anchors = {re.sub(r"[^\w -]", "", h.lower()).replace(" ", "-") for h in headings}
                assert anchor in anchors, target

    flow = (root / "references" / "custom-engine.md").read_text()
    commands = re.findall(r"^workstep engine .+$", flow, re.M)
    actions = set()
    for command in commands:
        args = build_parser().parse_args(shlex.split(command)[1:])
        actions.add(args.subcommand)
    assert {"inspect", "install", "configure", "validate", "register"} <= actions
