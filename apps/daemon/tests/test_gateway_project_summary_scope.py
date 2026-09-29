"""A project ticket cannot read another project's summary directly."""

from fastapi import HTTPException
import pytest

from services.remote_access import ActorSnapshot, actor_context
from tests.test_api_contracts import api_context


@pytest.mark.anyio
async def test_project_summary_requires_bound_project(api_context):
    import api.project as project_api

    client, tmp_path = api_context
    projects = []
    for name in ("visible-summary", "private-summary"):
        directory = tmp_path / name
        directory.mkdir()
        response = await client.post("/api/project/init", json={"path": str(directory)})
        assert response.status_code == 200
        projects.append(response.json()["id"])
    visible, private = projects
    actor = ActorSnapshot(actor_id="worker", user_name="worker", device_id="device-1",
                          device_name="Device", source="managed", project_id=visible,
                          access_level="read")
    with actor_context(actor):
        own = await project_api.get_project_summary(visible)
        assert own["id"] == visible
        with pytest.raises(HTTPException) as denied:
            await project_api.get_project_summary(private)
        assert denied.value.status_code == 403


@pytest.mark.anyio
async def test_project_ticket_cannot_enumerate_local_projects_directly(api_context):
    import api.project as project_api

    client, tmp_path = api_context
    directory = tmp_path / "visible-list"
    directory.mkdir()
    response = await client.post("/api/project/init", json={"path": str(directory)})
    assert response.status_code == 200
    project_id = response.json()["id"]
    actor = ActorSnapshot(actor_id="worker", user_name="worker", device_id="device-1",
                          device_name="Device", source="managed", project_id=project_id,
                          access_level="read")
    with actor_context(actor):
        with pytest.raises(HTTPException) as denied:
            await project_api.list_projects()
        assert denied.value.status_code == 403
