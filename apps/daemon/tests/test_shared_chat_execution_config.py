"""All viewers share the last committed execution configuration."""

import asyncio
import threading
import sqlite3

import pytest
from httpx import ASGITransport, AsyncClient

from tests.test_chat_session import chat_module, _wait_turn
from models.chat_session import ChatSession
from streaming.ws import WsSubscription, matches_subscription


@pytest.mark.anyio
@pytest.mark.parametrize("target_engine", ["claude", "codex_sdk"])
async def test_stale_viewer_send_uses_latest_engine_provider_and_models(chat_module, monkeypatch, target_engine):
    import main

    module, bus, manager, project, config = chat_module
    config.values["providers"] = [
        {"id": name, "protocol": "openai_compatible", "enabled": True}
        for name in ["provider-a", "provider-b"]
    ]
    source = module.create_session(project.id, engine="claude", provider_id="provider-a", model="old-model")
    monkeypatch.setattr(main, "project_manager", manager)
    monkeypatch.setattr(main, "chat_session_module", module)
    captured = []

    async def invoke(engine_id, model, cwd, prompt, session_id, on_event=None, **kwargs):
        captured.append((engine_id, model, kwargs.get("config_overrides")))
        return "reply", [], "native-thread"

    monkeypatch.setattr("agent_assistants.base.invoke_engine", invoke)
    queue = bus.subscribe()
    base = f"/api/chat-sessions/{source['id']}"
    async with AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test") as client:
        # User B changes the shared endpoint before user A sends its stale form.
        switched = await client.post(f"{base}/handoff", json={
            "project_id": project.id, "engine": target_engine, "provider_id": "provider-b", "context_mode": "smart",
        })
        assert switched.status_code == 200
        event = await asyncio.wait_for(queue.get(), .5)
        assert event["name"] == "workstep.chat_execution_config"
        assert event["value"]["provider_id"] == "provider-b"
        assert matches_subscription(event, WsSubscription(active=True, project_id=project.id, session_ids={source["id"]}))
        assert not matches_subscription(event, WsSubscription(active=True, session_ids={"another-session"}))
        changed = await client.patch(f"{base}/execution-config", json={
            "project_id": project.id, "model": "latest-model", "fast_model": "latest-fast", "vision_model": "latest-vision",
            "thinking_effort": "low", "service_tier": "priority" if target_engine == "codex_sdk" else "",
        })
        assert changed.status_code == 200, changed.text
        assert changed.json()["execution_config_revision"] > switched.json()["execution_config_revision"]
        sent = await client.post(f"{base}/chat", headers={"Idempotency-Key": "stale-A"}, json={
            "project_id": project.id, "content": "A sends later", "engine": "claude", "provider_id": "provider-a",
            "model": "old-model", "thinking_effort": "high",
        })
        assert sent.status_code == 200, sent.text
        assert sent.json()["execution_config"]["provider_id"] == "provider-b"
        assert await _wait_turn(module, sent.json()["turn_id"]) == "completed"
        assert captured[-1][:2] == (target_engine, "latest-model")
        assert captured[-1][2]["provider_id"] == "provider-b"
        current = await manager.run_db(project.id, lambda _: module.get_session(project.id, source["id"]))
        assert current["provider_id"] == "provider-b"
        assert current["model"] == "latest-model"
        # Retrying a completed send must retain its actual message engine while
        # still returning the new shared composer config, and must not run again.
        other_engine = "claude" if target_engine == "codex_sdk" else "codex_sdk"
        await client.post(f"{base}/handoff", json={
            "project_id": project.id, "engine": other_engine, "provider_id": "provider-a", "context_mode": "smart",
        })
        retried = await client.post(f"{base}/chat", headers={"Idempotency-Key": "stale-A"}, json={
            "project_id": project.id, "content": "A sends later",
        })
        assert retried.json()["engine"] == target_engine
        assert retried.json()["execution_config"]["engine"] == other_engine
        await asyncio.sleep(.05)
        assert len(captured) == 1


@pytest.mark.anyio
async def test_slow_shared_config_write_does_not_block_health_and_read_returns_latest(chat_module, monkeypatch):
    import main

    module, _, manager, project, _ = chat_module
    source = module.create_session(project.id, engine="claude")
    monkeypatch.setattr(main, "project_manager", manager)
    monkeypatch.setattr(main, "chat_session_module", module)
    original = project.db.execute_sql
    entered, release = threading.Event(), threading.Event()

    def slow_write(sql, params=None, commit=None):
        if not entered.is_set() and sql.startswith('UPDATE "chat_sessions"'):
            entered.set()
            release.wait(2)
        return original(sql, params)

    monkeypatch.setattr(project.db, "execute_sql", slow_write)
    async with AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test") as client:
        path = f"/api/chat-sessions/{source['id']}/execution-config"
        pending = asyncio.create_task(client.patch(path, json={"project_id": project.id, "model": "new-model"}))
        try:
            assert await asyncio.to_thread(entered.wait, 1)
            assert (await asyncio.wait_for(client.get("/api/health"), .2)).status_code == 200
        finally:
            release.set()
        assert (await pending).status_code == 200
        snapshot = await client.get(path, params={"project_id": project.id})
        assert snapshot.json()["model"] == "new-model"


@pytest.mark.anyio
async def test_model_patch_cannot_silently_switch_a_populated_endpoint(chat_module):
    module, _, manager, project, _ = chat_module
    source = module.create_session(project.id, engine="claude")
    with pytest.raises(ValueError):
        await manager.run_db(project.id, lambda _: module.update_execution_config(project.id, source["id"], {"provider_id": "other"}))


@pytest.mark.anyio
async def test_concurrent_partial_config_changes_preserve_each_others_fields(chat_module, monkeypatch):
    import main

    module, _, manager, project, _ = chat_module
    source = module.create_session(project.id, engine="codex_sdk")
    monkeypatch.setattr(main, "project_manager", manager)
    monkeypatch.setattr(main, "chat_session_module", module)
    async with AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test") as client:
        path = f"/api/chat-sessions/{source['id']}/execution-config"
        responses = await asyncio.gather(
            client.patch(path, json={"project_id": project.id, "model": "new-model"}),
            client.patch(path, json={"project_id": project.id, "service_tier": "priority"}),
        )
        assert all(response.status_code == 200 for response in responses)
        assert sorted(response.json()["execution_config_revision"] for response in responses) == [1, 2]
        final = (await client.get(path, params={"project_id": project.id})).json()
        assert (final["model"], final["service_tier"]) == ("new-model", "priority")
        refused = await client.patch(path, json={"project_id": project.id, "provider_id": "other"})
        assert refused.status_code == 422


def test_legacy_chat_config_columns_are_added_without_changing_endpoint(tmp_path):
    from models import init_db
    from models.fields import utc_now

    path = str(tmp_path / "legacy-chat.db")
    db = init_db(path)
    ChatSession.create(id="s", project_id="p", workflow_id="", engine="claude", provider_id="original", created_at=utc_now(), updated_at=utc_now())
    db.close()
    with sqlite3.connect(path) as raw:
        for column in ["thinking_effort", "service_tier", "execution_config_revision"]:
            raw.execute(f"ALTER TABLE chat_sessions DROP COLUMN {column}")
    for _ in range(2):
        db = init_db(path)
        row = ChatSession.get_by_id("s")
        assert (row.engine, row.provider_id, row.thinking_effort, row.service_tier, row.execution_config_revision) == ("claude", "original", None, None, 0)
        db.close()
