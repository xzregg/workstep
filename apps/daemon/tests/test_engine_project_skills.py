import pytest

from engines.claude_code import ClaudeCodeEngine
from engines.codex import CodexEngine
from engines.openclaw import OpenClawEngine
from engines.pydantic_ai.engine import PydanticAIEngine
from engines.deepseek_harness import DeepSeekHarnessEngine


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
    assert {skill["name"] for skill in codex["skills"]} == {"shared", "workstep-cli"}
    assert {skill["name"] for skill in claude["skills"]} == {"shared", "workstep-cli"}


@pytest.mark.asyncio
async def test_engine_inspection_returns_engine_owned_input_items(tmp_path):
    _skill(tmp_path, ".codex/skills", "deploy", "Deploy the app")
    _skill(tmp_path, ".claude/skills", "review", "Review the change")
    _skill(tmp_path, ".workstep/skills", "shared", "Shared workflow skill")

    codex = await CodexEngine().inspect_capabilities(str(tmp_path))
    claude = await ClaudeCodeEngine().inspect_capabilities(str(tmp_path))
    openclaw = await OpenClawEngine().inspect_capabilities(str(tmp_path))

    assert [item["name"] for item in codex["input_items"][:4]] == [
        "plan", "reasoning", "status", "compact",
    ]
    assert codex["input_items"][0] == {
        "kind": "command",
        "name": "plan",
        "description": "切换计划模式",
        "insert_text": "/plan",
        "action": "toggle_plan",
    }
    assert codex["input_items"][3] == {
        "kind": "command",
        "name": "compact",
        "description": "压缩当前会话上下文",
        "insert_text": "/compact",
        "action": "prompt",
    }
    assert next(item for item in codex["input_items"] if item["name"] == "shared")["insert_text"] == "$shared "
    assert next(item for item in codex["input_items"] if item["name"] == "workstep-cli")["insert_text"] == "$workstep-cli "
    assert [item["name"] for item in claude["input_items"][:4]] == [
        "plan", "reasoning", "status", "compact",
    ]
    assert next(item for item in claude["input_items"] if item["name"] == "shared")["insert_text"] == "/shared "
    assert next(item for item in claude["input_items"] if item["name"] == "workstep-cli")["insert_text"] == "/workstep-cli "
    assert [item["name"] for item in openclaw["input_items"]] == [
        "plan", "reasoning", "status", "shared", "workstep-cli",
    ]


@pytest.mark.asyncio
async def test_engine_inspection_without_project_skills_returns_builtin_skill(tmp_path):
    result = await OpenClawEngine().inspect_capabilities(str(tmp_path))

    assert [item["name"] for item in result["skills"]] == ["workstep-cli"]
    assert [item["name"] for item in result["input_items"]] == [
        "plan", "reasoning", "status", "workstep-cli",
    ]


def test_engine_without_manual_compaction_does_not_advertise_compact():
    for engine in (PydanticAIEngine(), DeepSeekHarnessEngine()):
        assert "compact" not in {
            item["name"] for item in engine.input_commands()
        }
