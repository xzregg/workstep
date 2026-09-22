"""Concurrency settings API and persistence tests."""

import asyncio

import pytest
from httpx import ASGITransport, AsyncClient

import main
import services.config as config_module
from services.config import ConfigStore


@pytest.fixture(autouse=True)
def _clean_gate():
    from services.concurrency import concurrency_gate

    concurrency_gate.reset()
    yield
    concurrency_gate.reset()


def _config_store(tmp_path, monkeypatch) -> ConfigStore:
    monkeypatch.setattr(config_module, "CONFIG_FILE", tmp_path / "config.json")
    # Clear the module singleton's cache so stale reads from other tests'
    # temp configs never leak across tests.
    monkeypatch.setattr(config_module.config_store, "_cache", None)
    return ConfigStore()


@pytest.fixture
async def api_client(tmp_path, monkeypatch):
    from services.project import ProjectManager

    store = _config_store(tmp_path, monkeypatch)
    monkeypatch.setattr(main, "config_store", store)
    manager = ProjectManager()
    project = manager.init_project(tmp_path / "project-a")
    monkeypatch.setattr(main, "project_manager", manager)
    client = AsyncClient(
        transport=ASGITransport(app=main.app),
        base_url="http://test",
    )
    yield client, store, manager, project
    await client.aclose()


# ── global API ────────────────────────────────────────────────────────

async def test_global_concurrency_round_trip(api_client):
    client, store, _manager, _project = api_client

    resp = await client.get("/api/assistant/concurrency")
    assert resp.status_code == 200
    body = resp.json()
    assert body["max_tasks"] == 0
    assert body["max_chats"] == 0
    assert body["schedule_exempt"] is False

    resp = await client.put(
        "/api/assistant/concurrency",
        json={"max_tasks": 3, "max_chats": 2, "schedule_exempt": True},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["max_tasks"] == 3
    assert body["max_chats"] == 2
    assert body["schedule_exempt"] is True
    # persisted + gate refreshed
    assert store.get_concurrency_config()["max_tasks"] == 3
    from services.concurrency import concurrency_gate

    assert concurrency_gate.effective_config("any-project")["max_tasks"] == 3

    # negative values are rejected by the schema
    resp = await client.put(
        "/api/assistant/concurrency",
        json={"max_tasks": -1, "max_chats": 2, "schedule_exempt": False},
    )
    assert resp.status_code == 422


# ── project-level API ─────────────────────────────────────────────────

async def test_project_concurrency_override_round_trip(api_client):
    client, store, manager, project = api_client

    resp = await client.get(f"/api/projects/{project.id}/settings/concurrency")
    assert resp.status_code == 200
    body = resp.json()
    assert body["project"] == {
        "max_tasks": None, "max_chats": None, "schedule_exempt": None,
    }
    assert body["global"]["max_tasks"] == 0
    assert body["effective"]["max_tasks"] == 0

    # set a project override
    resp = await client.put(
        f"/api/projects/{project.id}/settings/concurrency",
        json={"max_tasks": 1, "max_chats": None, "schedule_exempt": True},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["project"]["max_tasks"] == 1
    assert body["project"]["schedule_exempt"] is True
    # gate is synced
    from services.concurrency import concurrency_gate

    assert concurrency_gate.effective_config(project.id) == {
        "max_tasks": 1, "max_chats": 0, "schedule_exempt": True,
    }
    # other projects still follow the global default
    assert concurrency_gate.effective_config("project-b")["max_tasks"] == 0

    # clearing the override (all null) falls back to global
    resp = await client.put(
        f"/api/projects/{project.id}/settings/concurrency",
        json={"max_tasks": None, "max_chats": None, "schedule_exempt": None},
    )
    assert resp.status_code == 200
    assert concurrency_gate.effective_config(project.id)["max_tasks"] == 0
    from services.project_settings import get_concurrency_sync

    saved = await manager.run_db(
        project.id, lambda _p: get_concurrency_sync(project.id)
    )
    assert saved == {
        "max_tasks": None, "max_chats": None, "schedule_exempt": None,
    }


async def test_project_settings_aggregate(api_client):
    client, store, manager, project = api_client

    resp = await client.get(f"/api/projects/{project.id}/settings")
    assert resp.status_code == 200
    body = resp.json()
    assert body["name"] == project.name
    assert body["path"] == str(project.path)
    assert "chat_system_prompt" in body
    assert "quick_buttons" in body
    assert body["concurrency"]["global"]["max_tasks"] == 0
    assert body["concurrency"]["project"]["max_tasks"] is None
    assert body["concurrency"]["effective"]["max_tasks"] == 0


async def test_project_settings_aggregate_with_share(api_client):
    client, store, manager, project = api_client

    resp = await client.get(
        f"/api/projects/{project.id}/settings", params={"with_share": "true"}
    )
    assert resp.status_code == 200
    assert resp.json()["share"] == {"active_invites": 0, "devices": []}


async def test_project_concurrency_unknown_project_404(api_client):
    client, _store, _manager, _project = api_client

    resp = await client.get("/api/projects/does-not-exist/settings/concurrency")
    assert resp.status_code == 404


# ── persistence / sync helpers ────────────────────────────────────────

@pytest.mark.anyio
async def test_sync_all_project_configs_pushes_overrides(tmp_path, monkeypatch):
    from services.concurrency import concurrency_gate
    from services.project import ProjectManager
    from services.project_settings import set_concurrency_sync, sync_all_project_configs

    manager = ProjectManager()
    project = manager.init_project(tmp_path / "project-b")
    await manager.run_db(
        project.id,
        lambda _p: set_concurrency_sync(
            project.id, max_tasks=4, max_chats=4, schedule_exempt=False
        ),
    )
    concurrency_gate.reset()
    await sync_all_project_configs(manager)
    assert concurrency_gate.effective_config(project.id)["max_tasks"] == 4
