"""System instruction transport belongs to the ACP adapter seam."""

import pytest

from engines.core.acp_base import AcpEngineBase
from engines.core.events import InternalEvent


class RecordingEngine(AcpEngineBase):
    ENGINE_ID = "recording"

    @staticmethod
    def is_installed():
        return True

    @staticmethod
    def get_version():
        return "test"

    @staticmethod
    def resolve_binary():
        return None

    @property
    def supports_resume(self):
        return True

    async def spawn(self, prompt, cwd, session_id=None, **kwargs):
        self.received = (prompt, kwargs)
        yield InternalEvent(type="done", data={})


@pytest.mark.parametrize("session_id, expected", [(None, "role\n\nquestion"), ("existing", "question")])
async def test_unsupported_engine_injects_only_when_creating_session(session_id, expected):
    engine = RecordingEngine()
    _ = [event async for event in engine.spawn_with_retry(
        prompt="question", cwd="/tmp", session_id=session_id, system_prompt="role",
    )]
    assert engine.received == (expected, {})


async def test_native_adapter_receives_separate_instruction_on_create_and_resume():
    class NativeEngine(RecordingEngine):
        SYSTEM_PROMPT_MODE = "system"

    for session_id in (None, "existing"):
        engine = NativeEngine()
        _ = [event async for event in engine.spawn_with_retry(
            prompt="question", cwd="/tmp", session_id=session_id, system_prompt="role",
        )]
        assert engine.received == ("question", {"system_prompt": "role"})


async def test_empty_instruction_does_not_change_existing_call():
    engine = RecordingEngine()
    _ = [event async for event in engine.spawn_with_retry(
        prompt="question", cwd="/tmp", system_prompt="",
    )]
    assert engine.received == ("question", {})


async def test_retry_resuming_announced_session_does_not_repeat_body_instruction():
    class FailingOnce(RecordingEngine):
        calls = []

        async def spawn(self, prompt, cwd, session_id=None, **kwargs):
            self.calls.append((prompt, session_id))
            if len(self.calls) == 1:
                yield InternalEvent(type="session_started", data={"session_id": "created"})
                yield InternalEvent(type="error", data={"message": "retry"})
            else:
                yield InternalEvent(type="done", data={})

    engine = FailingOnce()
    _ = [event async for event in engine.spawn_with_retry(
        prompt="question", cwd="/tmp", system_prompt="role",
    )]
    assert engine.calls == [("role\n\nquestion", None), ("question", "created")]


async def test_compaction_does_not_receive_system_instruction():
    class CompactEngine(RecordingEngine):
        async def spawn(self, prompt, cwd, session_id=None, **kwargs):
            self.received = (prompt, kwargs)
            yield InternalEvent(type="compacted", data={})

    engine = CompactEngine()
    _ = [event async for event in engine.spawn_with_retry(
        prompt="/compact", cwd="/tmp", session_id="existing", system_prompt="role",
    )]
    assert engine.received == ("/compact", {})


@pytest.mark.parametrize("session_id", [None, "existing"])
@pytest.mark.parametrize("engine_name, package, preset", [
    ("claude_agent_sdk", "claude_agent_sdk", "claude_code"),
    ("qoder_sdk", "qoder_agent_sdk", "qodercli"),
])
@pytest.mark.parametrize("with_image", [False, True])
async def test_sdk_appends_to_native_preset(monkeypatch, tmp_path, engine_name, package, preset, session_id, with_image):
    import asyncio
    import importlib
    import sys
    from types import ModuleType, SimpleNamespace
    from engines.core.base import ProviderRuntimeConfig

    adapter = importlib.import_module(f"engines.{engine_name}")
    engine_cls = adapter.ClaudeAgentSDKEngine if preset == "claude_code" else adapter.QoderSDKEngine
    captured = {}

    class Client:
        def __init__(self, options):
            captured["options"] = options

        async def connect(self):
            pass

        async def query(self, prompt, **kwargs):
            async for item in prompt:
                captured["prompt"] = item["message"]["content"]

        async def receive_messages(self):
            if False:
                yield

        async def disconnect(self):
            pass

    sdk = ModuleType(package)
    options_name = "ClaudeAgentOptions" if preset == "claude_code" else "QoderAgentOptions"
    client_name = "ClaudeSDKClient" if preset == "claude_code" else "QoderSDKClient"
    setattr(sdk, options_name, SimpleNamespace)
    setattr(sdk, client_name, Client)
    sdk.PermissionResultAllow = sdk.PermissionResultDeny = SimpleNamespace
    sdk.access_token = sdk.access_token_from_env = sdk.qodercli_auth = lambda *args: None
    monkeypatch.setitem(sys.modules, package, sdk)
    engine = engine_cls()
    monkeypatch.setattr(engine, "resolve_binary", lambda: "/fake/engine")
    monkeypatch.setattr(engine, "require_native_credentials_allowed", lambda: None)
    monkeypatch.setattr(engine, "project_skills", lambda _cwd: [])
    monkeypatch.setattr(engine, "resolve_provider_runtime", lambda **kw: ProviderRuntimeConfig())
    monkeypatch.setattr(engine, "_sdk_available", lambda: True, raising=False)
    monkeypatch.setattr(adapter.config_store, f"get_{engine_name}_config", lambda: {
        "permission_mode": "default", "personal_access_token": "token", "model": "auto",
        "include_partial_messages": True, "allowed_tools": "", "max_turns": "", "fallback_model": "",
    })
    monkeypatch.setattr("services.skill_runtime.prepare_claude_plugin", lambda _skills: (tmp_path, []))
    monkeypatch.setattr("services.skill_runtime.prepare_qoder_plugin", lambda _skills: (tmp_path, []))
    from engines.core.schema import EngineImage

    images = [EngineImage(url="data:image/png;base64,cGljdHVyZQ==")] if with_image else None
    events = [event async for event in engine.spawn_with_retry(
        prompt="question", cwd=str(tmp_path), system_prompt="channel role",
        live_message_queue=asyncio.Queue(), session_id=session_id, capture_prompt_input=True, images=images,
    )]
    assert not [event for event in events if event.type == "error"]
    if with_image and preset == "claude_code":
        assert captured["prompt"] == [
            {"type": "text", "text": "question"},
            {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "cGljdHVyZQ=="}},
        ]
    elif with_image:
        assert "Attached image(s)" in captured["prompt"]
    else:
        assert captured["prompt"] == "question"
    assert next(e.data for e in events if e.type == "prompt_input")["system_prompt"] == "channel role"
    assert getattr(captured["options"], "resume", None) == session_id
    assert captured["options"].system_prompt == {
        "type": "preset", "preset": preset, "append": "channel role",
    }


@pytest.mark.parametrize("session_id, each_turn", [(None, False), ("existing", False), ("existing", True)])
@pytest.mark.parametrize("entry", ["spawn_with_retry", "spawn_coordinator_with_retry"])
@pytest.mark.parametrize("with_image", [False, True])
@pytest.mark.parametrize("retry", [False, True])
async def test_codex_uses_developer_instructions_and_preserves_base(monkeypatch, tmp_path, session_id, each_turn, entry, with_image, retry):
    import sys
    from types import ModuleType, SimpleNamespace
    from engines.codex_sdk import CodexSDKEngine
    from engines.core.base import ProviderRuntimeConfig

    captured = {}
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    thread_calls = []

    class Turn:
        async def stream(self):
            if False:
                yield

    class Thread:
        id = "existing"

        async def turn(self, prompt, **kwargs):
            captured["turn_count"] = captured.get("turn_count", 0) + 1
            captured["prompt"] = prompt
            if retry and captured["turn_count"] == 1:
                raise RuntimeError("临时失败")
            return Turn()

    class Client:
        def __init__(self, **kwargs):
            pass

        async def thread_start(self, **kwargs):
            captured["kwargs"] = kwargs
            thread_calls.append(kwargs)
            return Thread()

        async def thread_resume(self, _id, **kwargs):
            return await self.thread_start(**kwargs)

        async def close(self):
            pass

    sdk = ModuleType("openai_codex")
    from dataclasses import dataclass

    @dataclass
    class TextInput:
        text: str

    @dataclass
    class LocalImageInput:
        path: str

    @dataclass
    class ImageInput:
        url: str

    sdk.ImageInput = ImageInput
    sdk.TextInput = TextInput
    sdk.LocalImageInput = LocalImageInput
    sdk.AsyncCodex = Client
    sdk.CodexConfig = sdk.AsyncTurnHandle = SimpleNamespace
    sdk.ApprovalMode = lambda value: value
    sdk.Sandbox = SimpleNamespace(read_only="read-only", workspace_write="workspace-write", full_access="full")
    monkeypatch.setitem(sys.modules, "openai_codex", sdk)
    engine = CodexSDKEngine()
    monkeypatch.setattr(engine, "_sdk_available", lambda: True)
    monkeypatch.setattr(engine, "_install_approval_handler", lambda *args: None)
    monkeypatch.setattr(engine, "project_skills", lambda _cwd: [])
    monkeypatch.setattr(engine, "resolve_provider_runtime", lambda **kwargs: ProviderRuntimeConfig())
    monkeypatch.setattr("services.skill_runtime.prepare_codex_skills", lambda _skills: ([], "skills=[]"))
    monkeypatch.setattr("engines.codex_sdk.config_store.get_codex_sdk_config", lambda: {
        "sandbox": "workspace-write", "approval_mode": "", "model_reasoning_effort": "",
        "custom_config": 'developer_instructions="existing rules"',
    })
    from engines.core.schema import EngineImage

    images = [
        EngineImage(path=str(tmp_path / "shot.png"), description="截图"),
        EngineImage(url="data:image/png;base64,cGljdHVyZQ=="),
    ] if with_image else None
    events = [event async for event in getattr(engine, entry)(
        prompt="question", cwd=str(tmp_path), session_id=session_id, system_prompt="channel role",
        capture_prompt_input=True, images=images, system_prompt_each_turn=each_turn,
    )]
    assert not [event for event in events if event.type == "error"]
    assert captured["turn_count"] == (2 if retry else 1)
    if with_image:
        assert captured["prompt"] == [
            TextInput("question"), LocalImageInput(str(tmp_path / "shot.png")),
            ImageInput("data:image/png;base64,cGljdHVyZQ=="),
        ]
    else:
        assert captured["prompt"] == "question"
    snapshots = [e.data for e in events if e.type == "prompt_input"]
    assert len(snapshots) == (2 if retry else 1)
    assert all("base64" not in str(data) for data in snapshots)
    snapshot = snapshots[0]
    assert snapshot["prompt"] == "question"
    assert snapshot["images"] == ([str(tmp_path / "shot.png"), "[内联图片]"] if with_image else [])
    assert len(thread_calls) == len(snapshots)
    for snapshot, call in zip(snapshots, thread_calls):
        if snapshot["session_id"] and not each_turn:
            assert not snapshot["system_prompt"]
            assert "developer_instructions" not in call
            assert "developer_instructions" not in call["config"]
        else:
            assert snapshot["system_prompt"] == "channel role"
            assert call["developer_instructions"] == (
                "<workstep_system_rules>\nexisting rules\n\nchannel role\n</workstep_system_rules>"
            )
        assert "base_instructions" not in call


@pytest.mark.parametrize("custom_spawner", [False, True])
async def test_assistant_transport_preserves_separate_instruction(custom_spawner):
    from types import SimpleNamespace
    from agent_assistants.engine_invocation import run_engine_turn

    class NativeEngine(RecordingEngine):
        SYSTEM_PROMPT_MODE = "system"

    engine = NativeEngine()

    def spawn(selected, *, config_overrides, system_prompt):
        return selected.spawn_coordinator_with_retry(
            prompt="question", cwd="/tmp", system_prompt=system_prompt,
        )

    await run_engine_turn(
        "recording", None, "/tmp", "question", None,
        engine_factory=lambda _id: engine, settings_store=SimpleNamespace(),
        system_prompt="role", spawner=spawn if custom_spawner else None,
    )
    prompt, kwargs = engine.received
    assert "role" not in prompt
    assert kwargs["system_prompt"] == "role"


@pytest.mark.parametrize("mode", ["body", "system", "developer"])
async def test_per_turn_instruction_snapshot_matches_adapter_arguments(mode):
    class Engine(RecordingEngine):
        SYSTEM_PROMPT_MODE = mode

    engine = Engine()
    events = [event async for event in engine.spawn_with_retry(
        prompt="hello", cwd="/tmp", session_id="existing",
        system_prompt="sender: second", system_prompt_each_turn=True,
    )]
    expected_prompt = "sender: second\n\nhello" if mode == "body" else "hello"
    assert engine.received == (expected_prompt, {} if mode == "body" else {"system_prompt": "sender: second"})
    snapshot = next(event.data for event in events if event.type == "prompt_input")
    assert snapshot["prompt"] == expected_prompt
    assert snapshot["system_prompt"] == (None if mode == "body" else "sender: second")
    assert snapshot["system_prompt_in_body"] == (mode == "body")
    assert snapshot["instruction_transport"] == mode
    assert snapshot["session_id"] == "existing"


async def test_snapshot_records_both_retry_attempts():
    class Retry(RecordingEngine):
        async def spawn(self, prompt, cwd, session_id=None, **kwargs):
            if not session_id:
                yield InternalEvent(type="session_started", data={"session_id": "created"})
                yield InternalEvent(type="error", data={"message": "retry"})
            else:
                yield InternalEvent(type="done", data={})
    events = [event async for event in Retry().spawn_with_retry(
        prompt="hello", cwd="/tmp", system_prompt="sender", system_prompt_each_turn=True,
    )]
    snapshots = [event.data for event in events if event.type == "prompt_input"]
    assert [data["attempt"] for data in snapshots] == [1, 2]
    assert [data["session_id"] for data in snapshots] == [None, "created"]
    assert all(data["prompt"] == "sender\n\nhello" for data in snapshots)


async def test_channel_turn_policy_reaches_unified_retry_entry():
    from types import SimpleNamespace
    from agent_assistants.engine_invocation import run_engine_turn
    engine = RecordingEngine()
    seen = []
    async def receive(event):
        seen.append(event)
    await run_engine_turn(
        "recording", None, "/tmp", "hello", "existing", receive,
        engine_factory=lambda _id: engine, settings_store=SimpleNamespace(),
        system_prompt="new sender", system_prompt_each_turn=True,
    )
    assert engine.received == ("new sender\n\nhello", {"model": None})
    assert any(event.type == "prompt_input" for event in seen)


async def test_compaction_snapshot_shows_command_without_background():
    class Compact(RecordingEngine):
        async def spawn(self, prompt, cwd, session_id=None, **kwargs):
            self.received = (prompt, kwargs)
            yield InternalEvent(type="compacted", data={})
    engine = Compact()
    events = [event async for event in engine.spawn_with_retry(
        prompt="/compact", cwd="/tmp", session_id="existing",
        system_prompt="sender", system_prompt_each_turn=True,
    )]
    assert engine.received == ("/compact", {})
    snapshot = next(event.data for event in events if event.type == "prompt_input")
    assert snapshot["prompt"] == "/compact"
    assert snapshot["system_prompt"] is None


async def test_inspection_does_not_repeat_fixed_body_rules_on_resume():
    engine = RecordingEngine()
    events = [event async for event in engine.spawn_with_retry(
        prompt="second", cwd="/tmp", session_id="existing",
        system_prompt="stable global rules", capture_prompt_input=True,
    )]
    assert engine.received == ("second", {})
    snapshot = next(event.data for event in events if event.type == "prompt_input")
    assert snapshot["prompt"] == "second"
    assert snapshot["system_prompt"] is None
    assert snapshot["system_prompt_in_body"] is False


async def test_coordinator_transport_does_not_add_rules_to_assistant_instructions():
    engine = RecordingEngine()
    engine.SYSTEM_PROMPT_MODE = "system"
    events = [event async for event in engine.spawn_coordinator_with_retry(
        prompt="question", cwd="/tmp", system_prompt="assistant rules",
        workstep_tools=True, capture_prompt_input=True,
    )]
    assert events[0].data["system_prompt"] == "assistant rules"
    assert engine.received[0] == "question"


@pytest.mark.parametrize("session_id, supports_resume, each_turn, expected", [
    (None, True, False, "current rules"),
    ("existing", True, False, ""),
    ("existing", True, True, "current rules"),
    ("existing", False, False, "current rules"),
])
async def test_codex_instruction_injection_uses_resume_capability_without_io(
    monkeypatch, tmp_path, session_id, supports_resume, each_turn, expected,
):
    from pathlib import Path
    from engines.codex_sdk import CodexSDKEngine

    def unexpected_io(*args, **kwargs):
        raise AssertionError("Preparing instructions must not read config or native session logs")

    monkeypatch.setattr(Path, "rglob", unexpected_io)
    monkeypatch.setattr(Path, "open", unexpected_io)
    monkeypatch.setattr("engines.codex_sdk.config_store.get_codex_sdk_config", unexpected_io)
    monkeypatch.setattr(CodexSDKEngine, "supports_resume", property(lambda self: supports_resume))
    kwargs = {"prompt": "next", "cwd": str(tmp_path), "session_id": session_id}
    for _ in range(3):
        # Rebuilding the adapter must not require logs or a process-local cache.
        prepared = await CodexSDKEngine()._prepare_prompt_input(kwargs, "current rules", each_turn=each_turn)
        assert prepared["system_prompt"] == expected
        assert prepared["prompt"] == "next"
        assert prepared["session_id"] == session_id
    assert "system_prompt" not in kwargs


async def test_codex_compact_does_not_set_instructions():
    from engines.codex_sdk import CodexSDKEngine

    kwargs = {"prompt": "/compact", "cwd": "/tmp", "session_id": "existing"}
    prepared = await CodexSDKEngine()._prepare_prompt_input(kwargs, "current rules", each_turn=True)
    assert prepared == kwargs
