"""Share service tests — session tokens and per-project DB contexts."""

import asyncio

import pytest
from httpx import ASGITransport, AsyncClient

from models import db_proxy
from services.project import ProjectManager
from services.task import TaskService
from streaming.bus import EventBus
import services.project as project_service
import services.share as share_service


class MemoryConfigStore:
    """In-memory stand-in for the shared config store."""

    def __init__(self):
        self.values = {}

    def get(self, key, default=None):
        return self.values.get(key, default)

    def set(self, key, value):
        self.values[key] = value


@pytest.fixture
def manager(tmp_path, monkeypatch):
    store = MemoryConfigStore()
    monkeypatch.setattr(project_service, "config_store", store)
    pm = ProjectManager()
    # share_service resolves projects via the module-global manager.
    monkeypatch.setattr(project_service, "project_manager", pm)
    return pm


def _create_task_in_project(manager, path):
    project = manager.init_project(path)
    ts = TaskService(EventBus())
    task = ts.create_task(title="Share me", cwd=str(path))
    return project, task


def _bind(project):
    """Activate a project's DB and return the previous context token."""
    return db_proxy.activate(project.db)


def test_resolve_share_session_finds_share_across_project_dbs(manager, tmp_path):
    """A minted session resolves even when the proxy is bound to another project."""
    project_a, task_a = _create_task_in_project(manager, tmp_path / "proj-a")
    project_b = manager.init_project(tmp_path / "proj-b")

    ctx = _bind(project_a)
    try:
        share = share_service.create_share(task_a["id"])
    finally:
        db_proxy.reset(ctx)

    session_token = share_service.verify_share_password(share["token"], "")
    assert session_token is not None

    # The global db_proxy is bound to a project that does NOT contain the
    # share — resolution must still find it (regression: previously this
    # returned None and the share page failed with 401).
    ctx = _bind(project_b)
    try:
        resolved = share_service.resolve_share_session(session_token)
    finally:
        db_proxy.reset(ctx)

    assert resolved is not None
    assert resolved["task_id"] == task_a["id"]
    assert resolved["token"] == share["token"]


def test_resolve_share_session_rejects_revoked_share(manager, tmp_path):
    """A session whose share was revoked is invalidated."""
    project_a, task_a = _create_task_in_project(manager, tmp_path / "proj-a")

    ctx = _bind(project_a)
    try:
        share = share_service.create_share(task_a["id"])
        session_token = share_service.verify_share_password(share["token"], "")
        assert session_token is not None
        share_service.revoke_share(task_a["id"])
        resolved = share_service.resolve_share_session(session_token)
    finally:
        db_proxy.reset(ctx)

    assert resolved is None


def test_resolve_share_session_unknown_token(manager, tmp_path):
    """Unknown or expired tokens resolve to None."""
    assert share_service.resolve_share_session("does-not-exist") is None


def test_create_share_defaults_to_read_only_and_accepts_interactive(manager, tmp_path):
    """Share mode is persisted and exposed on both owner and public metadata."""
    project, task = _create_task_in_project(manager, tmp_path / "proj-share-mode")

    ctx = _bind(project)
    try:
        read_only = share_service.create_share(task["id"], title="read")
        interactive = share_service.create_share(
            task["id"],
            title="interactive",
            mode="interactive",
        )
        resolved = share_service.resolve_share_by_token(interactive["token"])
    finally:
        db_proxy.reset(ctx)

    assert read_only["mode"] == "read_only"
    assert interactive["mode"] == "interactive"
    assert resolved is not None
    assert resolved["share"]["mode"] == "interactive"

    session_token = share_service.verify_share_password(interactive["token"], "")
    assert session_token is not None
    context = share_service.resolve_share_session(session_token)
    assert context is not None
    assert context["mode"] == "interactive"


def test_create_share_rejects_unknown_mode(manager, tmp_path):
    """Unknown modes fail before a share row is written."""
    project, task = _create_task_in_project(manager, tmp_path / "proj-share-invalid")

    ctx = _bind(project)
    try:
        with pytest.raises(ValueError, match="unsupported share mode"):
            share_service.create_share(task["id"], mode="editor")
    finally:
        db_proxy.reset(ctx)


def test_shared_task_uses_owner_display_fields_without_private_paths(manager, tmp_path):
    """Share payload stays aligned with task detail while removing private project data."""
    project, task = _create_task_in_project(manager, tmp_path / "proj-share-fields")

    ctx = _bind(project)
    try:
        payload = share_service.load_shared_task(task["id"])
    finally:
        db_proxy.reset(ctx)

    assert payload is not None
    for key in (
        "run_round",
        "restart_from_step_key",
        "recovered_count",
        "creator_name",
        "creator_device_name",
        "scheduled_start_at",
        "completed_at",
        "duration_ms",
        "total_tokens",
    ):
        assert key in payload
    assert "cwd" not in payload
    assert "coordinator_session_id" not in payload
    assert all("session_id" not in step for step in payload["steps"])


@pytest.mark.asyncio
async def test_public_share_api_exposes_mode_and_enforces_interactive_writes(
    manager,
    tmp_path,
    monkeypatch,
):
    """Public share APIs expose mode and reject writes from read-only shares."""
    import main
    import services.project as project_service

    project, task = _create_task_in_project(manager, tmp_path / "proj-share-api")
    ts = TaskService(EventBus())
    second_task = ts.create_task(title="Second share me", cwd=str(tmp_path / "proj-share-api"))
    monkeypatch.setattr(project_service, "project_manager", manager)
    monkeypatch.setattr(main, "project_manager", manager)

    ctx = _bind(project)
    try:
        read_only = share_service.create_share(task["id"], title="read")
        interactive = share_service.create_share(
            second_task["id"],
            title="interactive",
            mode="interactive",
        )
    finally:
        db_proxy.reset(ctx)

    transport = ASGITransport(app=main.app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        read_meta = await client.get(f"/api/task-share/public/{read_only['token']}/meta")
        interactive_meta = await client.get(
            f"/api/task-share/public/{interactive['token']}/meta"
        )
        session = await client.post(
            f"/api/task-share/public/{read_only['token']}/unlock",
            json={"password": ""},
        )
        token = session.json()["session_token"]
        rejected = await client.post(
            f"/api/task-share/public/{read_only['token']}/steps/do/resume",
            headers={"X-Share-Session": token},
            json={"content": "please continue"},
        )

    assert read_meta.status_code == 200
    assert read_meta.json()["mode"] == "read_only"
    assert interactive_meta.status_code == 200
    assert interactive_meta.json()["mode"] == "interactive"
    assert rejected.status_code == 403
    assert rejected.json()["detail"] == "Share is read-only"


@pytest.mark.asyncio
async def test_public_share_exposes_task_execution_report(
    manager,
    tmp_path,
    monkeypatch,
):
    """Both share modes can read the same execution analysis as task detail."""
    import main
    import services.project as project_service

    project, task = _create_task_in_project(manager, tmp_path / "proj-share-report")
    monkeypatch.setattr(project_service, "project_manager", manager)
    monkeypatch.setattr(main, "project_manager", manager)

    ctx = _bind(project)
    try:
        share = share_service.create_share(task["id"], mode="read_only")
    finally:
        db_proxy.reset(ctx)

    transport = ASGITransport(app=main.app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        unlocked = await client.post(
            f"/api/task-share/public/{share['token']}/unlock",
            json={"password": ""},
        )
        response = await client.get(
            f"/api/task-share/public/{share['token']}/execution-report",
            headers={"X-Share-Session": unlocked.json()["session_token"]},
        )

    assert response.status_code == 200
    report = response.json()
    assert report["summary"]["run_count"] == 0
    assert report["runs"] == []
    assert report["segments"] == []


@pytest.mark.asyncio
async def test_slow_shared_execution_report_does_not_block_health(
    manager,
    tmp_path,
    monkeypatch,
):
    """The share report's synchronous database work stays off the event loop."""
    import threading
    import main
    import services.project as project_service
    import services.task_execution_report as report_service

    project, task = _create_task_in_project(manager, tmp_path / "proj-share-slow-report")
    monkeypatch.setattr(project_service, "project_manager", manager)
    monkeypatch.setattr(main, "project_manager", manager)

    ctx = _bind(project)
    try:
        share = share_service.create_share(task["id"], mode="read_only")
    finally:
        db_proxy.reset(ctx)

    started = threading.Event()
    release = threading.Event()

    def slow_report(*_args, **_kwargs):
        started.set()
        release.wait(timeout=1)
        return {"summary": {}, "runs": [], "segments": []}

    monkeypatch.setattr(report_service, "build_task_execution_report", slow_report)
    transport = ASGITransport(app=main.app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        unlocked = await client.post(
            f"/api/task-share/public/{share['token']}/unlock",
            json={"password": ""},
        )
        session_token = unlocked.json()["session_token"]
        report_task = asyncio.create_task(client.get(
            f"/api/task-share/public/{share['token']}/execution-report",
            headers={"X-Share-Session": session_token},
        ))
        assert await asyncio.to_thread(started.wait, 0.5)
        try:
            health = await asyncio.wait_for(client.get("/api/health"), timeout=0.2)
        finally:
            release.set()
        response = await report_task

    assert health.status_code == 200
    assert response.status_code == 200


@pytest.mark.asyncio
async def test_interactive_share_can_upload_and_read_message_attachments(
    manager,
    tmp_path,
    monkeypatch,
):
    """Interactive uploads stay project-scoped and are readable by the share session."""
    import base64
    import main
    import services.project as project_service

    project, task = _create_task_in_project(manager, tmp_path / "proj-share-upload")
    monkeypatch.setattr(project_service, "project_manager", manager)
    monkeypatch.setattr(main, "project_manager", manager)

    ctx = _bind(project)
    try:
        share = share_service.create_share(task["id"], mode="interactive")
    finally:
        db_proxy.reset(ctx)

    content = b"shared image bytes"
    data_url = "data:image/png;base64," + base64.b64encode(content).decode()
    transport = ASGITransport(app=main.app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        unlocked = await client.post(
            f"/api/task-share/public/{share['token']}/unlock",
            json={"password": ""},
        )
        session_token = unlocked.json()["session_token"]
        uploaded = await client.post(
            f"/api/task-share/public/{share['token']}/upload/image",
            headers={"X-Share-Session": session_token},
            json={"filename": "shot.png", "data_url": data_url, "prefix": "shared"},
        )

        assert uploaded.status_code == 200
        upload = uploaded.json()
        assert upload["url"].startswith(".workstep/uploads/shared-")
        served = await client.get(
            f"/api/task-share/public/{share['token']}/uploads/{upload['filename']}",
            params={"session": session_token},
        )

    assert served.status_code == 200
    assert served.content == content
    assert served.headers["content-security-policy"] == "sandbox"
    assert served.headers["x-content-type-options"] == "nosniff"


@pytest.mark.asyncio
async def test_read_only_share_cannot_upload_message_attachments(
    manager,
    tmp_path,
    monkeypatch,
):
    """Attachment writes follow the same interactive-share permission boundary as chat."""
    import main
    import services.project as project_service

    project, task = _create_task_in_project(manager, tmp_path / "proj-share-read-upload")
    monkeypatch.setattr(project_service, "project_manager", manager)
    monkeypatch.setattr(main, "project_manager", manager)

    ctx = _bind(project)
    try:
        share = share_service.create_share(task["id"], mode="read_only")
    finally:
        db_proxy.reset(ctx)

    transport = ASGITransport(app=main.app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        unlocked = await client.post(
            f"/api/task-share/public/{share['token']}/unlock",
            json={"password": ""},
        )
        response = await client.post(
            f"/api/task-share/public/{share['token']}/upload/file",
            headers={"X-Share-Session": unlocked.json()["session_token"]},
            json={
                "filename": "notes.txt",
                "data_url": "data:text/plain;base64,aGVsbG8=",
                "prefix": "shared",
            },
        )

    assert response.status_code == 403
    assert response.json()["detail"] == "Share is read-only"


@pytest.mark.asyncio
async def test_interactive_share_routes_step_message_to_workflow_runtime(
    manager,
    tmp_path,
    monkeypatch,
):
    """An interactive share can inject a message into the shared stage."""
    import main
    import services.project as project_service

    project, task = _create_task_in_project(manager, tmp_path / "proj-share-send")
    monkeypatch.setattr(project_service, "project_manager", manager)
    monkeypatch.setattr(main, "project_manager", manager)

    ctx = _bind(project)
    try:
        share = share_service.create_share(task["id"], mode="interactive")
    finally:
        db_proxy.reset(ctx)

    calls = []

    class Runtime:
        async def send_step_message(self, project_id, task_id, step_key, content, as_guidance=False):
            calls.append((project_id, task_id, step_key, content, as_guidance))
            return {"message_id": "message-1", "step_key": step_key, "status": "queued"}

    monkeypatch.setattr(main, "workflow_runtime", Runtime())

    transport = ASGITransport(app=main.app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        unlocked = await client.post(
            f"/api/task-share/public/{share['token']}/unlock",
            json={"password": ""},
        )
        session_token = unlocked.json()["session_token"]
        response = await client.post(
            f"/api/task-share/public/{share['token']}/steps/do/message",
            headers={"X-Share-Session": session_token},
            json={"content": "continue with tests"},
        )

    assert response.status_code == 200
    assert response.json()["message_id"] == "message-1"
    assert calls == [(project.id, task["id"], "do", "continue with tests", False)]


@pytest.mark.asyncio
async def test_interactive_share_interaction_response_must_match_shared_task(
    manager,
    tmp_path,
    monkeypatch,
):
    """A share session cannot answer another task's pending intervention."""
    import main
    import services.project as project_service
    from services.intervention import intervention_manager

    project, task = _create_task_in_project(manager, tmp_path / "proj-share-interaction")
    other_project, other_task = _create_task_in_project(
        manager,
        tmp_path / "proj-share-interaction-other",
    )
    monkeypatch.setattr(project_service, "project_manager", manager)
    monkeypatch.setattr(main, "project_manager", manager)

    ctx = _bind(project)
    try:
        share = share_service.create_share(task["id"], mode="interactive")
    finally:
        db_proxy.reset(ctx)

    # Keep a real pending intervention for the other project's task.
    ctx = _bind(other_project)
    try:
        intervention_id = "interactive-share-ownership"
        pending = asyncio.create_task(
            intervention_manager.request_response(
                intervention_id,
                other_task["id"],
                "do",
                {"method": "elicitation/create"},
            )
        )
        await asyncio.sleep(0)
        assert intervention_manager.list_pending() == [intervention_id]
    finally:
        db_proxy.reset(ctx)

    transport = ASGITransport(app=main.app)
    try:
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            unlocked = await client.post(
                f"/api/task-share/public/{share['token']}/unlock",
                json={"password": ""},
            )
            session_token = unlocked.json()["session_token"]
            response = await client.post(
                f"/api/task-share/public/{share['token']}/intervention/respond",
                headers={"X-Share-Session": session_token},
                json={"intervention_id": intervention_id, "data": {"answer": "yes"}},
            )

        assert response.status_code == 404
        assert not pending.done()
        assert intervention_manager.list_pending() == [intervention_id]
    finally:
        intervention_manager.cancel(intervention_id)
        try:
            await pending
        except asyncio.CancelledError:
            pass


def test_shared_history_display_is_identical_across_share_modes():
    """Share mode changes the composer only, never the visible event history."""
    events = [
        {"type": "CUSTOM", "name": "workstep.interaction_request"},
        {"type": "CUSTOM", "name": "workstep.interaction_response"},
        {"type": "CUSTOM", "name": "workstep.engine_state"},
        {"type": "TEXT_MESSAGE_CHUNK"},
    ]

    read_only = share_service._scrub_events(events, mode="read_only")
    interactive = share_service._scrub_events(events, mode="interactive")

    assert [event.get("name") or event["type"] for event in read_only] == ["TEXT_MESSAGE_CHUNK"]
    assert interactive == read_only
