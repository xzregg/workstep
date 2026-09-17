"""Guardrails for text injected into model prompts."""

import re

from agent_assistants.context_handoff import render_handoff, render_handoff_reference
from services.prompt import assemble_followup_prompt, assemble_prompt
from services.tool_registry import workstep_tools_instruction


CJK_RE = re.compile(r"[\u3400-\u9fff]")


def test_prompt_templates_have_no_cjk(tmp_path):
    from models import init_db, Task
    from services.pipeline import Step
    import time
    import uuid

    db = init_db(str(tmp_path / "test.db"))
    task = Task.create(
        id=str(uuid.uuid4()),
        title="Test",
        description="Task description",
        cwd=str(tmp_path),
        created_at=int(time.time()),
        updated_at=int(time.time()),
    )
    step = Step(
        key="req",
        label="Requirement",
        prompt="Write a PRD",
        outputs=[{"name": "Spec", "type": "md"}],
    )
    artifacts = tmp_path / "artifacts"
    artifacts.mkdir()

    assert not CJK_RE.search(assemble_prompt(task, step, artifacts))
    assert not CJK_RE.search(
        assemble_followup_prompt(task, step, artifacts, "revise the result")
    )
    db.close()


def test_handoff_and_tool_prompt_templates_have_no_cjk():
    package = {
        "version": 1,
        "mode": "smart",
        "source_session_id": "source-1",
        "message_count": 0,
        "objective": "",
        "latest_request": "",
        "file_refs": [],
        "decisions": [],
        "constraints": [],
        "messages": [],
    }
    metadata = {
        "mode": "smart",
        "relative_path": "event_logs/source-1/handoffs.jsonl",
        "handoff_id": "h1",
        "source_engine": "claude",
        "target_engine": "codex",
        "cutoff_message_id": "m1",
    }
    assert not CJK_RE.search(render_handoff(package))
    assert not CJK_RE.search(render_handoff_reference(metadata, "/tmp/project"))
    assert not CJK_RE.search(workstep_tools_instruction())
