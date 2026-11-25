"""Guardrails for text injected into model prompts."""

import re
import pytest

from agent_assistants.context_handoff import render_handoff, render_handoff_reference
from services.prompt import assemble_followup_prompt, assemble_prompt
from services.tool_registry import workstep_tools_instruction


CJK_RE = re.compile(r"[\u3400-\u9fff]")


@pytest.mark.parametrize("status,paused,step", [
    ("completed", False, "done"), ("pending", True, "role"),
    ("pending", False, "name"), ("pending", False, "role"),
    ("pending", False, "personality"), ("pending", False, "duties"),
    ("pending", False, "confirm"),
])
def test_identity_setup_prompt_scaffolding_is_english(monkeypatch, status, paused, step):
    from services import digital_person

    menus = {field: {"options": [{"id": str(i), "label": label}
              for i, label in enumerate(labels, 1)], "multiple": field != "role"}
             for field, labels in digital_person.IDENTITY_MENUS.items()}
    state = {"status": status, "paused": paused, "step": step, "menus": menus}
    monkeypatch.setattr(digital_person, "identity_setup_status", lambda: state)
    prompt = digital_person.identity_setup_prompt()
    assert not CJK_RE.search(prompt)
    assert "user's language" in prompt
    if status == "pending":
        state["answers"] = {"name": "澄知"}
        assert "澄知" in digital_person.identity_setup_prompt()


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


def test_digital_person_prompt_scaffolding_is_english(monkeypatch):
    from types import SimpleNamespace
    from services import customization_workspace, digital_person
    from services.digital_person_memory import prompt as memory_prompt

    profile = digital_person.DigitalPersonProfile(
        enabled=True, name="Ari", role="Developer", personality="Curious",
        tone="Direct", duties="Follow up on delegated work.",
        conversation_rules="Keep replies brief.",
        relationship_style="warm", relationship_preferences="Speak naturally.",
    )
    monkeypatch.setattr(customization_workspace, "is_default_workspace", lambda _: True)
    monkeypatch.setattr(digital_person, "get_profile", lambda: profile)
    identity = digital_person.prompt_for_project(SimpleNamespace(id="home"))
    assert not CJK_RE.search(identity)
    assert "workstep-cli skill" in identity
    assert "Keep replies brief." in identity
    assert "## Conversation style\nWarm and approachable" in identity
    assert "Speak naturally." in identity
    assert not CJK_RE.search(memory_prompt([{"content": "Original text"}]))


def test_channel_source_prompt_scaffolding_is_english():
    from services.channels.base import IncomingMessage
    import json
    from types import SimpleNamespace
    from services.channels.source_prompt import message_source, request_source_prompt

    for conversation_type in ("single", "group"):
        message = IncomingMessage(bot_id="bot", message_id="message",
            conversation_type=conversation_type, conversation_id="room",
            sender_id="sender", text="Request")
        user = SimpleNamespace(prompt_json=json.dumps({"channel_source": message_source(message, "test")}))
        text = request_source_prompt(user)
        assert not CJK_RE.search(text)
        assert '"sender_id": "sender"' in text
        assert message.text not in text
