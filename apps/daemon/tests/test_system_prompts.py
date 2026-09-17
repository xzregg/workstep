"""Guardrails for prompts injected as system instructions."""

import re

import pytest

from agent_assistants.channel_chat import SYSTEM_PROMPT as CHANNEL_SYSTEM_PROMPT
from agent_assistants.chat_session import ENHANCE_SYSTEM_PROMPT
from agent_assistants.chat_session import SYSTEM_PROMPT as CHAT_SYSTEM_PROMPT
from agent_assistants.coordinator import COORDINATOR_CONFIG
from agent_assistants.task_draft import (
    SYSTEM_PROMPT as TASK_SYSTEM_PROMPT,
    SYSTEM_PROMPT_SCHEDULE,
)
from agent_assistants.workflow_gen import SYSTEM_PROMPT as FLOW_SYSTEM_PROMPT
from services.chat_permissions import PLAN_MODE_INSTRUCTION
from services.prompt import SYSTEM_PROMPT as PIPELINE_SYSTEM_PROMPT


CJK_RE = re.compile(r"[\u3400-\u9fff]")

PROMPTS = {
    "pipeline": PIPELINE_SYSTEM_PROMPT,
    "chat": CHAT_SYSTEM_PROMPT,
    "enhance": ENHANCE_SYSTEM_PROMPT,
    "coordinator": COORDINATOR_CONFIG.system_prompt,
    "task": TASK_SYSTEM_PROMPT,
    "task_schedule": SYSTEM_PROMPT_SCHEDULE,
    "workflow": FLOW_SYSTEM_PROMPT,
    "channel": CHANNEL_SYSTEM_PROMPT,
    "plan_mode": PLAN_MODE_INSTRUCTION,
}


@pytest.mark.parametrize("name,prompt", PROMPTS.items())
def test_system_prompts_are_compact_english(name, prompt):
    assert prompt.strip(), name
    assert not CJK_RE.search(prompt), name
    assert len(prompt) <= 2200, name
