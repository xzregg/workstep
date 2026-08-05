"""Tests for P5 engines (QCode, OpenClaw, API)."""

import json

import httpx
import pytest

from engines.api import APIEngine
from engines.qcode import QCodeEngine
from engines.openclaw import OpenClawEngine
from engines.events import InternalEvent


class TestQCodeEngine:
    """Tests for QCodeEngine."""

    def test_is_installed(self):
        """Test is_installed returns boolean."""
        assert isinstance(QCodeEngine.is_installed(), bool)

    def test_get_version(self):
        """Test get_version returns string or None."""
        version = QCodeEngine.get_version()
        assert version is None or isinstance(version, str)

    def test_resolve_binary(self):
        """Test resolve_binary returns path or None."""
        binary = QCodeEngine.resolve_binary()
        assert binary is None or isinstance(binary, str)

    def test_supports_resume(self):
        """Test QCode does not support resume."""
        engine = QCodeEngine()
        assert engine.supports_resume is False

    def test_supports_interactive(self):
        """Test QCode does not support interactive."""
        engine = QCodeEngine()
        assert engine.supports_interactive is False

    def test_build_resume_params(self):
        """Test build_resume_params returns dict."""
        engine = QCodeEngine()
        params = engine.build_resume_params("test-session")
        assert isinstance(params, dict)

    def test_map_usage_to_canonical_fields(self):
        event = QCodeEngine()._map_event({
            "type": "usage",
            "usage": {
                "prompt_tokens": 30,
                "completion_tokens": 12,
                "cached_tokens": 8,
            },
        })

        assert event is not None
        assert event.data == {
            "input_tokens": 30,
            "output_tokens": 12,
            "cache_creation_input_tokens": 0,
            "cache_read_input_tokens": 8,
            "total_tokens": 42,
        }

    def test_maps_thinking_and_tool_result(self):
        engine = QCodeEngine()
        thinking = engine._map_event({"type": "thinking", "text": "分析"})
        result = engine._map_event({
            "type": "tool_result",
            "tool_use_id": "tool-1",
            "content": "完成",
        })

        assert thinking is not None and thinking.type == "thinking_delta"
        assert result is not None and result.type == "tool_result"
        assert result.data["tool_use_id"] == "tool-1"


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
        """Test OpenClaw does not support resume."""
        engine = OpenClawEngine()
        assert engine.supports_resume is False

    def test_supports_interactive(self):
        """Test OpenClaw does not support interactive."""
        engine = OpenClawEngine()
        assert engine.supports_interactive is False

    def test_build_resume_params(self):
        """Test build_resume_params returns dict."""
        engine = OpenClawEngine()
        params = engine.build_resume_params("test-session")
        assert isinstance(params, dict)

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

        assert thinking is not None and thinking.type == "thinking_delta"
        assert result is not None and result.type == "tool_result"
        assert result.data["is_error"] is False


class TestAPIEngine:
    """Tests for APIEngine."""

    def test_is_installed(self, monkeypatch):
        """API mode ships with the daemon, with readiness tracked separately."""
        monkeypatch.setattr(
            "engines.api.config_store.get_api_engine_config",
            lambda: {
                "provider": "openai",
                "base_url": "https://example.test/v1",
                "api_key": "",
                "model": "",
            },
        )
        assert APIEngine.is_installed() is True
        assert APIEngine.is_configured() is False
        monkeypatch.setattr(
            "engines.api.config_store.get_api_engine_config",
            lambda: {
                "provider": "openai",
                "base_url": "https://example.test/v1",
                "api_key": "configured",
                "model": "test-model",
            },
        )
        assert APIEngine.is_configured() is True

    def test_get_version(self):
        """Test get_version returns version string."""
        version = APIEngine.get_version()
        assert isinstance(version, str)
        assert version == "1.0.0"

    def test_resolve_binary(self):
        """Test resolve_binary returns identifier."""
        binary = APIEngine.resolve_binary()
        assert binary == "api-engine"

    def test_supports_resume(self):
        """Test API engine does not support resume."""
        engine = APIEngine()
        assert engine.supports_resume is False

    def test_supports_interactive(self):
        """Test API engine does not support interactive."""
        engine = APIEngine()
        assert engine.supports_interactive is False

    def test_build_resume_params(self):
        """Test build_resume_params returns dict."""
        engine = APIEngine()
        params = engine.build_resume_params("test-session")
        assert isinstance(params, dict)

    def test_internal_event_creation(self):
        """Test InternalEvent creation works."""
        event = InternalEvent(
            type="text_delta",
            data={"delta": "test"},
        )
        assert event.type == "text_delta"
        assert event.data["delta"] == "test"
        assert event.to_dict()["type"] == "text_delta"

    def test_map_openai_usage_with_cache(self):
        """OpenAI usage maps prompt_tokens_details.cached_tokens to cache read."""
        engine = APIEngine()
        event = engine._map_openai_event({
            "usage": {
                "prompt_tokens": 300,
                "completion_tokens": 100,
                "total_tokens": 400,
                "prompt_tokens_details": {"cached_tokens": 120},
            },
        })
        assert event is not None
        assert event.type == "usage"
        assert event.data["input_tokens"] == 300
        assert event.data["output_tokens"] == 100
        assert event.data["cache_read_input_tokens"] == 120

    def test_map_openai_usage_without_cache_details(self):
        """OpenAI usage without prompt_tokens_details still maps to zeros."""
        engine = APIEngine()
        event = engine._map_openai_event({
            "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 5,
                "total_tokens": 15,
            },
        })
        assert event is not None
        assert event.type == "usage"
        assert event.data["cache_read_input_tokens"] == 0

    def test_maps_openai_reasoning_delta(self):
        event = APIEngine()._map_openai_event({
            "object": "chat.completion.chunk",
            "choices": [{"delta": {"reasoning_content": "分析中"}}],
        })

        assert event is not None
        assert event.type == "thinking_delta"
        assert event.data["delta"] == "分析中"

    def test_map_anthropic_usage_with_cache(self):
        """Anthropic message_delta usage includes cache hit tokens."""
        engine = APIEngine()
        event = engine._map_anthropic_event({
            "type": "message_delta",
            "usage": {
                "input_tokens": 300,
                "output_tokens": 100,
                "cache_creation_input_tokens": 150,
                "cache_read_input_tokens": 120,
            },
        })
        assert event is not None
        assert event.type == "usage"
        assert event.data["input_tokens"] == 300
        assert event.data["output_tokens"] == 100
        assert event.data["cache_creation_input_tokens"] == 150
        assert event.data["cache_read_input_tokens"] == 120

    def test_maps_anthropic_thinking_delta(self):
        event = APIEngine()._map_anthropic_event({
            "type": "content_block_delta",
            "delta": {"type": "thinking_delta", "thinking": "分析中"},
        })

        assert event is not None
        assert event.type == "thinking_delta"

    @pytest.mark.anyio
    async def test_openai_stream_requests_and_maps_usage(self):
        captured_payload = {}

        def handler(request: httpx.Request):
            captured_payload.update(json.loads(request.content))
            body = (
                'data: {"object":"chat.completion.chunk","choices":[],"usage":'
                '{"prompt_tokens":30,"completion_tokens":12,"total_tokens":42}}\n\n'
                'data: [DONE]\n\n'
            )
            return httpx.Response(200, text=body)

        transport = httpx.MockTransport(handler)
        engine = APIEngine(transport=transport)
        async with httpx.AsyncClient(transport=transport) as client:
            events = await engine._call_openai(
                client,
                "test-model",
                [{"role": "user", "content": "hello"}],
                "https://example.test/v1",
            )

        assert captured_payload["stream_options"] == {"include_usage": True}
        assert events[-1].type == "usage"
        assert events[-1].data["total_tokens"] == 42

    @pytest.mark.anyio
    async def test_anthropic_stream_merges_initial_and_final_usage(self):
        body = "\n\n".join([
            'data: {"type":"message_start","message":{"usage":'
            '{"input_tokens":30,"output_tokens":1,'
            '"cache_creation_input_tokens":4,"cache_read_input_tokens":8}}}',
            'data: {"type":"message_delta","usage":{"output_tokens":12}}',
            'data: [DONE]',
            '',
        ])

        transport = httpx.MockTransport(
            lambda request: httpx.Response(200, text=body)
        )
        engine = APIEngine(transport=transport)
        async with httpx.AsyncClient(transport=transport) as client:
            events = await engine._stream_anthropic(
                client,
                "https://example.test/v1/messages",
                {"stream": True},
                "secret",
            )

        usage_events = [event for event in events if event.type == "usage"]
        assert len(usage_events) == 1
        assert usage_events[0].data == {
            "input_tokens": 30,
            "output_tokens": 12,
            "cache_creation_input_tokens": 4,
            "cache_read_input_tokens": 8,
            "total_tokens": 42,
        }
