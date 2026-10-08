"""DeepSeek Harness SDK 引擎契约。"""

import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from engines.core.base import EngineCapabilities
from engines.deepseek_harness import DeepSeekHarnessEngine


def notification(method: str, payload: dict):
    return SimpleNamespace(method=method, payload=payload)


async def test_spawn_slow_project_resolution_keeps_event_loop_responsive(
    monkeypatch, tmp_path, deepseek_provider,
):
    import threading
    import time

    class Harness:
        def start(self):
            pass

        def run(self, *args, **kwargs):
            return SimpleNamespace(finish_reason="completed")

        def close(self):
            pass

    monkeypatch.setattr(DeepSeekHarnessEngine, "is_installed", staticmethod(lambda: True))
    monkeypatch.setattr("engines.deepseek_harness.config_store.get_deepseek_harness_config",
                        lambda: {"provider_id": deepseek_provider["id"]})
    monkeypatch.setattr("engines.deepseek_harness.config_store.get_provider", lambda _: deepseek_provider)
    monkeypatch.setattr(DeepSeekHarnessEngine, "_build_harness", lambda *a, **kw: Harness())
    original = Path.resolve
    entered, release = threading.Event(), threading.Event()
    loop_thread = threading.get_ident()
    threads = []

    def slow_resolve(path, *args, **kwargs):
        if path == tmp_path and not entered.is_set():
            threads.append(threading.get_ident())
            entered.set()
            release.wait(2)
        return original(path, *args, **kwargs)

    monkeypatch.setattr(Path, "resolve", slow_resolve)

    async def collect():
        return [event async for event in DeepSeekHarnessEngine().spawn("go", str(tmp_path))]

    started = time.monotonic()
    pending = asyncio.create_task(collect())
    try:
        assert await asyncio.to_thread(entered.wait, 1)
        await asyncio.sleep(0.01)
        assert time.monotonic() - started < 0.5
        assert threads[0] != loop_thread
    finally:
        release.set()
        events = await pending
    assert not any(event.type == "error" for event in events)


@pytest.fixture(autouse=True)
def _clean_harness_pool():
    DeepSeekHarnessEngine.shutdown_pool()
    yield
    DeepSeekHarnessEngine.shutdown_pool()


@pytest.fixture
def deepseek_provider():
    return {
        "id": "deepseek-official",
        "name": "DeepSeek 官方",
        "type": "deepseek",
        "base_url": "https://api.deepseek.com",
        "api_key": "secret",
        "enabled": True,
    }


def test_deepseek_harness_declares_sdk_install_and_safe_capabilities(monkeypatch):
    monkeypatch.setattr(DeepSeekHarnessEngine, "is_configured", staticmethod(lambda: True))

    assert DeepSeekHarnessEngine.install_command() == (
        "pip install deepseek-harness-sdk==0.1.5rc1"
    )
    assert DeepSeekHarnessEngine().capabilities == EngineCapabilities(
        supports_coordinator=True,
        supports_resume=True,
        supports_tool_disable=False,
        supports_native_schema=False,
        supports_live_step_message=True,
        supports_sessions=True,
        supports_tool_approval=False,
        supports_vision=False,
        supports_workstep_tools=False,
        supports_thinking_effort=False,
    )


def test_deepseek_harness_config_only_accepts_enabled_deepseek_provider(
    monkeypatch,
    deepseek_provider,
):
    saved = {}
    monkeypatch.setattr(
        "engines.deepseek_harness.config_store.get_provider",
        lambda provider_id: deepseek_provider if provider_id == deepseek_provider["id"] else None,
    )
    monkeypatch.setattr(
        "engines.deepseek_harness.config_store.get_deepseek_harness_config",
        lambda: {
            "provider_id": "",
            "model": "deepseek-v4-flash",
            "max_tokens": "",
            "preset": "standard",
        },
    )
    monkeypatch.setattr(
        "engines.deepseek_harness.config_store.set_deepseek_harness_config",
        lambda **values: saved.update(values),
    )

    engine = DeepSeekHarnessEngine()
    asyncio.run(engine.save_config_values({"provider_id": "deepseek-official"}))

    assert saved == {
        "provider_id": "deepseek-official",
        "model": "deepseek-v4-flash",
        "max_tokens": "",
        "preset": "standard",
    }

    deepseek_provider["type"] = "openai"
    with pytest.raises(ValueError, match="DeepSeek"):
        asyncio.run(engine.save_config_values({"provider_id": "deepseek-official"}))


def test_deepseek_harness_is_configured_requires_provider_credentials(
    monkeypatch,
    deepseek_provider,
):
    monkeypatch.setattr(
        "engines.deepseek_harness.config_store.get_deepseek_harness_config",
        lambda: {"provider_id": "deepseek-official", "model": "deepseek-v4-flash"},
    )
    monkeypatch.setattr(
        "engines.deepseek_harness.config_store.get_provider",
        lambda _provider_id: deepseek_provider,
    )

    assert DeepSeekHarnessEngine.is_configured() is True
    deepseek_provider["api_key"] = ""
    assert DeepSeekHarnessEngine.is_configured() is False


def test_deepseek_harness_uses_workstep_standard_composition(
    monkeypatch,
    tmp_path,
    deepseek_provider,
):
    captured = {}

    class FakeHarness:
        def start(self):
            pass

        def __init__(self, **kwargs):
            captured.update(kwargs)

    monkeypatch.setitem(
        sys.modules,
        "deepseek_harness",
        SimpleNamespace(DeepSeekHarness=FakeHarness, DeepSeekHarnessConfig=LegacyConfig),
    )

    engine = DeepSeekHarnessEngine()
    engine._build_harness(
        cwd=str(tmp_path),
        provider=deepseek_provider,
        model="deepseek-v4-flash",
        max_tokens=None,
        preset="standard",
    )

    composition = captured["cordis"]
    assert composition.endswith(".workstep/runtime/deepseek/controlled-skills.cordis.yml")
    controlled = Path(composition).read_text(encoding="utf-8")
    assert "includeDefaultRoots: false" in controlled
    assert str(tmp_path / ".workstep" / "skills") in controlled
    assert captured["provider"] == "deepseek-official"
    assert captured["cwd"] == str(tmp_path)


def test_deepseek_harness_rejects_unknown_preset(
    tmp_path,
    deepseek_provider,
):
    with pytest.raises(ValueError, match="preset"):
        DeepSeekHarnessEngine()._build_harness(
            cwd=str(tmp_path),
            provider=deepseek_provider,
            model="deepseek-v4-flash",
            max_tokens=None,
            preset="code",
        )


def test_deepseek_harness_maps_stream_tool_usage_plan_and_compaction():
    engine = DeepSeekHarnessEngine()

    text = engine._map_notification(notification("session.event", {
        "sessionId": "root",
        "event": {"type": "assistant/chunk", "data": {
            "turn": 1,
            "step": 2,
            "chunk": {"type": "text-delta", "index": 0, "text": "你好"},
        }},
    }), "root")
    thought = engine._map_notification(notification("session.event", {
        "sessionId": "root",
        "event": {"type": "assistant/chunk", "data": {
            "turn": 1,
            "step": 2,
            "chunk": {"type": "reasoning-delta", "index": 1, "text": "思考"},
        }},
    }), "root")
    call = engine._map_notification(notification("session.event", {
        "sessionId": "root",
        "event": {"type": "tool/call", "data": {
            "callId": "call-1", "name": "read", "arguments": '{"path":"a.py"}',
        }},
    }), "root")
    result = engine._map_notification(notification("session.event", {
        "sessionId": "root",
        "event": {"type": "tool/result", "data": {
            "message": {
                "content": [{"type": "text", "text": "ok"}],
                "source": {"kind": "tool", "callId": "call-1"},
            },
            "isError": False,
        }},
    }), "root")
    message = engine._map_notification(notification("session.event", {
        "sessionId": "root",
        "event": {"type": "assistant/message", "data": {
            "turn": 1,
            "step": 2,
            "message": {"content": [{"type": "text", "text": "你好"}]},
            "usage": {"inputTokens": 10, "outputTokens": 3},
        }},
    }), "root")
    plan = engine._map_notification(notification("session.event", {
        "sessionId": "root",
        "event": {"type": "todo/write", "data": {"todos": [
            {"content": "读代码", "status": "in_progress"},
            {"content": "写测试", "status": "pending"},
        ]}},
    }), "root")
    compacted = engine._map_notification(notification("session.event", {
        "sessionId": "root",
        "event": {"type": "compaction/summary", "data": {
            "summary": [{"type": "text", "text": "已压缩历史"}],
        }},
    }), "root")

    assert [(event.type, event.data) for event in text] == [
        ("agent_message_chunk", {"content": {"text": "你好"}}),
    ]
    assert thought[0].type == "agent_thought_chunk"
    assert call[0].data == {
        "tool_call_id": "call-1",
        "title": "read",
        "kind": "other",
        "raw_input": {"path": "a.py"},
    }
    assert result[0].data == {
        "tool_call_id": "call-1",
        "status": "completed",
        "raw_output": "ok",
    }
    assert [event.type for event in message] == ["usage_update"]
    assert message[0].data["input_tokens"] == 10
    assert message[0].data["output_tokens"] == 3
    assert message[0].data["used"] == 13
    assert plan[0].type == "plan"
    assert [entry["status"] for entry in plan[0].data["entries"]] == [
        "in_progress", "pending",
    ]
    assert compacted[0].data == {"summary": "已压缩历史"}


def test_deepseek_harness_keeps_root_text_separate_from_subagents_and_unknown_events():
    engine = DeepSeekHarnessEngine()

    child_message = engine._map_notification(notification("session.event", {
        "sessionId": "child",
        "event": {"type": "assistant/chunk", "data": {
            "chunk": {"type": "text-delta", "index": 0, "text": "child text"},
        }},
    }), "root")
    started = engine._map_notification(notification("subagent.started", {
        "parentSessionId": "root", "childSessionId": "child",
    }), "root")
    unknown = engine._map_notification(notification("session.event", {
        "sessionId": "root",
        "event": {"type": "future/event", "data": {"value": 1}},
    }), "root")

    assert child_message == []
    assert started[0].type == "subagent"
    assert started[0].data == {
        "task_id": "child",
        "status": "running",
        "stage": "started",
        "description": "DeepSeek Harness 子代理 child",
    }
    assert unknown[0].type == "acp_raw"
    assert unknown[0].data["type"] == "future/event"


def test_deepseek_harness_surfaces_terminal_provider_error():
    engine = DeepSeekHarnessEngine()
    events = engine._map_notification(notification("session.event", {
        "sessionId": "root",
        "event": {"type": "turn/end", "data": {"reason": {
            "kind": "error",
            "error": {"code": "AUTH", "message": "API key is invalid"},
        }}},
    }), "root")

    assert [(event.type, event.data) for event in events] == [
        ("error", {"message": "API key is invalid", "code": "AUTH"}),
    ]


def test_deepseek_harness_spawn_streams_notifications_and_reuses_session(
    monkeypatch,
    tmp_path,
    deepseek_provider,
):
    captured = {}

    class FakeHarness:
        def start(self):
            pass

        def run(self, prompt, *, session_id, on_notification):
            captured.update(prompt=prompt, session_id=session_id)
            on_notification(notification("session.event", {
                "sessionId": session_id,
                "event": {"type": "assistant/chunk", "data": {
                    "turn": 0, "step": 0,
                    "chunk": {"type": "text-delta", "index": 0, "text": "完成"},
                }},
            }))
            return SimpleNamespace(finish_reason="completed")

        def close(self):
            captured["closed"] = True

    monkeypatch.setattr(
        "engines.deepseek_harness.config_store.get_deepseek_harness_config",
        lambda: {"provider_id": "deepseek-official", "model": "deepseek-v4-flash", "max_tokens": "4096"},
    )
    monkeypatch.setattr(
        "engines.deepseek_harness.config_store.get_provider",
        lambda _provider_id: deepseek_provider,
    )
    monkeypatch.setattr(
        DeepSeekHarnessEngine,
        "_build_harness",
        lambda self, **kwargs: captured.update(kwargs) or FakeHarness(),
    )
    monkeypatch.setattr(DeepSeekHarnessEngine, "is_installed", staticmethod(lambda: True))

    async def collect():
        return [
            event
            async for event in DeepSeekHarnessEngine().spawn(
                "修复测试",
                str(tmp_path),
                session_id="session-existing",
            )
        ]

    events = asyncio.run(collect())

    # 池化后 spawn 结束不再关闭 harness（留给同项目下一轮复用），
    # 关闭只发生在 stop()/lifespan shutdown。
    assert captured == {
        "cwd": str(tmp_path),
        "provider": deepseek_provider,
        "model": "deepseek-v4-flash",
        "max_tokens": 4096,
        "preset": "standard",
        "prompt": "修复测试",
        "session_id": "session-existing",
    }
    assert "closed" not in captured
    assert [event.type for event in events] == [
        "status", "session_started", "status", "agent_message_chunk", "status",
    ]
    assert events[0].data["status"] == "initializing"
    assert events[1].data["session_id"] == "session-existing"
    assert events[-1].data["status"] == "done"
    DeepSeekHarnessEngine.shutdown_pool()


def test_deepseek_harness_spawn_reports_sdk_failure(monkeypatch, tmp_path, deepseek_provider):
    class BrokenHarness:
        def start(self):
            pass

        def run(self, *_args, **_kwargs):
            raise RuntimeError("runtime crashed")

        def close(self):
            return None

    monkeypatch.setattr(
        "engines.deepseek_harness.config_store.get_deepseek_harness_config",
        lambda: {"provider_id": "deepseek-official", "model": "deepseek-v4-flash", "max_tokens": ""},
    )
    monkeypatch.setattr(
        "engines.deepseek_harness.config_store.get_provider",
        lambda _provider_id: deepseek_provider,
    )
    monkeypatch.setattr(
        DeepSeekHarnessEngine,
        "_build_harness",
        lambda self, **_kwargs: BrokenHarness(),
    )
    monkeypatch.setattr(DeepSeekHarnessEngine, "is_installed", staticmethod(lambda: True))

    async def collect():
        return [event async for event in DeepSeekHarnessEngine().spawn("go", str(tmp_path))]

    events = asyncio.run(collect())
    assert events[-1].type == "error"
    assert events[-1].data["message"] == "runtime crashed"


# --- 两代 SDK 的 config 签名兼容 ----------------------------------------------
# 0.1.0rc7 世代：session_root / cordis / runtime_bin；
# >= 0.1.5rc1 世代：dsh_home / patches / dsh_bin。

import importlib  # noqa: E402
from dataclasses import dataclass, field  # noqa: E402
from types import ModuleType  # noqa: E402

from services.skill_center import ProjectSkillSelection  # noqa: E402


@dataclass
class LegacyConfig:
    """0.1.0rc7 世代签名（session_root / cordis / runtime_bin）。"""

    provider: str = "deepseek-official"
    model: str = "deepseek-v4-flash"
    max_tokens: int | None = None
    cwd: str | None = None
    runtime_cwd: str | None = None
    session_root: str | None = None
    cordis: str | None = None
    env: dict = field(default_factory=dict)
    runtime_bin: str | None = None
    launch_args_override: tuple | None = None
    request_timeout_seconds: float | None = None
    shutdown_timeout_seconds: float = 1.0
    base_url: str | None = None
    api_key: str | None = None


@dataclass
class ModernConfig:
    """>= 0.1.5rc1 世代签名（dsh_home / patches / dsh_bin）。"""

    provider: str = "deepseek-official"
    model: str = "deepseek-v4-flash"
    reasoning_effort: str | None = None
    max_tokens: int | None = None
    cwd: str | None = None
    runtime_cwd: str | None = None
    dsh_bin: str | None = None
    profile: str = "sdk"
    patches: tuple = ()
    dsh_home: str | None = None
    env: dict = field(default_factory=dict)
    initialize_timeout_seconds: float = 30.0
    request_timeout_seconds: float | None = None
    shutdown_timeout_seconds: float = 1.0
    base_url: str | None = None
    api_key: str | None = None


@dataclass
class UnknownConfig:
    """两代参数都不带的签名（用于回归保护）。"""

    provider: str = "deepseek-official"
    model: str = "deepseek-v4-flash"
    env: dict = field(default_factory=dict)


class _HarnessRecorder:
    """记录 DeepSeekHarness 构造参数的桩。"""

    last_kwargs: dict | None = None

    def __init__(self, **kwargs):
        type(self).last_kwargs = dict(kwargs)


def _install_sdk_stub(monkeypatch, config_class) -> None:
    """把带指定 config 签名的 fake deepseek_harness 模块注入 sys.modules。

    引擎在 ``_build_harness`` 内部才 import SDK（函数级导入），因此无需
    reload 引擎模块；monkeypatch 会在测试结束后还原 sys.modules。
    """
    module = ModuleType("deepseek_harness")
    module.DeepSeekHarnessConfig = config_class
    module.DeepSeekHarness = _HarnessRecorder
    monkeypatch.setitem(sys.modules, "deepseek_harness", module)
    _HarnessRecorder.last_kwargs = None


PROVIDER = {
    "id": "prov-deepseek",
    "type": "deepseek",
    "name": "DeepSeek",
    "base_url": "https://api.deepseek.com",
    "api_key": "sk-test",
    "enabled": True,
}


def _selection(project_root) -> ProjectSkillSelection:
    return ProjectSkillSelection(
        project_root=project_root,
        skills=(),
        enabled=(),
        disabled_source_paths=(),
    )


def _build(monkeypatch, tmp_path, config_class, binary_override: str | None = None):
    _install_sdk_stub(monkeypatch, config_class)
    engine = DeepSeekHarnessEngine()
    monkeypatch.setattr(
        DeepSeekHarnessEngine,
        "project_skills",
        lambda self, cwd: _selection(Path(cwd)),
    )
    override = binary_override if binary_override is not None else None
    monkeypatch.setattr(
        DeepSeekHarnessEngine,
        "get_binary_override",
        classmethod(lambda cls: override),
    )
    harness = engine._build_harness(
        cwd=str(tmp_path),
        provider=PROVIDER,
        model="deepseek-v4-flash",
        max_tokens=None,
        preset="standard",
    )
    assert isinstance(harness, _HarnessRecorder)
    return _HarnessRecorder.last_kwargs


def test_build_harness_modern_sdk_uses_dsh_home_and_patches(monkeypatch, tmp_path):
    kwargs = _build(monkeypatch, tmp_path, ModernConfig)
    expected_home = tmp_path / ".workstep" / "deepseek-harness"
    assert kwargs["dsh_home"] == str(expected_home)
    assert expected_home.is_dir()
    assert isinstance(kwargs["patches"], tuple) and len(kwargs["patches"]) == 1
    patch_path = tmp_path / ".workstep" / "runtime" / "deepseek" / "controlled-skills.workstep-patch.yml"
    assert kwargs["patches"][0] == str(patch_path)
    patch_text = patch_path.read_text(encoding="utf-8")
    assert "includeDefaultRoots: false" in patch_text
    assert str(tmp_path / ".workstep" / "skills") in patch_text
    # 旧世代参数不得传给新 SDK（会触发 unexpected keyword argument）。
    for legacy in ("session_root", "cordis", "runtime_bin"):
        assert legacy not in kwargs
    # 两代共享的参数原样透传。
    assert kwargs["provider"] == "deepseek-official"
    assert kwargs["model"] == "deepseek-v4-flash"
    assert kwargs["cwd"] == str(tmp_path.resolve())
    assert kwargs["runtime_cwd"] == str(tmp_path.resolve())
    assert kwargs["api_key"] == "sk-test"
    assert kwargs["base_url"]


def test_build_harness_legacy_sdk_uses_session_root_and_cordis(monkeypatch, tmp_path):
    kwargs = _build(monkeypatch, tmp_path, LegacyConfig)
    expected_root = tmp_path / ".workstep" / "deepseek-harness" / "sessions"
    assert kwargs["session_root"] == str(expected_root)
    assert expected_root.is_dir()
    composition = tmp_path / ".workstep" / "runtime" / "deepseek" / "controlled-skills.cordis.yml"
    assert kwargs["cordis"] == str(composition)
    composition_text = composition.read_text(encoding="utf-8")
    assert "includeDefaultRoots: false" in composition_text
    assert str(tmp_path / ".workstep" / "skills") in composition_text
    for modern in ("dsh_home", "patches", "dsh_bin"):
        assert modern not in kwargs


def test_build_harness_binary_override_follows_generation(monkeypatch, tmp_path):
    modern = _build(monkeypatch, tmp_path, ModernConfig, binary_override="/bin/dsh-override")
    assert modern["dsh_bin"] == "/bin/dsh-override"
    assert "runtime_bin" not in modern
    legacy = _build(monkeypatch, tmp_path, LegacyConfig, binary_override="/bin/dsh-override")
    assert legacy["runtime_bin"] == "/bin/dsh-override"
    assert "dsh_bin" not in legacy


def test_build_harness_unknown_generation_raises(monkeypatch, tmp_path):
    with pytest.raises(RuntimeError, match="Unsupported DeepSeek Harness SDK"):
        _build(monkeypatch, tmp_path, UnknownConfig)


def test_install_surface_pins_latest_sdk():
    assert DeepSeekHarnessEngine.SDK_PACKAGE == "deepseek-harness-sdk==0.1.5rc1"
    assert DeepSeekHarnessEngine.RUNTIME_PACKAGE.kind == "pypi"
    assert DeepSeekHarnessEngine.RUNTIME_PACKAGE.default_version == "0.1.5rc1"
    # 适配器保留对 0.1.0rc7 世代的最低兼容线。
    assert DeepSeekHarnessEngine.RUNTIME_PACKAGE.minimum == "0.1.0rc7"
    assert DeepSeekHarnessEngine.install_command() == f"pip install {DeepSeekHarnessEngine.SDK_PACKAGE}"


def test_preset_templates_ship():
    standard = DeepSeekHarnessEngine.PRESET_COMPOSITIONS["standard"]
    assert standard.is_file(), f"missing composition template: {standard}"
    assert "workspaceContext" in standard.read_text(encoding="utf-8")
    patch = DeepSeekHarnessEngine.PRESET_PATCHES["standard"]
    assert patch.is_file(), f"missing patch template: {patch}"
    patch_text = patch.read_text(encoding="utf-8")
    assert "<WORKSTEP_SKILL_DIRS>" in patch_text
    assert "skill-filesystem" in patch_text


# --- 会话记忆：池化复用 + 结构化错误分类 --------------------------------------

from engines.deepseek_harness import _is_session_exists_error  # noqa: E402


class _JsonRpcErrorStub(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def test_session_exists_classifier_uses_structured_code():
    # SDK 0.1.5rc1 实测形状：code -32603 + 精确 message。
    assert _is_session_exists_error(
        _JsonRpcErrorStub(-32603, 'session "session-abc" already exists')
    ) is True
    # 同 code 但无关 message：不是会话冲突。
    assert _is_session_exists_error(
        _JsonRpcErrorStub(-32603, "provider exploded")
    ) is False
    # 其它 code：不是会话冲突。
    assert _is_session_exists_error(
        _JsonRpcErrorStub(-32000, 'session "session-abc" already exists')
    ) is False
    # turn 内错误携带 "not found"（如工具返回 file not found）绝不能误判。
    assert _is_session_exists_error(RuntimeError("tool result: file not found")) is False
    assert _is_session_exists_error(RuntimeError("reader not found: foo")) is False
    # 老世代 SDK 无 code 属性：只认持久化层冲突原文。
    assert _is_session_exists_error(RuntimeError("id collision on log")) is True
    assert _is_session_exists_error(
        RuntimeError("session already has a persisted log")
    ) is True


def test_spawn_reuses_pooled_harness_across_turns(monkeypatch, tmp_path, deepseek_provider):
    """同项目连续两轮 spawn 必须复用同一 harness 实例（同进程 resume 即记忆）。

    回归：此前每轮新建 SDK server 进程，跨进程 resume 报 AlreadyExists，
    每轮都被迫回退到全新会话导致记忆丢失。
    """
    built = []

    class FakeHarness:
        def start(self):
            pass

        def run(self, prompt, *, session_id, on_notification):
            return SimpleNamespace(finish_reason="completed")

        def close(self):
            built.append("closed")

    def _build(self, **kwargs):
        harness = FakeHarness()
        built.append(harness)
        return harness

    monkeypatch.setattr(
        "engines.deepseek_harness.config_store.get_deepseek_harness_config",
        lambda: {"provider_id": "deepseek-official", "model": "deepseek-v4-flash", "max_tokens": ""},
    )
    monkeypatch.setattr(
        "engines.deepseek_harness.config_store.get_provider",
        lambda _provider_id: deepseek_provider,
    )
    monkeypatch.setattr(DeepSeekHarnessEngine, "_build_harness", _build)
    monkeypatch.setattr(DeepSeekHarnessEngine, "is_installed", staticmethod(lambda: True))

    async def two_turns():
        first = [
            event async for event in DeepSeekHarnessEngine().spawn(
                "你好", str(tmp_path), session_id="session-keep"
            )
        ]
        second = [
            event async for event in DeepSeekHarnessEngine().spawn(
                "我上一句问啥", str(tmp_path), session_id="session-keep"
            )
        ]
        return first, second

    first, second = asyncio.run(two_turns())
    harnesses = [item for item in built if not isinstance(item, str)]
    assert len(harnesses) == 1, f"expected one pooled harness, built {len(built)}"
    assert "closed" not in built
    assert [e.type for e in first if e.type == "session_started"] == ["session_started"]
    assert first[1].data["session_id"] == "session-keep"
    assert second[1].data["session_id"] == "session-keep"
    # 无 session_fallback：第二轮真正带上了同一会话。
    assert all(
        e.data.get("status") != "session_fallback" for e in second if e.type == "status"
    )


def test_spawn_reports_tool_error_without_replacing_session(
    monkeypatch, tmp_path, deepseek_provider
):
    """工具错误直接报错，不更换会话 ID。"""
    calls = []

    class FlakyHarness:
        def start(self):
            pass

        def run(self, prompt, *, session_id, on_notification):
            calls.append(session_id)
            if len(calls) == 1:
                raise RuntimeError('tool "bash" failed: file not found')
            return SimpleNamespace(finish_reason="completed")

        def close(self):
            return None

    monkeypatch.setattr(
        "engines.deepseek_harness.config_store.get_deepseek_harness_config",
        lambda: {"provider_id": "deepseek-official", "model": "deepseek-v4-flash", "max_tokens": ""},
    )
    monkeypatch.setattr(
        "engines.deepseek_harness.config_store.get_provider",
        lambda _provider_id: deepseek_provider,
    )
    monkeypatch.setattr(
        DeepSeekHarnessEngine, "_build_harness", lambda self, **_k: FlakyHarness()
    )
    monkeypatch.setattr(DeepSeekHarnessEngine, "is_installed", staticmethod(lambda: True))

    async def collect():
        return [
            event async for event in DeepSeekHarnessEngine().spawn(
                "go", str(tmp_path), session_id="session-keep"
            )
        ]

    events = asyncio.run(collect())
    # "file not found" 不再误判为会话丢失：直接报错，不开新会话。
    assert calls == ["session-keep"]
    assert events[-1].type == "error"
    assert "file not found" in events[-1].data["message"]


def _configure_spawn(monkeypatch, provider, build):
    monkeypatch.setattr(
        "engines.deepseek_harness.config_store.get_deepseek_harness_config",
        lambda: {"provider_id": provider["id"], "model": "deepseek-v4-flash", "max_tokens": ""},
    )
    monkeypatch.setattr(
        "engines.deepseek_harness.config_store.get_provider", lambda _: provider,
    )
    monkeypatch.setattr(DeepSeekHarnessEngine, "is_installed", staticmethod(lambda: True))
    monkeypatch.setattr(DeepSeekHarnessEngine, "_build_harness", build)


async def test_model_interleaving_keeps_original_session_runtime(
    monkeypatch, tmp_path, deepseek_provider,
):
    built = []

    class Harness:
        def __init__(self, model):
            self.model, self.closed, self.sessions = model, False, set()

        def start(self):
            pass

        def run(self, prompt, *, session_id, on_notification):
            assert not self.closed
            self.sessions.add(session_id)
            return SimpleNamespace(finish_reason="completed")

        def close(self):
            self.closed = True

    def build(self, **kwargs):
        harness = Harness(kwargs["model"])
        built.append(harness)
        return harness

    _configure_spawn(monkeypatch, deepseek_provider, build)
    for model, sid in [("model-a", "session-a"), ("model-b", "session-b"),
                       ("model-a", "session-a")]:
        events = [event async for event in DeepSeekHarnessEngine().spawn(
            "go", str(tmp_path), model=model, session_id=sid,
        )]
        assert not any(event.type == "error" for event in events)
    assert len(built) == 2
    assert all(not harness.closed for harness in built)


@pytest.mark.parametrize("in_stream", [False, True])
async def test_session_conflict_preserves_id_and_does_not_run_empty_session(
    monkeypatch, tmp_path, deepseek_provider, in_stream,
):
    calls = []

    class Harness:
        def start(self):
            pass

        def run(self, prompt, *, session_id, on_notification):
            calls.append(session_id)
            message = f'session "{session_id}" already exists'
            if not in_stream:
                raise _JsonRpcErrorStub(-32603, message)
            on_notification(notification("session.event", {
                "sessionId": session_id,
                "event": {"type": "turn/end", "data": {
                    "reason": {"kind": "error", "error": {"message": message}},
                }},
            }))
            return SimpleNamespace(finish_reason="error")

        def close(self):
            pass

    _configure_spawn(monkeypatch, deepseek_provider, lambda self, **_: Harness())
    events = [event async for event in DeepSeekHarnessEngine().spawn(
        "go", str(tmp_path), session_id="session-keep",
    )]
    assert calls == ["session-keep"]
    assert [event.data["session_id"] for event in events
            if event.type == "session_started"] == ["session-keep"]
    errors = [event for event in events if event.type == "error"]
    assert len(errors) == 1
    assert "session-keep" in errors[0].data["message"]
    assert "恢复" in errors[0].data["message"]
    assert not any(event.data.get("status") in {"done", "session_fallback"}
                   for event in events)


async def test_slow_runtime_fingerprint_keeps_event_loop_responsive(
    monkeypatch, tmp_path, deepseek_provider,
):
    import threading

    entered, release = threading.Event(), threading.Event()
    main_thread = threading.get_ident()
    threads = []

    def fingerprint(**kwargs):
        threads.append(threading.get_ident())
        entered.set()
        assert release.wait(2)
        return "fingerprint"

    class Harness:
        def start(self):
            pass

        def run(self, *args, **kwargs):
            return SimpleNamespace(finish_reason="completed")

        def close(self):
            pass

    _configure_spawn(monkeypatch, deepseek_provider, lambda self, **_: Harness())
    monkeypatch.setattr(DeepSeekHarnessEngine, "_pool_fingerprint", staticmethod(fingerprint))

    async def collect():
        return [event async for event in DeepSeekHarnessEngine().spawn("go", str(tmp_path))]

    pending = asyncio.create_task(collect())
    try:
        assert await asyncio.to_thread(entered.wait, 1)
        assert threads != [main_thread]
        await asyncio.wait_for(asyncio.sleep(0), 0.2)
    finally:
        release.set()
        await pending


async def test_concurrent_first_turns_initialize_sdk_once_off_loop(
    monkeypatch, tmp_path, deepseek_provider,
):
    import threading

    entered, release = threading.Event(), threading.Event()
    main_thread = threading.get_ident()
    starts, calls = [], []

    class Harness:
        initialized = False

        def start(self):
            if self.initialized:
                return
            starts.append(threading.get_ident())
            entered.set()
            assert release.wait(2)
            self.initialized = True

        def run(self, prompt, *, session_id, on_notification):
            self.start()  # official SDK starts lazily, without an initialization lock
            calls.append(session_id)
            return SimpleNamespace(finish_reason="completed")

        def close(self):
            pass

    harness = Harness()
    _configure_spawn(monkeypatch, deepseek_provider, lambda self, **_: harness)

    async def collect(sid):
        return [event async for event in DeepSeekHarnessEngine().spawn(
            "go", str(tmp_path), session_id=sid,
        )]

    first = asyncio.create_task(collect("session-a"))
    second = None
    try:
        assert await asyncio.to_thread(entered.wait, 1)
        second = asyncio.create_task(collect("session-b"))
        await asyncio.sleep(0.05)
        assert len(starts) == 1
        assert starts[0] != main_thread
    finally:
        release.set()
        results = await asyncio.gather(first, *([second] if second else []))
    assert sorted(calls) == ["session-a", "session-b"]
    assert not any(event.type == "error" for events in results for event in events)
