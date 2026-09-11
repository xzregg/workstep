"""Engine multimodal (image) input contracts."""

import base64

import pytest

from engines.core.acp_base import AcpEngineBase
from engines.core.base import EngineCapabilities
from engines.core.events import InternalEvent
from engines.core.schema import EngineImage


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


class PromptCapturingEngine(AcpEngineBase):
    """Records the prompt it receives from spawn_coordinator."""

    calls: list[str] = []
    image_calls: list[list[EngineImage] | None] = []

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
        type(self).image_calls.append(kwargs.get("images"))
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


class DirectImageEngine(PromptCapturingEngine):
    @property
    def supports_vision(self):
        return True


@pytest.mark.anyio
async def test_base_spawn_coordinator_injects_image_refs_into_prompt():
    PromptCapturingEngine.calls.clear()
    PromptCapturingEngine.image_calls.clear()
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
    assert PromptCapturingEngine.image_calls[-1] is None


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
@pytest.mark.parametrize("multimodal", [True, False])
async def test_assistant_sends_images_directly_only_for_multimodal_model(
    monkeypatch,
    multimodal,
):
    import agent_assistants.base as assistant_base

    DirectImageEngine.calls.clear()
    DirectImageEngine.image_calls.clear()
    engine = DirectImageEngine()

    class ModelSettingsStore:
        def model_supports_multimodal(self, engine_id, model, provider_id=""):
            assert (engine_id, model, provider_id) == ("vision", "vision-model", "")
            return multimodal

    monkeypatch.setattr(assistant_base, "create_engine", lambda _engine_id: engine)
    monkeypatch.setattr(assistant_base, "config_store", ModelSettingsStore())
    image = EngineImage(path="/project/.workstep/uploads/a.png")

    await assistant_base.invoke_engine(
        "vision",
        "vision-model",
        "/project",
        "看图说话",
        None,
        images=[image],
    )

    assert DirectImageEngine.image_calls[-1] == ([image] if multimodal else None)
    assert ("/project/.workstep/uploads/a.png" in DirectImageEngine.calls[-1]) is not multimodal


class SimpleStore:
    """Minimal provider-backed config-store stub used by vision engine tests."""

    def __init__(self, provider="openai", base_url="https://gateway.example.com/v1"):
        self.provider = {
            "id": "prov_1",
            "name": "主账号",
            "type": provider,
            "base_url": base_url,
            "api_key": "k",
            "enabled": True,
            "verified": True,
            "created_at": "",
        }
        self.pydantic_config = {"provider_id": "prov_1", "model": "m"}

    def get_pydantic_ai_engine_config(self):
        return dict(self.pydantic_config)

    def get_provider(self, provider_id):
        if provider_id != "prov_1":
            return None
        return dict(self.provider)


@pytest.mark.anyio
async def test_pydantic_ai_spawn_forwards_images_to_run_agent(monkeypatch):
    import engines.pydantic_ai.engine as pydantic_ai_module
    from engines.pydantic_ai import PydanticAIEngine

    store = SimpleStore(
        provider="openai",
        base_url="https://agent-gateway.example.com/v1",
    )
    store.pydantic_config["model"] = "agent-model"
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

    async def fake_run_agent(self, *, prompt, cwd, add_dirs, model, on_event, live_message_queue=None, images=None, session_id=None, sandbox="workspace-write"):
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

    async def fake_stream_agent_run(self, agent, *, prompt, on_event, message_history=None, conversation_id=None):
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
    assert parts[0].startswith("看图说话\n\n")
    assert "Actual image data is attached" in parts[0]
    assert "do not treat the Markdown file path as the only image input" in parts[0]
    assert parts[1].url == "https://example.com/x.png"
    assert parts[1].kind == "image-url"


@pytest.mark.anyio
async def test_pydantic_ai_image_user_content_is_accepted_by_agent():
    """The real Pydantic AI input converter accepts our multimodal content."""
    from pydantic_ai import Agent
    from pydantic_ai.models.test import TestModel

    from engines.pydantic_ai import PydanticAIEngine

    content = PydanticAIEngine._build_user_content(
        "图片有什么",
        [EngineImage(url="https://example.com/x.png")],
    )

    result = await Agent(TestModel()).run(content)
    assert isinstance(result.output, str)


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

    async def fake_stream_agent_run(self, agent, *, prompt, on_event, message_history=None, conversation_id=None):
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
    from engines.claude_agent_sdk import ClaudeAgentSDKEngine
    from engines.claude_code import ClaudeCodeEngine
    from engines.codex import CodexEngine
    from engines.codex_sdk import CodexSDKEngine
    from engines.pydantic_ai import PydanticAIEngine

    assert PydanticAIEngine().capabilities.supports_vision is True
    assert ClaudeCodeEngine().capabilities.supports_vision is True
    assert ClaudeAgentSDKEngine().capabilities.supports_vision is True
    assert CodexEngine().capabilities.supports_vision is False
    assert CodexSDKEngine().capabilities.supports_vision is False
