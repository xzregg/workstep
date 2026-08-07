"""Tests for pydantic_ai_harness and PydanticAIEngine's agents.md / skills / code tools."""

from pathlib import Path

import pytest

from pydantic_ai_harness import FileSystem, Memory, Skills
from engines.pydantic_ai import PydanticAIEngine


# --- FileSystem ---


def test_fs_write_read_list_roundtrip(tmp_path):
    fs = FileSystem([tmp_path])
    result = fs.write("src/main.py", "print('hi')\n")
    assert "src/main.py" in result
    assert fs.read("src/main.py") == "print('hi')"
    assert fs.list_files(".", recursive=True) == ["src/main.py"]
    assert fs.read("src/main.py", start_line=1, end_line=1) == "print('hi')"


def test_fs_rejects_paths_outside_roots(tmp_path, tmp_path_factory):
    outside = tmp_path_factory.mktemp("outside")
    fs = FileSystem([tmp_path])
    with pytest.raises(ValueError):
        fs.resolve("../outside.txt")
    with pytest.raises(ValueError):
        fs.read(str(outside / "x.txt"))
    with pytest.raises(ValueError):
        fs.write(str(outside / "x.txt"), "x")
    assert fs.exists("../outside.txt") is False


def test_fs_edit_replaces_single_occurrence(tmp_path):
    fs = FileSystem([tmp_path])
    fs.write("a.txt", "one\ntwo\none\n")
    assert fs.edit("a.txt", "two", "TWO") == "已更新 a.txt（替换 1 处）"
    assert fs.read("a.txt") == "one\nTWO\none"


def test_fs_edit_requires_context_or_replace_all(tmp_path):
    fs = FileSystem([tmp_path])
    fs.write("a.txt", "one\none\n")
    with pytest.raises(ValueError, match="出现 2 次"):
        fs.edit("a.txt", "one", "ONE")
    assert fs.edit("a.txt", "one", "ONE", replace_all=True) == "已更新 a.txt（替换 2 处）"
    assert fs.read("a.txt") == "ONE\nONE"


def test_fs_edit_not_found_raises(tmp_path):
    fs = FileSystem([tmp_path])
    fs.write("a.txt", "hello")
    with pytest.raises(ValueError, match="未在.*中找到目标文本"):
        fs.edit("a.txt", "nope", "x")


def test_fs_search_returns_line_matches(tmp_path):
    fs = FileSystem([tmp_path])
    fs.write("a.py", "alpha\nbeta\n")
    fs.write("b.py", "alpha again\n")
    matches = fs.search("alpha")
    assert any(m.endswith("a.py:1: alpha") for m in matches)
    assert any(m.endswith("b.py:1: alpha again") for m in matches)


def test_fs_is_dir_and_exists(tmp_path):
    fs = FileSystem([tmp_path])
    fs.write("d/f.txt", "x")
    assert fs.is_dir("d") is True
    assert fs.exists("d/f.txt") is True


# --- Memory ---


def test_memory_set_get_and_persist(tmp_path):
    memory_path = tmp_path / ".workstep" / "MEMORY.md"
    store = Memory(memory_path)
    store.set("goal", "build a pipeline")
    store.set("count", 3)
    assert store.get("goal") == "build a pipeline"
    assert store.get("missing") is None

    # Persisted as readable Markdown sections
    content = memory_path.read_text(encoding="utf-8")
    assert "## goal" in content
    assert "build a pipeline" in content
    assert "## count" in content

    reloaded = Memory(memory_path)
    assert reloaded.get("goal") == "build a pipeline"
    assert reloaded.get("count") == 3


def test_memory_roundtrips_structured_values_as_json_blocks(tmp_path):
    memory_path = tmp_path / ".workstep" / "MEMORY.md"
    store = Memory(memory_path)
    store.set("config", {"max_retries": 3, "tags": ["a", "b"]})
    content = memory_path.read_text(encoding="utf-8")
    assert '```json' in content

    reloaded = Memory(memory_path)
    assert reloaded.get("config") == {"max_retries": 3, "tags": ["a", "b"]}


def test_memory_clear(tmp_path):
    store = Memory(tmp_path / ".workstep" / "MEMORY.md")
    store.set("k", "v")
    store.clear()
    assert store.get("k") is None


# --- Skills ---


def _write_skill(directory: Path, name: str, description: str, body: str) -> Path:
    skill_dir = directory / name
    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: {description}\n---\n\n{body}\n",
        encoding="utf-8",
    )
    return skill_dir


def test_skills_discovers_and_loads(tmp_path):
    claude_dir = tmp_path / "claude"
    agents_dir = tmp_path / "agents"
    _write_skill(claude_dir, "review", "Code review skill", "Review instructions body.")
    _write_skill(agents_dir, "review", "Personal review skill", "Personal instructions.")

    skills = Skills([claude_dir, agents_dir])

    names = skills.names()
    assert names == ["review"]
    skill = skills.get("REVIEW")
    assert skill is not None
    # ~/.agents skills win over Claude Code skills
    assert skill.description == "Personal review skill"
    loaded = skills.load("review")
    assert "Personal instructions." in loaded
    assert "---" not in loaded.splitlines()[0]  # frontmatter stripped


def test_skills_project_root_discovers_project_dirs_and_wins(tmp_path):
    home_dir = tmp_path / "home"
    _write_skill(home_dir, "review", "Home review skill", "Home instructions.")
    project = tmp_path / "project"
    _write_skill(project / ".claude" / "skills", "review", "Project review skill", "Project instructions.")

    skills = Skills([home_dir], project_root=project)

    assert skills.names() == ["review"]
    skill = skills.get("review")
    assert skill is not None
    # Project-scoped skills override personal skills with the same name
    assert skill.description == "Project review skill"
    loaded = skills.load("review")
    assert "Project instructions." in loaded


def test_skills_missing_name_raises(tmp_path):
    skills = Skills([tmp_path])
    with pytest.raises(ValueError, match="技能不存在"):
        skills.load("nope")


def test_skills_skips_dirs_without_skill_md(tmp_path):
    (tmp_path / "not-a-skill").mkdir()
    (tmp_path / "not-a-skill" / "readme.txt").write_text("x")
    assert Skills([tmp_path]).names() == []


def test_skills_parses_folded_description(tmp_path):
    skill_dir = tmp_path / "agent-reach"
    skill_dir.mkdir()
    (skill_dir / "SKILL.md").write_text(
        "---\nname: agent-reach\n"
        "description: >\n"
        "  See the entire internet.\n"
        "  Zero config for 8 channels.\n"
        "---\n\nbody\n",
        encoding="utf-8",
    )
    skill = Skills([tmp_path]).get("agent-reach")
    assert skill is not None
    assert skill.description == "See the entire internet. Zero config for 8 channels."


# --- PydanticAIEngine instructions ---


def test_compose_instructions_includes_agents_md(tmp_path):
    (tmp_path / "agents.md").write_text("## 项目规则\n不要修改生成文件。", encoding="utf-8")
    instructions = PydanticAIEngine._compose_instructions(tmp_path)
    assert "MODIFY code" in instructions
    assert ".workstep/MEMORY.md" in instructions
    assert "agents.md" in instructions
    assert "不要修改生成文件" in instructions


def test_compose_instructions_accepts_uppercase_agents_md(tmp_path):
    (tmp_path / "AGENTS.md").write_text("## Rules\nRead the docs first.", encoding="utf-8")
    instructions = PydanticAIEngine._compose_instructions(tmp_path)
    assert "Read the docs first" in instructions


def test_compose_instructions_without_agents_md(tmp_path):
    instructions = PydanticAIEngine._compose_instructions(tmp_path)
    assert "MODIFY code" in instructions
    assert "--- Project instructions" not in instructions


# --- PydanticAIEngine live stage message injection ---


class _FakeRunResult:
    def __init__(self, output: str):
        self.output = output
        self._messages = [f"history-{output}"]

    def all_messages(self):
        return self._messages

    def usage(self):
        return None


@pytest.mark.anyio
async def test_pydantic_ai_run_agent_injects_live_messages(monkeypatch):
    import asyncio

    from engines.events import InternalEvent

    engine = PydanticAIEngine()
    calls: list[dict] = []
    queue: asyncio.Queue = asyncio.Queue()

    async def fake_stream(self, agent, *, prompt, on_event, message_history=None):
        calls.append({"prompt": prompt, "message_history": message_history})
        if len(calls) == 2:
            # 注入轮结束后再放一条，验证多轮持续注入
            queue.put_nowait(("mid-3", "第三条"))
        return _FakeRunResult(f"round-{len(calls)}")

    monkeypatch.setattr(PydanticAIEngine, "_stream_agent_run", fake_stream)
    events: list[InternalEvent] = []

    async def collect(event):
        events.append(event)

    queue.put_nowait(("mid-1", "第一条"))
    queue.put_nowait(("mid-2", "第二条"))
    model = engine.build_model(
        provider="openai",
        base_url="http://localhost:1/v1",
        api_key="test",
        model_name="gpt-4o-mini",
    )

    result, _usage = await engine._run_agent(
        prompt="原始任务",
        cwd=".",
        add_dirs=None,
        model=model,
        on_event=collect,
        live_message_queue=queue,
    )

    assert result.output == "round-3"
    assert [call["prompt"] for call in calls] == [
        "原始任务",
        "第一条\n\n第二条",
        "第三条",
    ]
    assert calls[1]["message_history"] == ["history-round-1"]
    assert calls[2]["message_history"] == ["history-round-2"]
    delivered = [event for event in events if event.type == "live_message"]
    assert [event.data["message_id"] for event in delivered] == [
        "mid-1",
        "mid-2",
        "mid-3",
    ]
    assert all(event.data["status"] == "delivered" for event in delivered)


def test_pydantic_ai_advertises_live_stage_message_support():
    assert PydanticAIEngine().supports_live_stage_message is True
