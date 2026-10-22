"""Archive generation cannot replace unrelated history or lose its operator."""

import asyncio
import threading
import time
from unittest.mock import AsyncMock

import pytest
from httpx import ASGITransport, AsyncClient

from models import Message, Task
from models.fields import utc_now
from services.gateway_client.bridge import ManagedHttpBridge
from tests.test_api_contracts import api_context
from workstep_gateway_protocol import FrameType, ProxyFrame


@pytest.fixture
async def archive_context(api_context, monkeypatch):
    import main

    client, tmp_path = api_context
    directory = tmp_path / "archive-message-scope"
    directory.mkdir()
    response = await client.post("/api/project/init", json={"path": str(directory)})
    project_id = response.json()["id"]

    def seed(_project):
        now = utc_now()
        for task_id in ("target", "other"):
            Task.create(id=task_id, title=task_id, cwd=str(directory),
                        creator_id="creator", creator_username="creator",
                        creator_name="Creator", created_at=now, updated_at=now)
        Message.create(id="other-draft", task="other", channel="archive_experience",
                       step_key="archive", role="assistant", content="Original other draft",
                       sequence=1, position=1, created_at=now)
        Message.create(id="execution-message", task="target", channel="execution",
                       step_key="do", role="assistant", content="Original execution",
                       sequence=1, position=1, created_at=now)

    await main.project_manager.run_db(project_id, seed)
    draft = AsyncMock(return_value="New experience")
    monkeypatch.setattr(main.coordinator_module, "draft_archive_experience", draft)
    monkeypatch.setattr(main.coordinator_module, "take_archive_experience_journal",
                        lambda *_args: None)
    monkeypatch.setattr(main.gateway_client, "managed_config", object())

    async def prepare(message_id, *, background=False, wait=True):
        frames = []

        async def capture(frame):
            frames.append(frame)

        bridge = ManagedHttpBridge(main.app, "archive-scope", {
            "method": "POST", "path": "/api/task/target/archive-experience/prepare",
            "query": f"project_id={project_id}&message_id={message_id}&background={str(background).lower()}",
            "headers": [], "user_id": "operator", "username": "alice",
            "display_name": "Alice", "project_id": project_id,
            "access_level": "edit",
        }, capture, "device-1")
        bridge.start_task()
        await bridge.feed(ProxyFrame(stream_id="archive-scope", type=FrameType.http_request,
                                     payload={"phase": "end"}))
        await asyncio.wait_for(bridge._task, 3)
        status = frames[0].payload["status"]
        if status == 202 and wait:
            for _ in range(300):
                await asyncio.sleep(0.01)
                status = await prepare(message_id, background=True, wait=False)
                if status != 202:
                    break
        return status

    async def read(message_id):
        def operation(_project):
            row = Message.get_by_id(message_id)
            return {"content": row.content, "author_type": row.author_type,
                    "initiated_by_user_id": row.initiated_by_user_id,
                    "initiated_by_username": row.initiated_by_username}
        return await main.project_manager.run_db(project_id, operation)

    return prepare, read, draft, project_id


@pytest.mark.anyio
@pytest.mark.parametrize("message_id", ["other-draft", "execution-message"])
@pytest.mark.parametrize("background", [False, True])
async def test_archive_rejects_unrelated_message_before_model_call(archive_context, message_id, background):
    prepare, read, draft, _ = archive_context
    before = await read(message_id)
    assert await prepare(message_id, background=background) == 404
    assert await read(message_id) == before
    draft.assert_not_awaited()


@pytest.mark.anyio
@pytest.mark.parametrize("background", [False, True])
async def test_archive_rechecks_message_ownership_after_generation(archive_context, background):
    import main

    prepare, read, draft, project_id = archive_context

    async def collision(*_args):
        await main.project_manager.run_db(project_id, lambda _project: Message.create(
            id="racing-message", task="other", channel="archive_experience",
            step_key="archive", role="assistant", content="Other task wins", sequence=2,
            position=1, created_at=utc_now(),
        ))
        return "New experience"

    draft.side_effect = collision
    assert await prepare("racing-message", background=background) == 404
    assert (await read("racing-message"))["content"] == "Other task wins"


@pytest.mark.anyio
async def test_archive_draft_records_current_operator_on_create_and_regenerate(archive_context):
    prepare, read, _, _ = archive_context
    for _ in range(2):
        assert await prepare("own-draft") == 200
        row = await read("own-draft")
        assert row["author_type"] == "assistant"
        assert (row["initiated_by_user_id"], row["initiated_by_username"]) == (
            "operator", "alice",
        )


@pytest.mark.anyio
@pytest.mark.parametrize("background", [False, True])
async def test_slow_archive_message_validation_keeps_health_responsive(
    archive_context, monkeypatch, background,
):
    import services.task_archive as archive_service
    import main

    prepare, _, _, _ = archive_context
    entered = threading.Event()
    original = archive_service._archive_draft_message

    def delayed(*args):
        entered.set()
        time.sleep(0.7)
        return original(*args)

    monkeypatch.setattr(archive_service, "_archive_draft_message", delayed)
    pending = asyncio.create_task(prepare("slow-draft", background=background))
    assert await asyncio.to_thread(entered.wait, 2)
    started = time.monotonic()
    async with AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test") as client:
        assert (await client.get("/api/health")).status_code == 200
    assert time.monotonic() - started < 0.5
    assert await pending == 200


@pytest.mark.anyio
async def test_background_archive_outlives_managed_stream_and_keeps_initiator(archive_context):
    prepare, read, draft, _ = archive_context
    entered = asyncio.Event()
    release = asyncio.Event()

    async def delayed(*_args):
        entered.set()
        await release.wait()
        return "New experience"

    draft.side_effect = delayed
    try:
        assert await prepare("detached-draft", background=True, wait=False) == 202
        await asyncio.wait_for(entered.wait(), 0.5)
        # The initiating bridge has fully exited; a second bridge polls the same job.
        assert await prepare("detached-draft", background=True, wait=False) == 202
    finally:
        release.set()
    assert await prepare("detached-draft", background=True) == 200
    assert await prepare("detached-draft", background=True) == 200
    draft.assert_awaited_once()
    row = await read("detached-draft")
    assert (row["initiated_by_user_id"], row["initiated_by_username"]) == ("operator", "alice")
