"""CLI lookup and submission for project chat messages."""

import asyncio
import json
import threading

import httpx
import pytest

from cli import build_parser, dispatch, main as cli_main
from models.chat_session import ChatMessage, ChatSession
from models.fields import utc_now
from services.tool_registry import WorkstepClient
from tests.test_chat_session import _wait_turn, chat_module


def send_args(project, session, content, *options):
    return ["message", "send", "--project", project, "--session", session,
            "--content", content, *options, "--json"]


def test_message_send_cli(capsys):
    from uuid import UUID

    async def handler(request):
        assert request.method == "POST"
        assert request.url.path == "/api/chat-sessions/s1/chat"
        assert dict(request.url.params) == {"project_id": "p1"}
        assert json.loads(request.content) == {"project_id": "p1", "content": "执行现有对话\n里的任务"}
        assert UUID(request.headers["Idempotency-Key"]).version == 4
        return httpx.Response(200, json={"status": "queued", "session_id": "s1",
                                         "turn_id": "t1", "assistant_message_id": "a1"})

    client = WorkstepClient(transport=httpx.MockTransport(handler))
    assert cli_main(send_args("p1", "s1", "执行现有对话\n里的任务"), client=client) == 0
    assert json.loads(capsys.readouterr().out) == {
        "status": "queued", "session_id": "s1", "turn_id": "t1", "assistant_message_id": "a1",
    }


def test_message_send_cli_reports_http_error(capsys):
    async def handler(request):
        assert request.headers["Idempotency-Key"] == "retry-key"
        return httpx.Response(403, json={"detail": "Project scope denied"})

    client = WorkstepClient(transport=httpx.MockTransport(handler))
    assert cli_main(send_args("p1", "s1", "hello", "--idempotency-key", "retry-key"), client=client) == 1
    assert json.loads(capsys.readouterr().out) == {"ok": False, "error": "Project scope denied"}


@pytest.mark.anyio
async def test_message_send_can_only_submit_with_confirmation_and_valid_input():
    from services.remote_access import ActorSnapshot, actor_context

    def unexpected(_request):
        pytest.fail("Invalid send reached the daemon")

    client = WorkstepClient(transport=httpx.MockTransport(unexpected))
    args = {"project_id": "p1", "session_id": "s1", "content": "follow up"}
    for overrides in ({}, {"confirm": "yes", "content": "  "},
                      {"confirm": "yes", "session_id": "../elsewhere"},
                      {"confirm": "yes", "idempotency_key": "newline\n"}):
        result = await client.call("workstep_send_message", {**args, **overrides})
        assert result["ok"] is False
    for scope, level in (("p1", "read"), ("p2", "edit")):
        actor = ActorSnapshot("visitor", "访客", "device", "设备", "managed",
                              project_id=scope, access_level=level)
        with actor_context(actor):
            result = await client.call("workstep_send_message", {**args, "confirm": "yes"})
        assert result == {"ok": False, "error": "Project scope denied"}


@pytest.mark.anyio
async def test_message_send_queues_behind_existing_chat_and_preserves_context(chat_module, monkeypatch):
    import main

    module, _, manager, project, _ = chat_module
    monkeypatch.setattr(main, "project_manager", manager)
    monkeypatch.setattr(main, "chat_session_module", module)
    session = await manager.run_db(project.id, lambda _: module.create_session(project.id))
    sid = session["id"]
    entered, release = asyncio.Event(), asyncio.Event()
    prompts = []

    async def invoke(_engine, _model, _cwd, prompt, _session_id, _on_event, **kwargs):
        prompts.append(prompt)
        if len(prompts) == 1:
            entered.set()
            await release.wait()
            return "reply from the first turn", [], "native-thread"
        return "follow-up complete", [], "native-thread"

    monkeypatch.setattr(module, "_invoke", invoke)
    transport = httpx.ASGITransport(app=main.app)
    cli = WorkstepClient(base_url="http://test", transport=transport)
    parser = build_parser()
    async with httpx.AsyncClient(base_url="http://test", transport=transport) as http:
        first = await http.post(f"/api/chat-sessions/{sid}/chat",
                                json={"project_id": project.id, "content": "first turn"},
                                headers={"Idempotency-Key": "first"})
        assert first.status_code == 200, first.text
        first_turn = first.json()["turn_id"]
        args = parser.parse_args(send_args(project.id, sid, "second turn", "--idempotency-key", "second"))
        try:
            await asyncio.wait_for(entered.wait(), 3)
            queued = await dispatch(args, cli)
            assert queued["status"] == "queued"
            assert queued["session_id"] == sid
            assert queued["turn_id"] != first_turn
            assert await dispatch(args, cli) == queued
            assert module._turn_states[first_turn]["status"] == "running"
            assert len(prompts) == 1
        finally:
            release.set()
        assert await _wait_turn(module, first_turn) == "completed"
        assert await _wait_turn(module, queued["turn_id"]) == "completed"
        replay = await dispatch(args, cli)
        assert replay["status"] == "completed"
        assert replay["assistant_message_id"] == queued["assistant_message_id"]
        detail = await http.get(f"/api/chat-sessions/{sid}", params={"project_id": project.id})
        assert [message["content"] for message in detail.json()["messages"]] == [
            "first turn", "reply from the first turn", "second turn", "follow-up complete",
        ]
    assert len(prompts) == 2
    assert "reply from the first turn" in prompts[1]
    assert "second turn" in prompts[1]


@pytest.mark.anyio
async def test_message_send_legacy_scope_and_health(chat_module, monkeypatch, tmp_path):
    import main
    from services.remote_access import ActorSnapshot, actor_context

    module, _, manager, project, _ = chat_module
    monkeypatch.setattr(main, "project_manager", manager)
    monkeypatch.setattr(main, "chat_session_module", module)
    other = manager.init_project(tmp_path / "other-chat-project")
    legacy_id = "a16b95dd-0804-4f58-8b3a-d896f7fe2724"
    await manager.run_db(project.id, lambda _: ChatSession.create(
        id=legacy_id, project_id=project.id, workflow_id="", engine="claude",
        created_at=utc_now(), updated_at=utc_now(),
    ))
    # A row physically present in a DB must still belong to the requested project.
    await manager.run_db(other.id, lambda _: ChatSession.create(
        id=legacy_id, project_id=project.id, workflow_id="", engine="claude",
        created_at=utc_now(), updated_at=utc_now(),
    ))

    async def invoke(*args, **kwargs):
        return "ok", [], None

    monkeypatch.setattr(module, "_invoke", invoke)
    transport = httpx.ASGITransport(app=main.app)
    client = WorkstepClient(base_url="http://test", transport=transport)
    args = {"project_id": project.id, "session_id": legacy_id, "content": "follow up", "confirm": "yes"}
    async with httpx.AsyncClient(base_url="http://test", transport=transport) as http:
        for scope, level in ((project.id, "read"), (other.id, "edit")):
            actor = ActorSnapshot("visitor", "访客", "device", "设备", "managed",
                                  project_id=scope, access_level=level)
            with actor_context(actor):
                response = await http.post(f"/api/chat-sessions/{legacy_id}/chat",
                                           json={"project_id": project.id, "content": "follow up"},
                                           headers={"Idempotency-Key": "denied"})
            assert response.status_code == 403
    result = await client.call("workstep_send_message", {**args, "project_id": other.id})
    assert result["ok"] is False and "not found" in result["error"]
    result = await client.call("workstep_send_message", {**args, "project_id": "missing"})
    assert result["ok"] is False and "Project not found" in result["error"]
    assert not module._turn_states

    entered, release = threading.Event(), threading.Event()
    execute_sql = project.db.execute_sql

    def slow_sql(sql, *args, **kwargs):
        if 'FROM "chat_sessions"' in sql and not entered.is_set():
            entered.set()
            release.wait(2)
        return execute_sql(sql, *args, **kwargs)

    monkeypatch.setattr(project.db, "execute_sql", slow_sql)
    editor = ActorSnapshot("editor", "编辑者", "device", "设备", "managed",
                           project_id=project.id, access_level="edit")
    with actor_context(editor):
        pending = asyncio.create_task(client.call("workstep_send_message", args))
    try:
        assert await asyncio.to_thread(entered.wait, 2)
        async with httpx.AsyncClient(base_url="http://test", transport=transport) as http:
            assert (await asyncio.wait_for(http.get("/api/health"), 0.5)).status_code == 200
    finally:
        release.set()
        accepted = await pending
    assert accepted["status"] == "queued"
    assert await _wait_turn(module, accepted["turn_id"]) == "completed"
    assert await manager.run_db(project.id, lambda _: ChatMessage.get_by_id(accepted["turn_id"]).author_id) == "editor"


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


@pytest.mark.parametrize("project", ["164938b7", "5739c385-0f1b-4292-bd18-5beeb30f71fa"])
def test_session_id_contains_project_and_preserves_uniqueness(project):
    from services.chat_identity import new_session_id, session_project_id
    first, second = new_session_id(project), new_session_id(project)
    assert first != second
    prefix, suffix = first.rsplit("-", 1)
    assert prefix == project
    assert len(suffix) == 32 and all(char in "0123456789abcdef" for char in suffix)
    assert session_project_id(first) == project
    assert session_project_id(project + "-b447-4076-a9c0-cc3c25510c9c") == (
        project if len(project) == 36 else None
    )
    assert session_project_id("a16b95dd-0804-4f58-8b3a-d896f7fe2724") is None


@pytest.mark.parametrize("project", ["164938b7", "5739c385-0f1b-4292-bd18-5beeb30f71fa"])
def test_message_cli_derives_project_from_session(capsys, project):
    from services.chat_identity import new_session_id
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
