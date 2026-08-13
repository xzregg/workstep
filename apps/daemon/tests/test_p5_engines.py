"""Tests for P5 engines (OpenClaw)."""

import json

import httpx
import pytest

from engines.openclaw import OpenClawEngine
from engines.core.events import InternalEvent


class TestOpenClawEngine:
    """Tests for OpenClawEngine."""

    def test_is_installed(self):
        """Test is_installed returns boolean."""
        assert isinstance(OpenClawEngine.is_installed(), bool)

    def test_get_version(self):
        """Test get_version returns string or None."""
        version = OpenClawEngine.get_version()
        assert version is None or isinstance(version, str)

    def test_resolve_binary(self):
        """Test resolve_binary returns path or None."""
        binary = OpenClawEngine.resolve_binary()
        assert binary is None or isinstance(binary, str)

    def test_supports_resume(self):
        """The stable headless `agent exec` contract is one-shot."""
        engine = OpenClawEngine()
        assert engine.supports_resume is False
        assert engine.build_resume_params("test-session") == {}

    def test_supports_interactive(self):
        """Test OpenClaw does not support interactive."""
        engine = OpenClawEngine()
        assert engine.supports_interactive is False

    def test_build_resume_params(self):
        """Test build_resume_params returns dict."""
        engine = OpenClawEngine()
        params = engine.build_resume_params("test-session")
        assert isinstance(params, dict)

    def test_build_command_uses_official_agent_exec_json_contract(self):
        command = OpenClawEngine.build_command(
            "/fake/openclaw", "完成任务", "/repo", model="openai/gpt-5"
        )
        assert command == [
            "/fake/openclaw", "agent", "exec", "完成任务",
            "--cwd", "/repo", "--json", "--model", "openai/gpt-5",
        ]

    def test_maps_stable_agent_exec_envelope(self):
        events = OpenClawEngine()._map_envelope({
            "ok": True,
            "status": "ok",
            "final": "完成",
            "usage": {"input": 12, "output": 3, "total": 15},
            "costUsd": 0.02,
            "sessionId": "session-1",
        })

        assert [event.type for event in events] == [
            "session_started", "agent_message_chunk", "usage_update"
        ]
        assert events[1].data["content"]["text"] == "完成"
        assert events[2].data["total_tokens"] == 15
        assert events[2].data["cost"] == {"amount": 0.02, "currency": "USD"}

    def test_maps_agent_exec_error_envelope(self):
        events = OpenClawEngine()._map_envelope({
            "ok": False,
            "status": "error",
            "error": {"message": "认证失败", "kind": "auth"},
        })

        assert [event.type for event in events] == ["error"]
        assert events[0].data["message"] == "认证失败"

    def test_map_total_only_usage_to_canonical_fields(self):
        event = OpenClawEngine()._map_event({"type": "usage", "tokens": 42})

        assert event is not None
        assert event.data["total_tokens"] == 42

    def test_maps_thinking_and_completed_tool(self):
        engine = OpenClawEngine()
        thinking = engine._map_event({"type": "reasoning", "content": "分析"})
        result = engine._map_event({
            "type": "tool",
            "id": "tool-2",
            "status": "completed",
            "output": "完成",
        })

        assert thinking is not None and thinking.type == "agent_thought_chunk"
        assert result is not None and result.type == "tool_call_update"
        assert result.data["status"] == "completed"
