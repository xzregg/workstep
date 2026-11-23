"""Conversation identity is execution metadata, never prompt text."""
import asyncio
import json
import os
import sys

import pytest


def test_context_cli_reads_only_identity(monkeypatch, capsys):
    from cli import main
    monkeypatch.setenv("WORKSTEP_PROJECT_ID", "p")
    monkeypatch.setenv("WORKSTEP_SESSION_ID", "s")
    monkeypatch.setenv("WORKSTEP_SOURCE_MESSAGE_ID", "must-not-leak")
    assert main(["context", "get", "--json"]) == 0
    assert json.loads(capsys.readouterr().out) == {"project_id": "p", "session_id": "s"}


def test_context_cli_without_session_fails(monkeypatch, capsys):
    from cli import main
    monkeypatch.delenv("WORKSTEP_PROJECT_ID", raising=False)
    monkeypatch.delenv("WORKSTEP_SESSION_ID", raising=False)
    assert main(["context", "get", "--json"]) != 0


@pytest.mark.asyncio
async def test_context_isolated_in_concurrent_child_processes(monkeypatch):
    from services.conversation_context import conversation_context
    from engines.core.base import ProviderRuntimeConfig
    monkeypatch.setenv("WORKSTEP_SESSION_ID", "stale-parent")
    monkeypatch.setenv("WORKSTEP_PROJECT_ID", "stale-project")

    async def run(project, session):
        with conversation_context(project, session, message_id=f"message-{session}",
                                  sender_id=f"sender-{session}", sender_name=session):
            await asyncio.sleep(0)
            runtime = ProviderRuntimeConfig()
            assert runtime.has_execution_context
            process = await asyncio.create_subprocess_exec(
                sys.executable, "-c",
                "from services.conversation_context import current_conversation; import json; print(json.dumps(current_conversation()))",
                env=runtime.child_env(), stdout=asyncio.subprocess.PIPE,
            )
            out, _ = await process.communicate()
            assert process.returncode == 0
            return json.loads(out)
    assert await asyncio.gather(run("p1", "s1"), run("p2", "s2")) == [
        {"project_id": "p1", "session_id": "s1", "message_id": "message-s1", "sender_id": "sender-s1", "sender_name": "s1"},
        {"project_id": "p2", "session_id": "s2", "message_id": "message-s2", "sender_id": "sender-s2", "sender_name": "s2"},
    ]
    assert "WORKSTEP_SESSION_ID" not in ProviderRuntimeConfig().child_env()
    assert os.environ["WORKSTEP_SESSION_ID"] == "stale-parent"


async def test_context_get_refreshes_sender_in_reused_engine(monkeypatch):
    import httpx
    from cli import build_parser, dispatch
    from services.tool_registry import WorkstepClient

    for key, value in {"PROJECT_ID": "p", "SESSION_ID": "s", "MESSAGE_ID": "old",
                       "SENDER_ID": "old-sender", "SENDER_NAME": "旧发送者"}.items():
        monkeypatch.setenv(f"WORKSTEP_{key}", value)
    current = {"message_id": "latest", "sender_id": "current", "sender_name": "当前发送者"}

    async def send(request):
        assert request.url.path == "/api/memory/sender"
        assert json.loads(request.content) == {"project_id": "p", "session_id": "s"}
        return httpx.Response(200, json=current)

    args = build_parser().parse_args(["context", "get", "--json"])
    assert await dispatch(args, WorkstepClient(transport=httpx.MockTransport(send))) == {
        "project_id": "p", "session_id": "s", **current,
    }


def test_message_context_does_not_rotate_reused_engine_processes(tmp_path):
    from types import SimpleNamespace
    from engines.codex_sdk_clients import client_fingerprint
    from engines.core.session_pool import startup_fingerprint
    from services.conversation_context import conversation_context, execution_env

    def fingerprints(session, message):
        with conversation_context("p", session, message_id=message, sender_id=message):
            client = SimpleNamespace(codex_bin=None, cwd=str(tmp_path), config_overrides=None,
                                     env=execution_env({"CODEX_HOME": str(tmp_path)}))
            return startup_fingerprint({}), client_fingerprint(client, {})

    assert fingerprints("s", "one") == fingerprints("s", "two")
    assert fingerprints("s", "one") != fingerprints("other", "one")
