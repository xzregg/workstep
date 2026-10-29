"""Opt-in real SDK/runtime persistence check with a local Chat Completions server.

WORKSTEP_VERIFY_DEEPSEEK_RUNTIME=1 PYTHONPATH=<engine-package-dir> uv run --no-sync pytest tests/test_deepseek_harness_runtime.py
No external API, credentials, or existing project data are used.
"""

import asyncio
import json
import os
import re

import pytest

from engines.deepseek_harness import DeepSeekHarnessEngine
from .test_deepseek_harness_engine import _selection


@pytest.mark.skipif(os.environ.get("WORKSTEP_VERIFY_DEEPSEEK_RUNTIME") != "1",
                    reason="requires installed DeepSeek SDK and bundled runtime")
async def test_real_runtime_restores_history_after_process_exit(monkeypatch, tmp_path):
    pytest.importorskip("deepseek_harness")
    requests = []

    async def respond(reader, writer):
        try:
            header = (await reader.readuntil(b"\r\n\r\n")).decode()
            length = int(re.search(r"content-length: (\d+)", header, re.I)[1])
            request = json.loads(await reader.readexactly(length))
            assert header.startswith("POST /v1/chat/completions ")
            requests.append(request)
            users = json.dumps([m for m in request["messages"] if m["role"] == "user"])
            answer = "memory-4271" if "memory-4271" in users else "UNKNOWN"
            chunks = [
                {"choices": [{"index": 0, "delta": {"role": "assistant", "content": answer}, "finish_reason": None}]},
                {"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                 "usage": {"prompt_tokens": 10, "completion_tokens": 3, "total_tokens": 13}},
            ]
            body = "".join("data: " + json.dumps({"id": "test", "object": "chat.completion.chunk",
                                                   "model": "workstep-test", **chunk}) + "\n\n"
                           for chunk in chunks) + "data: [DONE]\n\n"
            payload = body.encode()
            writer.write((f"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {len(payload)}\r\nConnection: close\r\n\r\n").encode() + payload)
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()

    server = await asyncio.start_server(respond, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    provider = {"id": "local-test", "type": "custom", "enabled": True,
                "base_url": f"http://127.0.0.1:{port}/v1", "api_key": "test-placeholder"}
    monkeypatch.setattr(DeepSeekHarnessEngine, "get_binary_override", classmethod(lambda cls: None))
    monkeypatch.setattr(DeepSeekHarnessEngine, "project_skills", lambda self, cwd: _selection(tmp_path))
    monkeypatch.setattr("engines.deepseek_harness.config_store.get_deepseek_harness_config",
                        lambda: {"provider_id": provider["id"]})
    monkeypatch.setattr("engines.deepseek_harness.config_store.get_provider", lambda _: provider)

    async def turn(prompt, sid=None):
        events = [event async for event in DeepSeekHarnessEngine().spawn(
            prompt, str(tmp_path), model="workstep-test", session_id=sid,
        )]
        assert not [event.data for event in events if event.type == "error"]
        sid = next(event.data["session_id"] for event in events if event.type == "session_started")
        entry = next(iter(DeepSeekHarnessEngine._POOL.values()))
        return sid, entry.harness.client._proc.pid

    try:
        sid, pid = await asyncio.wait_for(turn("Remember memory-4271"), 30)
        assert await asyncio.wait_for(turn("Recall", sid), 30) == (sid, pid)
        await asyncio.to_thread(DeepSeekHarnessEngine.shutdown_pool)
        restored_sid, restored_pid = await asyncio.wait_for(turn("Recall after restart", sid), 30)
        assert restored_sid == sid and restored_pid != pid
        history = requests[-1]["messages"]
        assert any(m["role"] == "user" and "memory-4271" in str(m["content"]) for m in history)
        assert any(m["role"] == "assistant" and "memory-4271" in str(m["content"]) for m in history)
        assert len(requests) == 3
        await asyncio.wait_for(turn("Independent session"), 30)
        assert "memory-4271" not in json.dumps(requests[-1]["messages"])
    finally:
        await asyncio.to_thread(DeepSeekHarnessEngine.shutdown_pool)
        server.close()
        await server.wait_closed()
