import json

import httpx
import pytest

from cli import build_parser, dispatch, main as cli_main
from models.chat_session import ChatMessage, ChatSession
from models.fields import utc_now
from services.remote_access import ActorSnapshot, actor_context
from services.tool_registry import WorkstepClient
from tests.test_chat_session import chat_module


def archive_args(project_id, session_id):
    return ["session", "archive", "--project", project_id, "--session", session_id, "--json"]


@pytest.mark.parametrize("status, payload, expected", [
    (200, {"id": "s1", "archived": True}, {"id": "s1", "archived": True}),
    (409, {"detail": "Chat session is running"}, {"ok": False, "error": "Chat session is running"}),
])
def test_archive_cli_contract(capsys, status, payload, expected):
    def handler(request):
        assert request.method == "PATCH"
        assert request.url.path == "/api/chat-sessions/s1/archive"
        assert dict(request.url.params) == {"project_id": "p1"}
        assert json.loads(request.content) == {"project_id": "p1", "archived": True, "ordinary_only": True}
        return httpx.Response(status, json=payload)

    client = WorkstepClient(transport=httpx.MockTransport(handler))
    assert cli_main(archive_args("p1", "s1"), client=client) == (0 if status == 200 else 1)
    assert json.loads(capsys.readouterr().out) == expected


@pytest.mark.anyio
async def test_native_archive_requires_confirmation_safe_id_and_edit_scope():
    def unexpected(_request):
        pytest.fail("Denied archive reached the daemon")

    client = WorkstepClient(transport=httpx.MockTransport(unexpected))
    args = {"project_id": "p1", "session_id": "s1"}
    for overrides in ({}, {"confirm": "yes", "session_id": "../other"}, {"confirm": "yes", "project_id": ""}):
        result = await client.call("workstep_archive_chat_session", {**args, **overrides})
        assert result["ok"] is False
        assert "Unknown operation" not in result["error"]
    for project_id, level in (("p1", "read"), ("p2", "edit")):
        with actor_context(ActorSnapshot("user", "User", "device", "Device", "managed",
                                         project_id=project_id, access_level=level)):
            result = await client.call("workstep_archive_chat_session", {**args, "confirm": "yes"})
        assert result == {"ok": False, "error": "Project scope denied"}


@pytest.mark.anyio
async def test_archive_through_daemon_preserves_history_and_enforces_scope(chat_module, monkeypatch):
    import main

    module, _, manager, project, _ = chat_module
    monkeypatch.setattr(main, "project_manager", manager)
    monkeypatch.setattr(main, "chat_session_module", module)

    def seed(_project):
        session = module.create_session(project.id)["id"]
        empty = module.create_session(project.id)["id"]
        channel = module.create_session(project.id)["id"]
        ChatMessage.create(id="saved", session=session, role="user", content="历史", created_at=utc_now())
        ChatMessage.create(id="channel-message", session=channel, role="user", content="渠道",
                           author_id="channel:wecom:sender", author_device_id="channel:bot",
                           created_at=utc_now())
        ChatSession.create(id="wrong-owner", project_id="different", workflow_id="", engine="claude",
                           created_at=utc_now(), updated_at=utc_now())
        return session, empty, channel

    sid, empty, channel = await manager.run_db(project.id, seed)
    parser = build_parser()
    transport = httpx.ASGITransport(app=main.app)
    client = WorkstepClient(base_url="http://test", transport=transport)

    async def archive(session_id, project_id=project.id):
        return await dispatch(parser.parse_args(archive_args(project_id, session_id)), client)

    async with httpx.AsyncClient(base_url="http://test", transport=transport) as http:
        for scope, level in ((project.id, "read"), ("different", "edit")):
            with actor_context(ActorSnapshot("user", "User", "device", "Device", "managed",
                                             project_id=scope, access_level=level)):
                response = await http.patch(f"/api/chat-sessions/{sid}/archive",
                                            params={"project_id": project.id},
                                            json={"project_id": project.id, "archived": True})
            assert response.status_code == 403

        for active in ("queued", "running", "stopping"):
            module._turn_states["busy"] = {"session_id": sid, "project_id": project.id, "status": active}
            try:
                assert await archive(sid) == {"ok": False, "error": "Chat session is running"}
                assert module._turn_states["busy"]["status"] == active
            finally:
                module._turn_states.pop("busy", None)

        await manager.run_db(project.id, lambda _: ChatMessage.create(
            id="persisted", session=sid, role="assistant", status="running", created_at=utc_now()))
        assert await archive(sid) == {"ok": False, "error": "Chat session is running"}
        await manager.run_db(project.id, lambda _: ChatMessage.update(status="succeeded")
                             .where(ChatMessage.id == "persisted").execute())

        assert await archive("missing") == {"ok": False, "error": "Chat session not found"}
        assert await archive("wrong-owner") == {"ok": False, "error": "Chat session not found"}
        assert await archive(sid, "missing") == {"ok": False, "error": "Project not found: missing"}
        assert await archive(channel) == {"ok": False, "error": "The target must be an ordinary project conversation"}

        with actor_context(ActorSnapshot("editor", "Editor", "device", "Device", "managed",
                                         project_id=project.id, access_level="edit")):
            saved = await archive(sid)
        assert saved["id"] == sid and saved["archived"] is True
        assert saved["archived_at"]
        assert (await archive(sid))["archived_at"] == saved["archived_at"]
        response = await http.get(f"/api/chat-sessions/{sid}", params={"project_id": project.id})
        assert response.json()["messages"][0]["content"] == "历史"

        removed = await archive(empty)
        assert removed["deleted"] is True
        assert removed["archived"] is False
        response = await http.get(f"/api/chat-sessions/{empty}", params={"project_id": project.id})
        assert response.status_code == 404
        response = await http.get(f"/api/chat-sessions/{channel}", params={"project_id": project.id})
        assert response.json()["archived"] is False
