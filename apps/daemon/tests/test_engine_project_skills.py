import pytest

from engines.claude_code import ClaudeCodeEngine
from engines.codex import CodexEngine
from engines.openclaw import OpenClawEngine


def _skill(root, directory: str, name: str, description: str) -> None:
    skill_dir = root / directory / name
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: {description}\n---\n",
        encoding="utf-8",
    )


@pytest.mark.asyncio
async def test_engine_inspection_only_lists_its_project_skills(tmp_path):
    _skill(tmp_path, ".agents/skills", "research", "Research the codebase")
    _skill(tmp_path, ".codex/skills", "deploy", "Deploy the app")
    _skill(tmp_path, ".claude/skills", "review", "Review the change")
    _skill(tmp_path, ".workstep/skills", "shared", "Shared workflow skill")

    codex = await CodexEngine().inspect_capabilities(str(tmp_path))
    claude = await ClaudeCodeEngine().inspect_capabilities(str(tmp_path))

    # Inspection reports the SkillCenter whitelist, not each engine's native
    # project discovery roots. Existing .workstep skills are adopted enabled.
    assert {skill["name"] for skill in codex["skills"]} == {"shared"}
    assert {skill["name"] for skill in claude["skills"]} == {"shared"}


@pytest.mark.asyncio
async def test_engine_inspection_returns_engine_owned_input_items(tmp_path):
    _skill(tmp_path, ".codex/skills", "deploy", "Deploy the app")
    _skill(tmp_path, ".claude/skills", "review", "Review the change")
    _skill(tmp_path, ".workstep/skills", "shared", "Shared workflow skill")

    codex = await CodexEngine().inspect_capabilities(str(tmp_path))
    claude = await ClaudeCodeEngine().inspect_capabilities(str(tmp_path))
    openclaw = await OpenClawEngine().inspect_capabilities(str(tmp_path))

    assert [item["name"] for item in codex["input_items"][:4]] == [
        "goal", "plan", "reasoning", "status",
    ]
    assert codex["input_items"][0] == {
        "kind": "command",
        "name": "goal",
        "description": "设置或更新当前目标",
        "insert_text": "/goal ",
        "action": "prompt",
    }
    assert next(item for item in codex["input_items"] if item["name"] == "shared")["insert_text"] == "$shared "
    assert [item["name"] for item in claude["input_items"][:4]] == [
        "goal", "plan", "reasoning", "status",
    ]
    assert next(item for item in claude["input_items"] if item["name"] == "shared")["insert_text"] == "/shared "
    assert [item["name"] for item in openclaw["input_items"]] == [
        "goal", "plan", "reasoning", "status", "shared",
    ]


@pytest.mark.asyncio
async def test_engine_inspection_without_skills_returns_empty_lists(tmp_path):
    result = await OpenClawEngine().inspect_capabilities(str(tmp_path))

    assert result["skills"] == []
    assert [item["name"] for item in result["input_items"]] == [
        "goal", "plan", "reasoning", "status",
    ]
