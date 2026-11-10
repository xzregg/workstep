"""Conversation group API persistence and event loop regression tests."""
import asyncio
import threading

import pytest
from httpx import ASGITransport, AsyncClient
from tests.test_chat_session import chat_module  # noqa: F401


@pytest.mark.anyio
async def test_group_lifecycle_and_running_members(chat_module, monkeypatch):
    import main
    module, _, manager, project, _ = chat_module
    monkeypatch.setattr(main, "project_manager", manager)
    monkeypatch.setattr(main, "chat_session_module", module)
    first = await manager.run_db(project.id, lambda _: module.create_session(project.id))
    second = await manager.run_db(project.id, lambda _: module.create_session(project.id))
    url = f"/api/chat-sessions/groups?project_id={project.id}"
    async with AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test") as client:
        assert (await client.post(url, json={"action": "create", "name": "  "})).status_code == 400
        result = await client.post(url, json={"action": "create", "name": "研发"})
        assert result.status_code == 200, result.text
        gid = result.json()["groups"][0]["id"]
        for session in (first, second):
            result = await client.post(url, json={"action": "move", "group_id": gid, "session_id": session["id"]})
            assert result.status_code == 200
        assert (await client.get(url)).json()["groups"][0]["session_ids"] == [first["id"], second["id"]]
        other = (await client.post(url, json={"action": "create", "name": "另一个分组"})).json()["groups"][1]["id"]
        moved = (await client.post(url, json={"action": "move", "group_id": other, "session_id": first["id"]})).json()["groups"]
        assert moved[0]["session_ids"] == [second["id"]]
        assert moved[1]["session_ids"] == [first["id"]]
        await client.post(url, json={"action": "move", "group_id": None, "session_id": first["id"]})
        await client.post(url, json={"action": "move", "group_id": gid, "session_id": first["id"]})
        await client.post(url, json={"action": "delete", "group_id": other})
        assert (await client.post(url, json={"action": "move", "group_id": gid, "session_id": "foreign"})).status_code == 404
        module._turn_states["test"] = {"session_id": second["id"], "status": "running"}
        result = (await client.post(url, json={"action": "archive", "group_id": gid})).json()
        assert result["removed"] == [first["id"]]
        assert result["skipped"] == [second["id"]]
        assert result["groups"][0]["session_ids"] == [second["id"]]
        module._turn_states.clear()
        result = (await client.post(url, json={"action": "delete", "group_id": gid, "delete_sessions": True})).json()
        assert result["removed"] == [second["id"]]
        assert result["groups"] == []
        assert (await client.get(f"/api/chat-sessions/{first['id']}?project_id={project.id}")).status_code == 200
        assert (await client.get(f"/api/chat-sessions/{second['id']}?project_id={project.id}")).status_code == 404


@pytest.mark.anyio
@pytest.mark.parametrize("operation", ["create", "new_session", "reorder"])
async def test_group_slow_sql_keeps_health_responsive(chat_module, monkeypatch, operation):
    import main
    module, _, manager, project, _ = chat_module
    monkeypatch.setattr(main, "project_manager", manager)
    monkeypatch.setattr(main, "chat_session_module", module)
    from api.chat_session import ChatSessionGroupRequest
    from services.chat_session_groups import mutate_group
    group = await manager.run_db(project.id, lambda _: mutate_group(project.id, ChatSessionGroupRequest(action="create", name="已有组"), module))
    target = await manager.run_db(project.id, lambda _: mutate_group(project.id, ChatSessionGroupRequest(action="create", name="目标组"), module))
    entered, release = threading.Event(), threading.Event()
    original = project.db.execute_sql
    def slow(sql, *args, **kwargs):
        if 'project_settings' in sql:
            entered.set()
            release.wait(2)
        return original(sql, *args, **kwargs)
    monkeypatch.setattr(project.db, "execute_sql", slow)
    async with AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test") as client:
        url = "/api/chat-sessions" if operation == "new_session" else f"/api/chat-sessions/groups?project_id={project.id}"
        payload = {"project_id": project.id, "group_id": group["groups"][0]["id"]} if operation == "new_session" else {"action": "create", "name": "分组"}
        if operation == "reorder":
            payload = {"action": "reorder", "group_id": group["groups"][0]["id"], "target_group_id": target["groups"][1]["id"], "before": False}
        pending = asyncio.create_task(client.post(url, json=payload))
        try:
            assert await asyncio.to_thread(entered.wait, 1)
            assert (await asyncio.wait_for(client.get("/api/health"), .2)).status_code == 200
        finally:
            release.set()
        assert (await pending).status_code == 200


@pytest.mark.anyio
@pytest.mark.parametrize("action,delete_sessions", [("archive", False), ("delete", False), ("dissolve", False), ("delete", True)])
async def test_group_removal_preserves_messages_unless_explicitly_deleted(chat_module, monkeypatch, action, delete_sessions):
    import main
    from models.chat_session import ChatMessage, ChatSession
    from models.fields import utc_now
    module, _, manager, project, _ = chat_module
    monkeypatch.setattr(main, "project_manager", manager)
    monkeypatch.setattr(main, "chat_session_module", module)
    def seed(_):
        session = module.create_session(project.id)
        ChatMessage.create(id="group-test-message", session=session["id"], role="user", content="保留这条消息", created_at=utc_now())
        return session["id"]
    sid = await manager.run_db(project.id, seed)
    url = f"/api/chat-sessions/groups?project_id={project.id}"
    async with AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test") as client:
        group = (await client.post(url, json={"action": "create", "name": "保留测试"})).json()["groups"][0]
        await client.post(url, json={"action": "move", "group_id": group["id"], "session_id": sid})
        payload = {"action": action, "group_id": group["id"]}
        if delete_sessions:
            payload["delete_sessions"] = True
        # Removing only the group must also preserve a running conversation.
        if action in {"delete", "dissolve"} and not delete_sessions:
            module._turn_states["group-test"] = {"session_id": sid, "status": "running"}
        result = (await client.post(url, json=payload)).json()
        assert result["groups"] == []
        def inspect(_):
            row = ChatSession.get_or_none(ChatSession.id == sid)
            message = ChatMessage.get_or_none(ChatMessage.id == "group-test-message")
            return row is not None, bool(row.archived) if row else None, message.content if message else None
        exists, archived, content = await manager.run_db(project.id, inspect)
        if delete_sessions:
            assert not exists and content is None
        else:
            assert exists and content == "保留这条消息"
            assert archived == (action == "archive")
            if action in {"delete", "dissolve"}:
                assert result["removed"] == []
        module._turn_states.clear()


@pytest.mark.anyio
async def test_create_session_in_group_is_atomic(chat_module, monkeypatch):
    import main
    from models.chat_session import ChatSession
    module, _, manager, project, _ = chat_module
    monkeypatch.setattr(main, "project_manager", manager)
    monkeypatch.setattr(main, "chat_session_module", module)
    url = f"/api/chat-sessions/groups?project_id={project.id}"
    async with AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test") as client:
        gid = (await client.post(url, json={"action": "create", "name": "组内创建"})).json()["groups"][0]["id"]
        result = await client.post("/api/chat-sessions", json={"project_id": project.id, "group_id": gid})
        assert result.status_code == 200
        assert (await client.get(url)).json()["groups"][0]["session_ids"] == [result.json()["id"]]
        invalid = await client.post("/api/chat-sessions", json={"project_id": project.id, "group_id": "missing"})
        assert invalid.status_code == 400
        assert await manager.run_db(project.id, lambda _: ChatSession.select().count()) == 1


@pytest.mark.anyio
async def test_group_reorder_persists_and_rejects_other_types(chat_module, monkeypatch):
    import main
    module, _, manager, project, _ = chat_module
    monkeypatch.setattr(main, "project_manager", manager)
    monkeypatch.setattr(main, "chat_session_module", module)
    url = f"/api/chat-sessions/groups?project_id={project.id}"
    async with AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test") as client:
        for name, source in [("one", "chat"), ("two", "chat"), ("channel", "channel")]:
            result = await client.post(url, json={"action": "create", "name": name, "source": source})
        first, second, channel = result.json()["groups"]
        payload = {"action": "reorder", "group_id": second["id"], "target_group_id": first["id"], "before": True}
        result = await client.post(url, json=payload)
        assert result.status_code == 200
        assert [g["id"] for g in (await client.get(url)).json()["groups"]] == [second["id"], first["id"], channel["id"]]
        assert (await client.post(url, json={**payload, "target_group_id": channel["id"]})).status_code == 400
        assert (await client.post(url, json={**payload, "group_id": "foreign"})).status_code == 404
