"""Engine multimodal (image) input contracts."""

import base64

import pytest

from engines.base import BaseLLMEngine, EngineCapabilities
from engines.events import InternalEvent
from engines.schema import EngineImage


def test_engine_image_to_data_url_from_local_file(tmp_path):
    png = tmp_path / "shot.png"
    png.write_bytes(b"\x89PNG\r\n\x1a\nfakepngbytes")
    image = EngineImage(path=str(png))
    url = image.to_data_url()
    assert url.startswith("data:image/png;base64,")
    assert base64.b64decode(url.split(",", 1)[1]) == png.read_bytes()


def test_engine_image_keeps_remote_url():
    image = EngineImage(url="https://example.com/a.png")
    assert image.to_data_url() == "https://example.com/a.png"


def test_engine_image_missing_file_raises(tmp_path):
    image = EngineImage(path=str(tmp_path / "missing.png"))
    with pytest.raises(FileNotFoundError):
        image.to_data_url()


def test_capabilities_default_vision_false():
    caps = EngineCapabilities(
        supports_coordinator=True,
        supports_resume=False,
        supports_tool_disable=True,
        supports_native_schema=False,
        supports_live_stage_message=False,
    )
    assert caps.supports_vision is False


class PromptCapturingEngine(BaseLLMEngine):
    """Records the prompt it receives from spawn_coordinator."""

    calls: list[str] = []

    @staticmethod
    def is_installed():
        return True

    @staticmethod
    def get_version():
        return "test"

    @staticmethod
    def resolve_binary():
        return "test"

    async def spawn(self, prompt, cwd, model=None, add_dirs=None, session_id=None, **kwargs):
        type(self).calls.append(prompt)
        yield InternalEvent(type="text_delta", data={"delta": "ok"})

    async def stop(self):
        pass

    async def inject_response(self, tool_use_id, content):
        pass

    @property
    def supports_resume(self):
        return False

    @property
    def supports_interactive(self):
        return False

    def build_resume_params(self, session_id):
        return {}


@pytest.mark.anyio
async def test_base_spawn_coordinator_injects_image_refs_into_prompt():
    PromptCapturingEngine.calls.clear()
    engine = PromptCapturingEngine()
    images = [
        EngineImage(path="/project/.workstep/uploads/a.png", description="截图A"),
        EngineImage(url="https://example.com/b.png"),
    ]
    async for _ in engine.spawn_coordinator("原问题", cwd="/project", images=images):
        pass
    prompt = PromptCapturingEngine.calls[-1]
    assert "原问题" in prompt
    assert "/project/.workstep/uploads/a.png" in prompt
    assert "截图A" in prompt
    assert "https://example.com/b.png" in prompt


@pytest.mark.anyio
async def test_base_spawn_coordinator_without_images_keeps_prompt_clean():
    PromptCapturingEngine.calls.clear()
    engine = PromptCapturingEngine()
    async for _ in engine.spawn_coordinator("普通问题", cwd="/project"):
        pass
    prompt = PromptCapturingEngine.calls[-1]
    assert prompt == (
        "You are a read-only task coordinator. Do not call tools, execute "
        "commands, or modify files. Return only the requested JSON.\n\n普通问题"
    )


@pytest.mark.anyio
async def test_api_engine_sends_openai_image_blocks(monkeypatch, tmp_path):
    import json

    import httpx

    import engines.api as api_engine_module
    from engines.api import APIEngine

    captured = {}

    async def handler(request):
        captured["payload"] = json.loads(request.content)
        stream = 'data: {"choices": [{"delta": {"content": "ok"}}]}\n\ndata: [DONE]\n\n'
        return httpx.Response(
            200,
            content=stream.encode(),
            headers={"content-type": "text/event-stream"},
        )

    store = SimpleStore(provider="openai", base_url="https://gateway.example.com/v1")
    monkeypatch.setattr(api_engine_module, "config_store", store)
    engine = APIEngine(transport=httpx.MockTransport(handler))

    async for _ in engine.spawn(
        "hi",
        cwd="/tmp",
        images=[EngineImage(url="https://example.com/x.png", description="截图")],
    ):
        pass

    messages = captured["payload"]["messages"]
    assert messages[0]["content"] == [
        {"type": "text", "text": "hi"},
        {"type": "image_url", "image_url": {"url": "https://example.com/x.png"}},
    ]


@pytest.mark.anyio
async def test_api_engine_sends_anthropic_base64_image_blocks(monkeypatch, tmp_path):
    import json

    import httpx

    import engines.api as api_engine_module
    from engines.api import APIEngine

    png = tmp_path / "shot.png"
    png.write_bytes(b"\x89PNG\r\n\x1a\nfakepngbytes")
    captured = {}

    async def handler(request):
        captured["payload"] = json.loads(request.content)
        stream = 'data: {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "ok"}}\n\ndata: [DONE]\n\n'
        return httpx.Response(
            200,
            content=stream.encode(),
            headers={"content-type": "text/event-stream"},
        )

    store = SimpleStore(provider="anthropic", base_url="https://gateway.example.com/v1")
    monkeypatch.setattr(api_engine_module, "config_store", store)
    engine = APIEngine(transport=httpx.MockTransport(handler))

    async for _ in engine.spawn(
        "hi",
        cwd="/tmp",
        images=[EngineImage(path=str(png))],
    ):
        pass

    messages = captured["payload"]["messages"]
    content = messages[0]["content"]
    assert content[0] == {"type": "text", "text": "hi"}
    image_block = content[1]
    assert image_block["type"] == "image"
    assert image_block["source"]["type"] == "base64"
    assert image_block["source"]["media_type"] == "image/png"
    assert base64.b64decode(image_block["source"]["data"]) == png.read_bytes()


@pytest.mark.anyio
async def test_api_engine_without_images_keeps_plain_text_content(
    monkeypatch, tmp_path
):
    import json

    import httpx

    import engines.api as api_engine_module
    from engines.api import APIEngine

    captured = {}

    async def handler(request):
        captured["payload"] = json.loads(request.content)
        stream = 'data: {"choices": [{"delta": {"content": "ok"}}]}\n\ndata: [DONE]\n\n'
        return httpx.Response(
            200,
            content=stream.encode(),
            headers={"content-type": "text/event-stream"},
        )

    store = SimpleStore(provider="openai", base_url="https://gateway.example.com/v1")
    monkeypatch.setattr(api_engine_module, "config_store", store)
    engine = APIEngine(transport=httpx.MockTransport(handler))

    async for _ in engine.spawn("hi", cwd="/tmp"):
        pass

    assert captured["payload"]["messages"][0]["content"] == "hi"


class SimpleStore:
    """Minimal config-store stub used by vision engine tests."""

    def __init__(self, provider="openai", base_url="https://gateway.example.com/v1"):
        self.config = {"provider": provider, "base_url": base_url, "api_key": "k", "model": "m"}

    def get_api_engine_config(self):
        return dict(self.config)

    def get_pydantic_ai_engine_config(self):
        return dict(self.config)


@pytest.mark.anyio
async def test_pydantic_ai_spawn_forwards_images_to_run_agent(monkeypatch):
    import engines.pydantic_ai as pydantic_ai_module
    from engines.pydantic_ai import PydanticAIEngine

    store = SimpleStore(
        provider="openai",
        base_url="https://agent-gateway.example.com/v1",
    )
    store.config["model"] = "agent-model"
    monkeypatch.setattr(pydantic_ai_module, "config_store", store)

    class FakeUsage:
        input_tokens = 1
        output_tokens = 1
        total_tokens = 2
        cache_write_tokens = 0
        cache_read_tokens = 0
        requests = 1
        cost = None

    class FakeResult:
        output = "agent result"
        usage = FakeUsage()

    captured = {}

    def fake_build_model(**config):
        return object()

    async def fake_run_agent(self, *, prompt, cwd, add_dirs, model, on_event, live_message_queue=None, images=None):
        captured["images"] = images
        captured["prompt"] = prompt
        return FakeResult(), FakeUsage()

    monkeypatch.setattr(PydanticAIEngine, "build_model", staticmethod(fake_build_model))
    monkeypatch.setattr(PydanticAIEngine, "_run_agent", fake_run_agent)

    images = [EngineImage(url="https://example.com/x.png")]
    async for _ in PydanticAIEngine().spawn(
        "do work", cwd="/tmp/project", images=images
    ):
        pass

    assert captured["prompt"] == "do work"
    assert captured["images"] == images


@pytest.mark.anyio
async def test_pydantic_ai_run_agent_builds_image_user_content(monkeypatch):
    from pydantic_ai.models.test import TestModel

    from engines.pydantic_ai import PydanticAIEngine

    captured = {}

    class FakeUsage:
        input_tokens = 1
        output_tokens = 1
        total_tokens = 2
        cache_write_tokens = 0
        cache_read_tokens = 0
        requests = 1
        cost = None

        def __add__(self, other):
            return self

    class FakeResult:
        usage = FakeUsage()

        def all_messages(self):
            return []

    async def fake_stream_agent_run(self, agent, *, prompt, on_event, message_history=None):
        captured["prompt"] = prompt
        return FakeResult()

    monkeypatch.setattr(
        PydanticAIEngine, "_stream_agent_run", fake_stream_agent_run
    )
    engine = PydanticAIEngine()
    await engine._run_agent(
        prompt="看图说话",
        cwd="/tmp",
        add_dirs=None,
        model=TestModel(),
        on_event=lambda event: None,
        images=[EngineImage(url="https://example.com/x.png", description="截图")],
    )

    parts = captured["prompt"]
    assert isinstance(parts, list)
    assert parts[0].content == "看图说话"
    assert parts[0].part_kind == "text"
    assert parts[1].url == "https://example.com/x.png"
    assert parts[1].kind == "image-url"


@pytest.mark.anyio
async def test_pydantic_ai_run_agent_without_images_keeps_string_prompt(monkeypatch):
    from pydantic_ai.models.test import TestModel

    from engines.pydantic_ai import PydanticAIEngine

    captured = {}

    class FakeUsage:
        input_tokens = 1
        output_tokens = 1
        total_tokens = 2
        cache_write_tokens = 0
        cache_read_tokens = 0
        requests = 1
        cost = None

        def __add__(self, other):
            return self

    class FakeResult:
        usage = FakeUsage()

        def all_messages(self):
            return []

    async def fake_stream_agent_run(self, agent, *, prompt, on_event, message_history=None):
        captured["prompt"] = prompt
        return FakeResult()

    monkeypatch.setattr(
        PydanticAIEngine, "_stream_agent_run", fake_stream_agent_run
    )
    engine = PydanticAIEngine()
    await engine._run_agent(
        prompt="普通问题",
        cwd="/tmp",
        add_dirs=None,
        model=TestModel(),
        on_event=lambda event: None,
    )

    assert captured["prompt"] == "普通问题"


def test_vision_capabilities_advertised_per_engine():
    from engines.api import APIEngine
    from engines.claude_agent_sdk import ClaudeAgentSDKEngine
    from engines.claude_code import ClaudeCodeEngine
    from engines.codex import CodexEngine
    from engines.codex_sdk import CodexSDKEngine
    from engines.pydantic_ai import PydanticAIEngine

    assert APIEngine().capabilities.supports_vision is True
    assert PydanticAIEngine().capabilities.supports_vision is True
    assert ClaudeCodeEngine().capabilities.supports_vision is True
    assert ClaudeAgentSDKEngine().capabilities.supports_vision is True
    assert CodexEngine().capabilities.supports_vision is False
    assert CodexSDKEngine().capabilities.supports_vision is False
