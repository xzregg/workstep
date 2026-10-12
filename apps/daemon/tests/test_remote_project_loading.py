"""Remote metadata reads avoid full project scans and keep I/O off the loop."""

import asyncio
import threading
from types import SimpleNamespace
from urllib.parse import quote

from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

import api.remote_project as remote_api
import streaming.ws as ws_module
from services.remote_access import _current_actor
from services.remote_project import RemoteAccessService, RemoteProjectRegistry
from tests.test_project import manager  # noqa: F401 — pytest fixture
from tests.test_remote_project import MemoryConfig


async def test_remote_snapshot_api_reads_only_cached_metadata_without_credentials(monkeypatch):
    config = MemoryConfig()
    access = RemoteAccessService(config)
    access.update_settings(enabled=True, internal_base_url="http://host:8765", external_base_url="")
    share = access.create_share(project_id="host-project", project_name="Remote", access="internal")
    registry = RemoteProjectRegistry(config)
    remote = registry.add_from_share(share["share_string"])
    registry.mark_authenticated(remote["id"], credential="test-credential", project={
        "name": "Remote", "steps": {}, "workflows": [{"id": "flow"}],
    })
    entered, release = threading.Event(), threading.Event()
    original_get = registry.get

    def slow_get(project_id):
        entered.set()
        release.wait(timeout=1)
        return original_get(project_id)

    monkeypatch.setattr(registry, "get", slow_get)
    monkeypatch.setattr(remote_api, "remote_project_registry", registry)
    app = FastAPI()
    app.include_router(remote_api.router)

    @app.get("/health")
    async def health():
        return {"ok": True}

    path = f'/api/remote-project/{quote(remote["id"], safe="")}/summary'
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        pending = asyncio.create_task(client.get(path))
        try:
            assert await asyncio.to_thread(entered.wait, 1)
            assert not pending.done()
            assert (await asyncio.wait_for(client.get("/health"), 0.1)).json() == {"ok": True}
        finally:
            release.set()
        response = await pending
        assert response.status_code == 200
        assert response.json()["workflows"] == [{"id": "flow"}]
        assert "credential" not in response.json()
        assert "invite_token" not in response.json()
        assert (await client.get('/api/remote-project/unknown/summary')).status_code == 404
        token = _current_actor.set(SimpleNamespace(project_id="another-project"))
        try:
            assert (await client.get(path)).status_code == 403
        finally:
            _current_actor.reset(token)


async def test_host_summary_uses_only_its_project_executor_and_slow_sql_does_not_block_health(manager, tmp_path, monkeypatch):
    project_manager, _, _ = manager
    wanted = await asyncio.to_thread(project_manager.init_project, tmp_path / "wanted")
    await asyncio.to_thread(project_manager.init_project, tmp_path / "unrelated")
    monkeypatch.setattr(ws_module, "_main", lambda: SimpleNamespace(project_manager=project_manager))

    def forbid_scan():
        raise AssertionError("metadata refresh scanned all project databases")

    monkeypatch.setattr(project_manager, "list_projects", forbid_scan)
    entered, release = threading.Event(), threading.Event()
    calls = []
    original_summary = project_manager.project_summary

    def slow_summary(project):
        calls.append(project.id)
        project.db.execute_sql("SELECT 1").fetchone()
        entered.set()
        release.wait(timeout=1)
        return original_summary(project)

    monkeypatch.setattr(project_manager, "project_summary", slow_summary)
    app = FastAPI()

    @app.get("/summary/{project_id}")
    async def summary(project_id: str):
        return await ws_module._local_project_summary(project_id)

    @app.get("/health")
    async def health():
        return {"ok": True}

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        pending = asyncio.create_task(client.get(f'/summary/{wanted.id}'))
        try:
            assert await asyncio.to_thread(entered.wait, 1)
            assert not pending.done()
            assert (await asyncio.wait_for(client.get("/health"), 0.1)).json() == {"ok": True}
        finally:
            release.set()
        assert (await pending).json()["id"] == wanted.id
        assert calls == [wanted.id]
