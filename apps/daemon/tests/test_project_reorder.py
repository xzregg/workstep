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
