"""Public interaction protocol shared by every engine adapter."""

import asyncio

import pytest

from engines.core.base import BaseLLMEngine
from engines.core.events import InternalEvent
from engines.core.interactions import (
    claude_ask_user_request,
    elicitation_request,
    permission_request,
)


class InteractionEngine(BaseLLMEngine):
    def __init__(self):
        self.approvals: list[tuple[str, str | None]] = []
        self.answers: list[tuple[str, str]] = []

    @staticmethod
    def is_installed():
        return True

    @staticmethod
    def get_version():
        return "test"

    @staticmethod
    def resolve_binary():
        return "test"

    async def spawn(self, prompt, cwd, **kwargs):
        if False:
            yield

    async def stop(self):
        return None

    async def inject_response(self, tool_use_id, content):
        self.answers.append((tool_use_id, content))

    async def approve_tool_option(self, tool_use_id, option_id):
        self.approvals.append((tool_use_id, option_id))

    @property
    def supports_resume(self):
        return False

    @property
    def supports_interactive(self):
        return True

    def build_resume_params(self, session_id):
        return {}


def test_permission_request_keeps_acp_option_ids_and_labels():
    event = permission_request(
        interaction_id="permission-1",
        session_id="session-1",
        tool_call={
            "tool_call_id": "tool-1",
            "title": "运行测试",
            "kind": "execute",
            "raw_input": {"command": "pytest"},
        },
        options=[
            {"option_id": "once", "name": "仅允许一次", "kind": "allow_once"},
            {"option_id": "deny", "name": "拒绝", "kind": "reject_once"},
        ],
    )

    assert event.type == "interaction_request"
    assert event.data == {
        "interaction_id": "permission-1",
        "method": "session/request_permission",
        "session_id": "session-1",
        "tool_call": {
            "tool_call_id": "tool-1",
            "title": "运行测试",
            "kind": "execute",
            "raw_input": {"command": "pytest"},
        },
        "options": [
            {"option_id": "once", "name": "仅允许一次", "kind": "allow_once"},
            {"option_id": "deny", "name": "拒绝", "kind": "reject_once"},
        ],
    }


def test_claude_ask_user_maps_to_acp_form_elicitation():
    event = claude_ask_user_request(
        "ask-1",
        {
            "questions": [
                {
                    "header": "范围",
                    "question": "选择实现范围",
                    "multiSelect": True,
                    "options": [
                        {"label": "后端", "description": "实现事件桥接"},
                        {"label": "前端", "description": "实现消息交互"},
                    ],
                },
                {
                    "header": "补充",
                    "question": "还有什么要求？",
                    "options": [],
                },
            ]
        },
    )

    assert event.type == "interaction_request"
    assert event.data["method"] == "elicitation/create"
    schema = event.data["requested_schema"]
    assert schema["required"] == ["question_0", "question_1"]
    assert schema["properties"]["question_0"] == {
        "type": "array",
        "title": "范围",
        "description": "选择实现范围",
        "items": {
            "oneOf": [
                {"const": "后端", "title": "后端", "description": "实现事件桥接"},
                {"const": "前端", "title": "前端", "description": "实现消息交互"},
            ]
        },
        "_meta": {"allowInput": True},
    }
    assert schema["properties"]["question_1"] == {
        "type": "string",
        "title": "补充",
        "description": "还有什么要求？",
        "_meta": {"allowInput": True},
    }


def test_elicitation_request_preserves_json_schema():
    requested_schema = {
        "type": "object",
        "properties": {"name": {"type": "string", "title": "名称"}},
        "required": ["name"],
    }
    event = elicitation_request(
        interaction_id="form-1",
        message="请填写名称",
        requested_schema=requested_schema,
        session_id="session-1",
        tool_call_id="tool-1",
    )

    assert event.data["requested_schema"] == requested_schema
    assert event.data["session_id"] == "session-1"
    assert event.data["tool_call_id"] == "tool-1"


@pytest.mark.anyio
async def test_base_engine_routes_acp_permission_selection_to_adapter():
    engine = InteractionEngine()
    request = permission_request(
        interaction_id="permission-1",
        session_id="session-1",
        tool_call={"tool_call_id": "tool-1"},
        options=[{"option_id": "once", "name": "允许", "kind": "allow_once"}],
    ).data

    delivered = await engine.respond_interaction(
        request,
        {"outcome": {"outcome": "selected", "option_id": "once"}},
    )

    assert delivered is True
    assert engine.approvals == [("tool-1", "once")]


@pytest.mark.anyio
async def test_base_engine_routes_elicitation_content_to_tool_response():
    engine = InteractionEngine()
    request = elicitation_request(
        interaction_id="ask-1",
        message="请选择",
        requested_schema={"type": "object", "properties": {}},
        tool_call_id="tool-ask-1",
    ).data

    delivered = await engine.respond_interaction(
        request,
        {"action": "accept", "content": {"question_0": "前端"}},
    )

    assert delivered is True
    assert engine.answers == [("tool-ask-1", '{"question_0": "前端"}')]


@pytest.mark.anyio
async def test_base_engine_can_pause_an_in_process_tool_for_user_input():
    engine = InteractionEngine()
    published = []
    request = elicitation_request(
        interaction_id="ask-1",
        message="请选择",
        requested_schema={"type": "object", "properties": {}},
        tool_call_id="tool-ask-1",
    )

    waiting = asyncio.create_task(
        engine.request_interaction(request, published.append)
    )
    await asyncio.sleep(0)

    assert published == [request]
    assert waiting.done() is False
    delivered = await engine.respond_interaction(
        request.data,
        {"action": "accept", "content": {"answer": "继续"}},
    )

    assert delivered is True
    assert await waiting == {
        "action": "accept",
        "content": {"answer": "继续"},
    }
    assert engine.answers == []


def test_base_engine_normalizes_ask_user_aliases_from_every_adapter():
    engine = InteractionEngine()
    event = engine.normalize_interaction_event(
        InternalEvent(
            type="tool_use",
            data={
                "id": "ask-1",
                "name": "request_user_input",
                "input": {"question": "请输入名称"},
            },
        )
    )

    assert event.type == "interaction_request"
    assert event.data["interaction_id"] == "ask-1"
    assert event.data["method"] == "elicitation/create"
