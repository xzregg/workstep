"""Codex native attachments stay separate from prompt text and snapshots."""

import asyncio
from types import SimpleNamespace

import pytest

from engines.codex import CodexEngine
from engines.core.base import ProviderRuntimeConfig
from engines.core.schema import EngineImage


@pytest.fixture
def cli_transport(monkeypatch, tmp_path):
    commands = []
    processes = []

    class Stdin:
        def __init__(self):
            self.written = b""

        def write(self, data):
            self.written += data

        async def drain(self):
            pass

        def close(self):
            pass

    async def create_process(*cmd, **kwargs):
        commands.append(cmd)
        stdout = asyncio.StreamReader()
        stdout.feed_data(b'{"type":"thread.started","thread_id":"thread-1"}\n')
        stdout.feed_eof()
        stderr = asyncio.StreamReader()
        stderr.feed_eof()
        async def wait():
            return 0
        proc = SimpleNamespace(stdin=Stdin(), stdout=stdout, stderr=stderr,
                               wait=wait, returncode=0, terminate=lambda: None)
        processes.append(proc)
        return proc

    monkeypatch.setattr(asyncio, "create_subprocess_exec", create_process)
    monkeypatch.setattr(CodexEngine, "resolve_binary", staticmethod(lambda: "/fake/codex"))
    monkeypatch.setattr(CodexEngine, "resolve_provider_runtime", lambda self, **kw: ProviderRuntimeConfig())
    monkeypatch.setattr(CodexEngine, "project_skills", lambda self, cwd: [])
    monkeypatch.setattr("services.skill_runtime.prepare_codex_skills", lambda skills: ([], "skills=[]"))
    monkeypatch.setattr("engines.codex.config_store.get_codex_config", lambda: {
        "sandbox_mode": "workspace-write", "model_reasoning_effort": "", "approval_policy": "",
    })
    return commands, processes


@pytest.mark.anyio
@pytest.mark.parametrize("session_id", [None, "existing"])
@pytest.mark.parametrize("entry", ["spawn_with_retry", "spawn_coordinator_with_retry"])
async def test_cli_attaches_multiple_images_without_rewriting_prompt(cli_transport, tmp_path, session_id, entry):
    commands, processes = cli_transport
    images = [EngineImage(path=str(tmp_path / "shot one.png")), EngineImage(path=str(tmp_path / "图二.jpg"))]
    events = [event async for event in getattr(CodexEngine(), entry)(
        prompt="原问题", cwd=str(tmp_path), session_id=session_id,
        images=images, capture_prompt_input=True,
    )]
    assert not [event for event in events if event.type == "error"]
    cmd = commands[0]
    assert [cmd[index + 1] for index, flag in enumerate(cmd) if flag == "--image"] == [image.path for image in images]
    assert "Attached image(s)" not in " ".join(cmd)
    if session_id:
        assert cmd[cmd.index("resume") + 2] == "原问题"
        assert not processes[0].stdin.written
    else:
        assert processes[0].stdin.written == "原问题".encode()
    snapshot = next(event.data for event in events if event.type == "prompt_input")
    assert snapshot["prompt"] == "原问题"
    assert snapshot["images"] == [image.path for image in images]


@pytest.mark.anyio
async def test_cli_live_resume_does_not_reattach_initial_images(cli_transport, tmp_path):
    commands, _ = cli_transport
    queue = asyncio.Queue()
    events = []
    inserted = False
    async for event in CodexEngine().spawn(
        "原问题", cwd=str(tmp_path), images=[EngineImage(path=str(tmp_path / "shot.png"))],
        live_message_queue=queue,
    ):
        events.append(event)
        if event.type == "session_started" and not inserted:
            inserted = True
            queue.put_nowait(("live-1", "继续"))
    assert len(commands) == 2
    assert "--image" in commands[0]
    assert "--image" not in commands[1]
    assert commands[1][commands[1].index("resume") + 2] == "继续"
    assert any(event.type == "live_message" for event in events)


@pytest.mark.anyio
async def test_cli_rejects_nonlocal_images_before_launch(cli_transport, tmp_path):
    commands, _ = cli_transport
    events = [event async for event in CodexEngine().spawn(
        "原问题", cwd=str(tmp_path), images=[EngineImage(url="https://example.com/shot.png")],
    )]
    assert not commands
    assert any(event.type == "error" and "本地图片" in event.data["message"] for event in events)
