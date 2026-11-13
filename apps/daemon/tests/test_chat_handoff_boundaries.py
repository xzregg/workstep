"""Unsent endpoint changes, retry safety and durable context boundaries."""

import asyncio
import json
import threading

import pytest
from httpx import ASGITransport, AsyncClient

from tests.test_chat_session import chat_module, FakeEngine, _wait_turn
from models.chat_session import ChatMessage, ChatSession
from models.fields import utc_now


@pytest.mark.anyio
@pytest.mark.parametrize("mode", ["smart", "full", "none"])
async def test_handoff_retry_and_return_are_idempotent(chat_module, mode):
    module, _, manager, project, _ = chat_module
    source = module.create_session(project.id, engine="claude")

    def operation(_):
        first = module.handoff_session(project.id, source["id"], engine="codex_sdk", context_mode=mode)
        metadata = ChatSession.get_by_id(source["id"]).fork_context_json
        second = module.handoff_session(project.id, source["id"], engine="codex_sdk", context_mode=mode)
        assert second["engine"] == first["engine"]
        assert ChatSession.get_by_id(source["id"]).fork_context_json == metadata
        for _ in range(2):
            restored = module.handoff_session(project.id, source["id"], engine="claude", context_mode=mode)
            assert restored["engine"] == "claude"
            assert restored["pending_handoff"] is None

    await manager.run_db(project.id, operation)


@pytest.mark.anyio
async def test_pending_handoff_survives_reload_and_is_independent_of_history_page(chat_module):
    module, _, manager, project, config = chat_module
    config.values["providers"] = [{"id": "provider-a", "protocol": "openai_compatible", "enabled": True}]
    source = module.create_session(project.id, engine="claude", provider_id="provider-a", model="original-model")

    def operation(_):
        ChatMessage.create(id="last-message", session=source["id"], role="user", content="history", created_at=utc_now())
        module.handoff_session(project.id, source["id"], engine="codex_sdk", context_mode="full")
        module._sessions.clear()
        detail = module.get_session(project.id, source["id"], limit=1, offset=100)
        assert detail["pending_handoff"] == {
            "source_engine": "claude", "source_provider_id": "provider-a",
            "target_engine": "codex_sdk", "context_mode": "full", "message_id": "last-message",
        }

    await manager.run_db(project.id, operation)


@pytest.mark.anyio
async def test_retry_can_explicitly_change_pending_context_mode(chat_module):
    module, _, manager, project, _ = chat_module
    source = module.create_session(project.id, engine="claude")

    def operation(_):
        module.handoff_session(project.id, source["id"], engine="codex_sdk", context_mode="smart")
        module.handoff_session(project.id, source["id"], engine="codex_sdk", context_mode="none")
        assert json.loads(ChatSession.get_by_id(source["id"]).fork_context_json)["mode"] == "none"

    await manager.run_db(project.id, operation)


@pytest.mark.anyio
@pytest.mark.parametrize("reload_memory", [False, True])
async def test_none_handoff_excludes_old_history_on_later_turns_and_rebuild(chat_module, monkeypatch, reload_memory):
    module, _, manager, project, _ = chat_module
    source = module.create_session(project.id, engine="claude")
    prompts = []

    def seed(_):
        ChatMessage.create(id="old-context", session=source["id"], role="user", content="OLD_CONTEXT_SENTINEL", created_at=utc_now())
        module.handoff_session(project.id, source["id"], engine="codex_sdk", context_mode="none")

    await manager.run_db(project.id, seed)

    async def invoke(engine, model, cwd, prompt, session_id, on_event=None, **kwargs):
        prompts.append(prompt)
        return "new reply", [], "new-thread"

    monkeypatch.setattr(module, "_invoke", invoke)
    for index in range(2):
        if reload_memory:
            module._sessions.clear()
        accepted = await manager.run_db(project.id, lambda _: module.submit_message(
            project.id, source["id"], f"new-{index}", f"key-{index}", schedule=False,
        ))
        module.start_queued_turn(accepted.turn_id)
        assert await _wait_turn(module, accepted.turn_id) == "completed"
    assert all("OLD_CONTEXT_SENTINEL" not in prompt for prompt in prompts)
    session = module._sessions[module._session_identity(project.id, source["id"])[0]]
    assert "OLD_CONTEXT_SENTINEL" not in await asyncio.to_thread(module._build_rebuild_prompt, session)
    detail = await manager.run_db(project.id, lambda _: module.get_session(project.id, source["id"]))
    assert detail["messages"][0]["content"] == "OLD_CONTEXT_SENTINEL"  # visible history stays available
    assert detail["pending_handoff"] is None


@pytest.mark.anyio
async def test_handoff_api_slow_log_and_retry_keep_health_responsive(chat_module, monkeypatch):
    import main
    import agent_assistants.chat_session_transitions as transitions

    module, _, manager, project, _ = chat_module
    source = module.create_session(project.id, engine="claude")
    monkeypatch.setattr(main, "project_manager", manager)
    monkeypatch.setattr(main, "chat_session_module", module)
    entered, release = threading.Event(), threading.Event()
    original = transitions.append_handoff_log

    def slow_log(*args, **kwargs):
        entered.set()
        release.wait(2)
        return original(*args, **kwargs)

    monkeypatch.setattr(transitions, "append_handoff_log", slow_log)
    async with AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test") as client:
        body = {"project_id": project.id, "engine": "codex_sdk", "context_mode": "smart"}
        request = asyncio.create_task(client.post(f"/api/chat-sessions/{source['id']}/handoff", json=body))
        try:
            assert await asyncio.to_thread(entered.wait, 1)
            assert (await asyncio.wait_for(client.get("/api/health"), .2)).status_code == 200
        finally:
            release.set()
        assert (await request).status_code == 200
        retry = await client.post(f"/api/chat-sessions/{source['id']}/handoff", json=body)
        assert retry.status_code == 200
        assert retry.json()["pending_handoff"]["target_engine"] == "codex_sdk"


@pytest.mark.anyio
async def test_a_b_unsent_return_a_send_b_send_then_change_provider_via_api(chat_module, monkeypatch):
    import main

    module, _, manager, project, config = chat_module
    config.values["providers"] = [
        {"id": value, "protocol": "openai_compatible", "enabled": True}
        for value in ("provider-a", "provider-b")
    ]

    class ResumeEngine(FakeEngine):
        supports_resume = True

    monkeypatch.setattr("agent_assistants.chat_session.create_engine", lambda _: ResumeEngine())
    monkeypatch.setattr("agent_assistants.base.create_engine", lambda _: ResumeEngine())
    monkeypatch.setattr(main, "project_manager", manager)
    monkeypatch.setattr(main, "chat_session_module", module)
    calls = []

    async def invoke(engine, model, cwd, prompt, session_id, on_event=None, **kwargs):
        calls.append((engine, session_id, prompt))
        return "reply", [], f"thread-{len(calls)}"

    monkeypatch.setattr(module, "_invoke", invoke)
    source = module.create_session(project.id, engine="claude", provider_id="provider-a", model="original-model")
    async with AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test") as client:
        base = f"/api/chat-sessions/{source['id']}"

        async def send(engine, provider, content):
            response = await client.post(f"{base}/chat", json={
                "project_id": project.id, "engine": engine, "provider_id": provider, "content": content,
            }, headers={"Idempotency-Key": content})
            assert response.status_code == 200, response.text
            assert await _wait_turn(module, response.json()["turn_id"]) == "completed"

        async def switch(engine, provider):
            response = await client.post(f"{base}/handoff", json={
                "project_id": project.id, "engine": engine, "provider_id": provider, "context_mode": "smart",
            })
            assert response.status_code == 200, response.text
            return response.json()

        await send("claude", "provider-a", "original A")
        await switch("codex_sdk", "")
        restored = await switch("claude", "provider-a")
        assert restored["engine_session_id"] == "thread-1"
        assert restored["model"] == "original-model"
        assert restored["pending_handoff"] is None
        await send("claude", "provider-a", "A continued")
        assert calls[-1][:2] == ("claude", "thread-1")
        await switch("codex_sdk", "")
        await send("codex_sdk", "", "B first")
        assert calls[-1][:2] == ("codex_sdk", None)
        assert "workstep_context_handoff" in calls[-1][2]
        switched = await switch("codex_sdk", "provider-b")
        assert switched["engine_session_id"] is None
        assert switched["pending_handoff"]["source_engine"] == "codex_sdk"
        await send("codex_sdk", "provider-b", "B new provider")
        assert calls[-1][:2] == ("codex_sdk", None)
        assert "provider-b" in calls[-1][2]
