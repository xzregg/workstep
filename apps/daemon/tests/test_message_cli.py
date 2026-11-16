"""Direct message lookup does not depend on the memory index."""

import asyncio
import json
import threading

import httpx
import pytest

from cli import main as cli_main
from models.chat_session import ChatMessage
from models.fields import utc_now
from services.tool_registry import WorkstepClient
from tests.test_chat_session import chat_module


def test_message_get_cli(capsys):
    async def handler(request):
        assert request.method == "GET"
        assert request.url.path == "/api/chat-sessions/session-1/messages/message-1"
        assert dict(request.url.params) == {}
        return httpx.Response(200, json={"id": "message-1", "content": "原始消息"})

    assert cli_main(["message", "get", "--session", "session-1", "--message", "message-1", "--json"],
                    client=WorkstepClient(transport=httpx.MockTransport(handler))) == 0
    assert json.loads(capsys.readouterr().out)["content"] == "原始消息"


def test_message_get_explicit_project_and_failure(capsys):
    async def handler(request):
        assert dict(request.url.params) == {"project_id": "p1"}
        return httpx.Response(404, json={"detail": "Chat message not found"})

    assert cli_main(["message", "get", "--project", "p1", "--session", "s1", "--message", "m1", "--json"],
                    client=WorkstepClient(transport=httpx.MockTransport(handler))) == 1
    assert json.loads(capsys.readouterr().out)["ok"] is False


@pytest.mark.anyio
async def test_message_api_exact_lookup_legacy_and_scope(chat_module, monkeypatch):
    import main
    from api.chat_session import get_message
    from fastapi import HTTPException
    from services.remote_access import ActorSnapshot, actor_context

    module, _, manager, project, _ = chat_module
    monkeypatch.setattr(main, "project_manager", manager)
    session = await manager.run_db(project.id, lambda _: module.create_session(project.id))
    other = await manager.run_db(project.id, lambda _: module.create_session(project.id))
    legacy_id = "a16b95dd-0804-4f58-8b3a-d896f7fe2724"

    def seed(_):
        from models.chat_session import ChatSession
        ChatSession.create(id=legacy_id, project_id=project.id, workflow_id="", engine="claude",
                           created_at=utc_now(), updated_at=utc_now())
        for sid, mid in ((session["id"], "m1"), (legacy_id, "old")):
            ChatMessage.create(id=mid, session=sid, role="user", content="完整原文" * 2000,
                               created_at=utc_now())
    await manager.run_db(project.id, seed)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://test") as client:
        for sid, mid in ((session["id"], "m1"), (legacy_id, "old")):
            response = await client.get(f"/api/chat-sessions/{sid}/messages/{mid}")
            assert response.status_code == 200
            assert response.json()["content"] == "完整原文" * 2000
            assert response.json()["project_id"] == project.id
        assert (await client.get(f"/api/chat-sessions/{other['id']}/messages/m1")).status_code == 404
        assert (await client.get(f"/api/chat-sessions/{session['id']}/messages/missing")).status_code == 404
    actor = ActorSnapshot(actor_id="reader", user_name="reader", device_id="d", device_name="d",
                          source="managed", project_id="private", access_level="read")
    with actor_context(actor), pytest.raises(HTTPException) as denied:
        await get_message(session["id"], "m1", project_id=project.id)
    assert denied.value.status_code == 403
    with actor_context(actor), pytest.raises(HTTPException) as denied:
        await get_message(session["id"], "m1", project_id=None)
    assert denied.value.status_code == 403
    with actor_context(actor), pytest.raises(HTTPException) as missing:
        await get_message(legacy_id, "old", project_id=None)
    assert missing.value.status_code == 404

    # Exercise the complete CLI dispatch -> HTTP -> real project DB path.
    from cli import build_parser, dispatch
    result = await dispatch(
        build_parser().parse_args(["message", "get", "--session", session["id"], "--message", "m1"]),
        WorkstepClient(base_url="http://test", transport=httpx.ASGITransport(app=main.app)),
    )
    assert result["content"] == "完整原文" * 2000


@pytest.mark.anyio
async def test_message_lookup_slow_sql_keeps_health_responsive(chat_module, monkeypatch):
    import main
    module, _, manager, project, _ = chat_module
    monkeypatch.setattr(main, "project_manager", manager)
    session = await manager.run_db(project.id, lambda _: module.create_session(project.id))
    entered, release = threading.Event(), threading.Event()
    execute_sql = project.db.execute_sql

    def slow_sql(sql, *args, **kwargs):
        if "chat_messages" in sql:
            entered.set()
            release.wait(2)
        return execute_sql(sql, *args, **kwargs)

    monkeypatch.setattr(project.db, "execute_sql", slow_sql)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://test") as client:
        pending = asyncio.create_task(client.get(f"/api/chat-sessions/{session['id']}/messages/missing"))
        try:
            assert await asyncio.to_thread(entered.wait, 2)
            assert (await asyncio.wait_for(client.get("/api/health"), 0.5)).status_code == 200
        finally:
            release.set()
            await pending


def test_session_id_contains_project_and_preserves_uniqueness():
    from services.chat_identity import new_session_id, session_project_id
    project = "5739c385-0f1b-4292-bd18-5beeb30f71fa"
    first, second = new_session_id(project), new_session_id(project)
    assert first != second
    assert first.rsplit("-", 4)[0] == project
    assert session_project_id(first) == project
    assert session_project_id("a16b95dd-0804-4f58-8b3a-d896f7fe2724") is None


def test_message_cli_derives_project_from_session(capsys):
    from services.chat_identity import new_session_id
    project = "5739c385-0f1b-4292-bd18-5beeb30f71fa"
    session = new_session_id(project)

    async def handler(request):
        assert dict(request.url.params) == {"project_id": project}
        return httpx.Response(200, json={"id": "m", "content": "原文"})

    assert cli_main(["message", "get", "--session", session, "--message", "m", "--fields", "content", "--json"],
                    client=WorkstepClient(transport=httpx.MockTransport(handler))) == 0
    assert json.loads(capsys.readouterr().out) == {"content": "原文"}


@pytest.mark.anyio
async def test_prefixed_lookup_opens_only_addressed_project(chat_module, tmp_path, monkeypatch):
    from services.chat_identity import session_project_id
    from services.chat_message_read import read_message
    module, _, manager, project, _ = chat_module
    other = manager.init_project(tmp_path / "other-project")
    session = await manager.run_db(project.id, lambda _: module.create_session(project.id))
    assert session_project_id(session["id"]) == project.id
    await manager.run_db(project.id, lambda _: ChatMessage.create(
        id="m", session=session["id"], role="user", content="unindexed", created_at=utc_now(),
    ))

    def forbidden(*args, **kwargs):
        pytest.fail("Prefixed session must not scan projects")
    monkeypatch.setattr(manager, "list_project_catalog", forbidden)
    monkeypatch.setattr(other.db, "execute_sql", forbidden)
    assert (await read_message(manager, session["id"], "m"))["content"] == "unindexed"
    with pytest.raises(ValueError, match="does not match"):
        await read_message(manager, session["id"], "m", other.id)


def test_message_skill_has_direct_discovery_entry():
    from pathlib import Path
    root = Path(__file__).parents[1] / "data/skills/workstep-cli"
    assert 'references/messages.md' in (root / 'SKILL.md').read_text()
    assert 'message get --session <session_id> --message <message_id>' in (root / 'references/messages.md').read_text()
