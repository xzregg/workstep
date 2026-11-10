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
        with conversation_context(project, session):
            await asyncio.sleep(0)
            runtime = ProviderRuntimeConfig()
            assert runtime.has_execution_context
            process = await asyncio.create_subprocess_exec(
                sys.executable, "-c",
                "import os,json; print(json.dumps([os.getenv('WORKSTEP_PROJECT_ID'), os.getenv('WORKSTEP_SESSION_ID')]))",
                env=runtime.child_env(), stdout=asyncio.subprocess.PIPE,
            )
            out, _ = await process.communicate()
            assert process.returncode == 0
            return json.loads(out)
    assert await asyncio.gather(run("p1", "s1"), run("p2", "s2")) == [["p1", "s1"], ["p2", "s2"]]
    assert "WORKSTEP_SESSION_ID" not in ProviderRuntimeConfig().child_env()
    assert os.environ["WORKSTEP_SESSION_ID"] == "stale-parent"
