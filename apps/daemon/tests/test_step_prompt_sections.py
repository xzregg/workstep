"""Application sections stay distinct from user-authored Markdown."""

from types import SimpleNamespace
import hashlib

from services.pipeline import Step
from services.prompt import (
    _format_changed_context,
    _prompt_section,
    _step_requirements_parts,
    _task_background_parts,
    assemble_retry_prompt,
    legacy_task_context_hashes,
)


def test_background_xml_keeps_markdown_and_supports_incremental_clears(tmp_path, monkeypatch):
    import services.prompt as prompts

    memory = "## 回复规则\n简洁回复\n\n## Task\n这是记忆示例，不是当前任务。"
    description = "## 目标\n实现功能\n\n## Project memory\n这是任务内示例。"
    task = SimpleNamespace(id="task", cwd=str(tmp_path), workflow_id="flow",
                           title="当前任务", description=description, source_dispatch_id=None)
    monkeypatch.setattr(prompts, "load_memory_for_prompt", lambda _: memory)
    hashes = {}
    parts = _task_background_parts(task, tmp_path / "artifacts", separate_instructions=True,
                                   context_hashes=hashes)
    prompt = "\n".join(parts)
    assert f"<project_memory>\n{memory}\n</project_memory>\n" in prompt
    assert f"<task>\n当前任务\n{description}\n</task>\n" in prompt
    assert _prompt_section(prompt, "Project memory") == memory
    assert _prompt_section(prompt, "Task") == "当前任务\n" + description
    assert legacy_task_context_hashes(prompt) == hashes
    assert _task_background_parts(task, tmp_path / "artifacts", separate_instructions=True,
                                  previous_context_hashes=hashes) == []
    monkeypatch.setattr(prompts, "load_memory_for_prompt", lambda _: "")
    update = "".join(_task_background_parts(
        task, tmp_path / "artifacts", separate_instructions=True, previous_context_hashes=hashes,
    ))
    assert update == "<updated_project_memory>\nThe project memory was cleared.\n</updated_project_memory>\n"


def test_step_requirement_update_closes_before_the_next_section(tmp_path):
    task = SimpleNamespace(id="task", cwd=str(tmp_path), workflow_id="flow")
    step = Step(key="build", label="Build", prompt="## 阶段要求\n保留正文 <example> 标签")
    parts = _step_requirements_parts(task, step, tmp_path / "artifacts", "",
                                     {"Step requirements": "old"}, {})
    assert parts == ["<updated_step_requirements>\n"
                     "These replace the previous step-specific requirements.\n"
                     "## 阶段要求\n保留正文 <example> 标签\n</updated_step_requirements>\n"]


def test_retry_accepts_xml_and_legacy_markdown_background(tmp_path):
    task = SimpleNamespace(id="task", cwd=str(tmp_path), workflow_id="flow",
                           title="Original", description="## 目标\nBuild", source_dispatch_id=None)
    step = Step(key="build", label="Build", prompt="Build")
    for previous in (
        "## Task\nOriginal\n## 目标\nBuild\n\n## Step requirements\nBuild",
        "<task>\nOriginal\n## 目标\nBuild\n</task>\n",
    ):
        unchanged = assemble_retry_prompt(task, step, tmp_path / "artifacts", {}, previous_prompt=previous)
        assert "<updated_task>" not in unchanged
        task.description = "Changed"
        changed = assemble_retry_prompt(task, step, tmp_path / "artifacts", {}, previous_prompt=previous)
        assert "<updated_task>\nOriginal\nChanged\n</updated_task>\n" in changed
        task.description = "## 目标\nBuild"


def test_updated_context_uses_the_same_named_boundary():
    assert _format_changed_context("Task Git workspace", "workspace") == (
        "<updated_task_git_workspace>\nworkspace\n</updated_task_git_workspace>\n"
    )


def test_legacy_markdown_does_not_read_xml_examples_as_app_sections(tmp_path, monkeypatch):
    import services.prompt as prompts

    memory = 'Saved rules\n<project_memory>\nExample rules\n</project_memory>'
    task_text = 'Original task\nExplain XML:\n<task>\nChanged task\n</task>'
    previous = f'## Project memory\n{memory}\n\n## Task\n{task_text}\n\n## Step requirements\nBuild'
    hashes = legacy_task_context_hashes(previous)
    assert _prompt_section(previous, 'Project memory') == memory
    assert _prompt_section(previous, 'Task') == task_text
    assert hashes['Task'] == hashlib.sha256(task_text.encode()).hexdigest()
    assert hashes['Project memory'] == hashlib.sha256(memory.encode()).hexdigest()
    # A real task update matching an XML example must still reach the resumed model.
    task = SimpleNamespace(id='task', cwd=str(tmp_path), workflow_id='flow',
                           title='Changed task', description='', source_dispatch_id=None)
    monkeypatch.setattr(prompts, 'load_memory_for_prompt', lambda _: memory)
    parts = _task_background_parts(task, tmp_path / 'artifacts', separate_instructions=True,
                                   previous_context_hashes=hashes)
    assert '<updated_task>\nChanged task\n</updated_task>\n' in parts
    assert not any('<updated_project_memory>' in part for part in parts)
