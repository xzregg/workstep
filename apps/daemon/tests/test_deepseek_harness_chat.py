"""DeepSeek session IDs across the real chat API and database persistence."""

import asyncio
import threading
from types import SimpleNamespace

from httpx import ASGITransport, AsyncClient

from engines.deepseek_harness import DeepSeekHarnessEngine
from .test_chat_session import chat_module, _wait_turn  # noqa: F401
from .test_deepseek_harness_engine import _configure_spawn, notification, deepseek_provider  # noqa: F401


async def test_chat_api_persists_engine_id_and_resumes_after_host_cache_eviction(
    chat_module, monkeypatch, deepseek_provider,
):
    import main

    module, _, manager, project, store = chat_module
    store.values["providers"] = [deepseek_provider]
    entered, release = threading.Event(), threading.Event()
    calls, histories = [], {}

    class Harness:
        initialized = False

        def start(self):
            if not self.initialized:
                entered.set()
                assert release.wait(2)
                self.initialized = True

        def run(self, prompt, *, session_id, on_notification):
            calls.append(session_id)
            history = histories.setdefault(session_id, [])
            if not history:
                history.append(prompt)
                answer = "已记住"
            else:
                answer = history[0]
            on_notification(notification("session.event", {
                "sessionId": session_id,
                "event": {"type": "assistant/chunk", "data": {
                    "turn": len(calls), "step": 0,
                    "chunk": {"type": "text-delta", "index": 0, "text": answer},
                }},
            }))
            return SimpleNamespace(finish_reason="completed")

        def close(self):
            pass

    _configure_spawn(monkeypatch, deepseek_provider, lambda self, **_: Harness())
    monkeypatch.setattr("agent_assistants.chat_session.create_engine", lambda _: DeepSeekHarnessEngine())
    monkeypatch.setattr("agent_assistants.base.create_engine", lambda _: DeepSeekHarnessEngine())
    monkeypatch.setattr(main, "project_manager", manager)
    monkeypatch.setattr(main, "chat_session_module", module)
    try:
        async with AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test") as client:
            created = await client.post("/api/chat-sessions", json={
                "project_id": project.id, "engine": "deepseek_harness", "model": "model-a",
            })
            assert created.status_code == 200, created.text
            sid = created.json()["id"]

            async def send(content, key):
                response = await client.post(f"/api/chat-sessions/{sid}/chat", json={
                    "project_id": project.id, "content": content,
                }, headers={"Idempotency-Key": key})
                assert response.status_code == 200
                return response.json()["turn_id"]

            first = await send("记住暗号 API-4271", "first")
            try:
                assert await asyncio.to_thread(entered.wait, 1)
                assert (await asyncio.wait_for(client.get("/api/health"), 0.5)).status_code == 200
            finally:
                release.set()
            assert await _wait_turn(module, first) == "completed"
            detail = (await client.get(f"/api/chat-sessions/{sid}", params={"project_id": project.id})).json()
            native_id = detail["engine_session_id"]
            assert native_id.startswith("session-")
            module._sessions.clear()
            assert await _wait_turn(module, await send("暗号是什么？", "second")) == "completed"
            detail = (await client.get(f"/api/chat-sessions/{sid}", params={"project_id": project.id})).json()
            assert detail["engine_session_id"] == native_id
            assert "API-4271" in detail["messages"][-1]["content"]
            assert calls == [native_id, native_id]
    finally:
        release.set()
        await asyncio.to_thread(DeepSeekHarnessEngine.shutdown_pool)
