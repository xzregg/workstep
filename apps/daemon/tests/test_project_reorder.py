"""Project list reordering — config sort_order support."""

import pytest

pytest_plugins = ["tests.test_api_contracts"]


@pytest.mark.anyio
async def test_reorder_projects_api(api_context):
    """Reordering via the API is reflected in the project list."""
    client, tmp_path = api_context
    dirs = [tmp_path / f"proj-{i}" for i in range(3)]
    ids = []
    for d in dirs:
        d.mkdir()
        res = await client.post("/api/project/init", json={"path": str(d)})
        assert res.status_code == 200
        ids.append(res.json()["id"])

    listed = await client.get("/api/project/list")
    assert [p["id"] for p in listed.json()["projects"]] == ids

    res = await client.post(
        "/api/project/reorder",
        json={"ordered_ids": [ids[2], ids[0], ids[1]]},
    )
    assert res.status_code == 200

    listed = await client.get("/api/project/list")
    assert [p["id"] for p in listed.json()["projects"]] == [ids[2], ids[0], ids[1]]


def test_project_reorder_persists_config_order(tmp_path, monkeypatch):
    """reorder_projects persists sort_order and a fresh manager restores it."""
    from services import project as project_service
    from services.project import ProjectManager
    from tests.test_api_contracts import MemoryConfigStore, api_context  # noqa: F401

    store = MemoryConfigStore()
    monkeypatch.setattr(project_service, "config_store", store)
    manager = ProjectManager()
    try:
        dirs = [tmp_path / f"proj-{i}" for i in range(3)]
        for d in dirs:
            d.mkdir()
            manager.init_project(d)

        ids = [proj.id for proj in manager.iter_projects()]
        manager.reorder_projects([ids[2], ids[0], ids[1]])
        assert [proj.id for proj in manager.iter_projects()] == [ids[2], ids[0], ids[1]]

        entries = store.get("projects")
        assert [entry["id"] for entry in entries] == [ids[2], ids[0], ids[1]]
        assert [entry["sort_order"] for entry in entries] == [0, 1, 2]

        fresh = ProjectManager()
        fresh._load_saved_projects()
        assert [proj.id for proj in fresh.iter_projects()] == [ids[2], ids[0], ids[1]]
        fresh.close_all()
    finally:
        manager.close_all()


@pytest.mark.anyio
async def test_remote_projects_keep_mixed_order(api_context, monkeypatch):
    from api.remote_project import remote_project_registry
    from services import project as project_service

    client, tmp_path = api_context
    directory = tmp_path / "local"
    directory.mkdir()
    local_id = (await client.post("/api/project/init", json={"path": str(directory)})).json()["id"]
    monkeypatch.setattr(remote_project_registry, "list_public", lambda: [
        {"id": "remote:a", "type": "remote"}, {"id": "remote:b", "type": "remote"},
    ])
    order = ["remote:b", local_id, "remote:a"]
    response = await client.post("/api/project/reorder", json={"ordered_ids": order})
    assert response.status_code == 200
    for _ in range(2):
        listed = await client.get("/api/project/list")
        assert [p["id"] for p in listed.json()["projects"]] == order
    assert project_service.config_store.get("project_order") == order


@pytest.mark.anyio
@pytest.mark.parametrize("operation", ["read", "write"])
async def test_project_order_slow_config_keeps_health_responsive(api_context, monkeypatch, operation):
    import asyncio
    import threading
    import time
    from services import project as project_service

    client, _ = api_context
    store = project_service.config_store
    original = store.get if operation == "read" else store.set
    entered = threading.Event()

    def slow_access(key, value=None):
        if key == "project_order":
            entered.set()
            time.sleep(0.3)
        return original(key, value)

    monkeypatch.setattr(store, "get" if operation == "read" else "set", slow_access)
    pending = asyncio.create_task(
        client.get("/api/project/list") if operation == "read" else
        client.post("/api/project/reorder", json={"ordered_ids": ["remote:a"]})
    )
    assert await asyncio.to_thread(entered.wait, 2)
    started = time.monotonic()
    assert (await client.get("/api/health")).status_code == 200
    assert time.monotonic() - started < 0.15
    assert (await pending).status_code == 200
