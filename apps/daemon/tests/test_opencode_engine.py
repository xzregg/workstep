"""OpencodeEngine（ACP 原生）单元测试。"""

import asyncio
import json
import os
from unittest import mock

import pytest

from engines.opencode import OpencodeEngine


@pytest.fixture(autouse=True)
def _clean_config(monkeypatch, tmp_path):
    """隔离 WorkStep 管理的权限配置文件。"""
    monkeypatch.setattr(
        "engines.opencode._managed_config_path",
        lambda: str(tmp_path / "opencode.json"),
    )
    monkeypatch.setattr("engines.opencode._GLOBAL_CONFIG_PATH", str(tmp_path / "missing.json"))


def test_registry_discovery():
    from engines.core.registry import list_all_engines

    assert list_all_engines()["opencode"] is OpencodeEngine


def test_resolve_binary_priority(monkeypatch):
    monkeypatch.setenv("OPENCODE_BIN", "/nonexistent/opencode")
    with mock.patch("shutil.which", return_value=None):
        assert OpencodeEngine.resolve_binary() is None
    monkeypatch.setenv("OPENCODE_BIN", "/usr/local/bin/opencode-fake")
    with mock.patch("os.path.isfile", return_value=True):
        assert OpencodeEngine.resolve_binary() == "/usr/local/bin/opencode-fake"
    monkeypatch.delenv("OPENCODE_BIN")
    with mock.patch("shutil.which", return_value="/opt/opencode"):
        assert OpencodeEngine.resolve_binary() == "/opt/opencode"


def test_is_installed_and_version_without_binary(monkeypatch):
    monkeypatch.delenv("OPENCODE_BIN", raising=False)
    with mock.patch("shutil.which", return_value=None), \
         mock.patch("os.path.isfile", return_value=False):
        assert OpencodeEngine.is_installed() is False
        assert OpencodeEngine.get_version() is None


def test_get_command_uses_acp_subcommand(monkeypatch):
    with mock.patch.object(OpencodeEngine, "resolve_binary", return_value="/opt/opencode"):
        assert OpencodeEngine().get_command() == ["/opt/opencode", "acp"]
    with mock.patch.object(OpencodeEngine, "resolve_binary", return_value=None):
        assert OpencodeEngine().get_command() == []
        # 无二进制时非 ACP 原生（安全降级）
        assert OpencodeEngine()._is_acp_native is False


def test_permission_mode_always_ask():
    assert OpencodeEngine().get_permission_mode() == "ask"


def test_project_skill_env_injects_permission_config():
    engine = OpencodeEngine()
    env = engine.project_skill_env("/tmp/some-project")
    assert "OPENCODE_CONFIG" in env
    data = json.loads(open(env["OPENCODE_CONFIG"], encoding="utf-8").read())
    assert data["permission"]["edit"] == "ask"
    assert data["permission"]["bash"] == "ask"


def test_permission_config_merges_global(monkeypatch, tmp_path):
    global_cfg = tmp_path / "global.json"
    global_cfg.write_text(
        json.dumps({"provider": {"x": {"name": "X"}}, "$schema": "s"}),
        encoding="utf-8",
    )
    monkeypatch.setattr("engines.opencode._GLOBAL_CONFIG_PATH", str(global_cfg))
    env = OpencodeEngine().project_skill_env("/tmp/p")
    data = json.loads(open(env["OPENCODE_CONFIG"], encoding="utf-8").read())
    assert data["provider"] == {"x": {"name": "X"}}  # 保留用户配置
    assert data["permission"]["edit"] == "ask"  # 覆盖权限


def test_capabilities_honest():
    engine = OpencodeEngine()
    assert engine.supports_resume is True
    assert engine.supports_tool_approval is True
    assert engine.supports_vision is True
    assert engine.supports_thinking_effort is False
    assert "openai_chat_completions" in engine.supported_provider_protocols()


def test_runtime_package():
    assert OpencodeEngine.RUNTIME_PACKAGE.name == "opencode-ai"
    assert OpencodeEngine.RUNTIME_PACKAGE.kind == "npm"


def test_build_provider_runtime_env():
    provider = {
        "id": "p1",
        "api_key": "sk-test",
        "protocol_base_urls": {"openai_chat_completions": "http://127.0.0.1:9/v1"},
    }
    rt = OpencodeEngine().build_provider_runtime(provider, "model-x", "openai_chat_completions")
    assert rt.env["OPENAI_BASE_URL"] == "http://127.0.0.1:9/v1"
    assert rt.env["OPENAI_API_KEY"] == "sk-test"


@pytest.mark.anyio
async def test_model_catalog_reads_large_acp_response_after_notification(monkeypatch):
    class Stdin:
        def __init__(self):
            self.writes = []

        def write(self, payload):
            self.writes.append(json.loads(payload))

        async def drain(self):
            pass

    class Process:
        def __init__(self):
            self.stdin = Stdin()
            self.stdout = asyncio.StreamReader(limit=65536)
            for payload in (
                {"jsonrpc": "2.0", "id": 1, "result": {"protocolVersion": 1}},
                {"jsonrpc": "2.0", "method": "session/update", "params": {}},
                {"jsonrpc": "2.0", "id": 2, "result": {"configOptions": [{
                    "id": "model", "name": "Models", "options": [
                        {"value": "large", "name": "Large", "extra": "x" * 70000},
                    ],
                }]}},
            ):
                self.stdout.feed_data((json.dumps(payload) + "\n").encode())
            self.stdout.feed_eof()

        def kill(self):
            pass

        async def wait(self):
            pass

    process = Process()

    async def spawn(*args, **kwargs):
        return process

    monkeypatch.setattr("engines.opencode.asyncio.create_subprocess_exec", spawn)
    monkeypatch.setattr(OpencodeEngine, "resolve_binary", staticmethod(lambda: "/bin/opencode"))
    models = await OpencodeEngine().list_models("/tmp")
    assert [(model.id, model.label) for model in models] == [("large", "Large")]
    assert [item["method"] for item in process.stdin.writes] == ["initialize", "session/new"]


def test_permission_config_write_failure_stops_spawn(monkeypatch, tmp_path):
    monkeypatch.setattr(
        "engines.opencode._managed_config_path", lambda: str(tmp_path / "missing" / "config.json")
    )
    monkeypatch.setattr("engines.opencode.os.makedirs", mock.Mock(side_effect=OSError("readonly")))
    with pytest.raises(RuntimeError, match="权限配置"):
        OpencodeEngine().project_skill_env("/tmp")
