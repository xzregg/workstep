"""OpencodeEngine（ACP 原生）单元测试。"""

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