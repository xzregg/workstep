"""WorkStep internal tool registry and HTTP client contracts."""

import json

import httpx
import pytest

from services.tool_registry import (
    TOOL_BY_NAME,
    WORKSTEP_TOOLS,
    WorkstepClient,
    tool_documentation,
)


def test_registry_defines_expected_tool_set():
    names = {tool.name for tool in WORKSTEP_TOOLS}
    assert names == {
        "workstep_list_projects",
        "workstep_get_project",
        "workstep_list_tasks",
        "workstep_get_task",
        "workstep_list_engines",
        "workstep_create_project",
        "workstep_create_task",
        "workstep_list_schedules",
        "workstep_get_schedule",
        "workstep_create_schedule",
        "workstep_update_schedule",
        "workstep_pause_schedule",
        "workstep_resume_schedule",
        "workstep_delete_schedule",
        "workstep_list_schedule_runs",
    }
    by_name = {tool.name: tool for tool in WORKSTEP_TOOLS}
    assert by_name["workstep_list_projects"].read_only is True
    assert by_name["workstep_create_task"].read_only is False
    assert by_name["workstep_create_task"].method == "POST"
    assert by_name["workstep_create_task"].path == "/api/task/create"
    assert by_name["workstep_get_task"].path == "/api/task/{task_id}"


def test_registry_lookup_and_documentation():
    assert TOOL_BY_NAME["workstep_list_projects"].description
    docs = tool_documentation()
    for tool in WORKSTEP_TOOLS:
        assert tool.name in docs
        assert tool.description in docs
    assert "confirm" in docs


@pytest.mark.anyio
async def test_client_reads_project_list():
    captured = {}

    async def handler(request):
        captured["method"] = request.method
        captured["url"] = str(request.url)
        return httpx.Response(200, json={"projects": []})

    client = WorkstepClient(transport=httpx.MockTransport(handler))
    result = await client.call("workstep_list_projects", {})
    assert result == {"projects": []}
    assert captured["method"] == "GET"
    assert captured["url"].endswith("/api/project/list")


@pytest.mark.anyio
async def test_client_get_project_filters_by_id():
    async def handler(request):
        return httpx.Response(200, json={"projects": [
            {"id": "proj-a", "name": "A", "path": "/tmp/a"},
            {"id": "proj-b", "name": "B", "path": "/tmp/b"},
        ]})

    client = WorkstepClient(transport=httpx.MockTransport(handler))
    result = await client.call("workstep_get_project", {"project_id": "proj-b"})
    assert result["id"] == "proj-b"
    assert result["name"] == "B"


@pytest.mark.anyio
async def test_client_get_project_missing_returns_error():
    async def handler(request):
        return httpx.Response(200, json={"projects": []})

    client = WorkstepClient(transport=httpx.MockTransport(handler))
    result = await client.call("workstep_get_project", {"project_id": "nope"})
    assert result["ok"] is False
    assert "error" in result


@pytest.mark.anyio
async def test_client_get_task_builds_path_and_query():
    captured = {}

    async def handler(request):
        captured["url"] = str(request.url)
        return httpx.Response(200, json={"id": "task-1", "title": "T"})

    client = WorkstepClient(transport=httpx.MockTransport(handler))
    result = await client.call(
        "workstep_get_task", {"project_id": "p1", "task_id": "task-1"}
    )
    assert result["id"] == "task-1"
    assert "/api/task/task-1" in captured["url"]
    assert "project_id=p1" in captured["url"]


@pytest.mark.anyio
async def test_client_create_task_posts_body_with_confirm():
    captured = {}

    async def handler(request):
        captured["method"] = request.method
        captured["url"] = str(request.url)
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"id": "task-new", "title": "T"})

    client = WorkstepClient(transport=httpx.MockTransport(handler))
    result = await client.call("workstep_create_task", {
        "project_id": "p1",
        "title": "新任务",
        "cwd": "/tmp/p1",
        "confirm": "yes",
    })
    assert result["id"] == "task-new"
    assert captured["method"] == "POST"
    assert "project_id=p1" in captured["url"]
    assert captured["body"]["title"] == "新任务"
    assert captured["body"]["cwd"] == "/tmp/p1"
    assert "confirm" not in captured["body"]


@pytest.mark.anyio
async def test_client_create_task_defaults_cwd_to_project_path():
    async def handler(request):
        if request.url.path == "/api/project/list":
            return httpx.Response(200, json={"projects": [
                {"id": "p1", "path": "/tmp/project-a"}
            ]})
        body = json.loads(request.content)
        return httpx.Response(200, json={"id": "task-new", "cwd": body["cwd"]})

    client = WorkstepClient(transport=httpx.MockTransport(handler))
    result = await client.call("workstep_create_task", {
        "project_id": "p1",
        "title": "新任务",
        "confirm": "yes",
    })
    assert result["cwd"] == "/tmp/project-a"


@pytest.mark.anyio
async def test_client_mutating_tool_requires_confirm():
    client = WorkstepClient(transport=httpx.MockTransport(lambda r: httpx.Response(500)))
    result = await client.call("workstep_create_task", {
        "project_id": "p1",
        "title": "T",
    })
    assert result["ok"] is False
    assert "confirm" in result["error"]


@pytest.mark.anyio
async def test_client_rejects_unknown_operation():
    client = WorkstepClient(transport=httpx.MockTransport(lambda r: httpx.Response(500)))
    result = await client.call("workstep_delete_everything", {})
    assert result["ok"] is False


@pytest.mark.anyio
async def test_client_surfaces_http_errors():
    async def handler(request):
        return httpx.Response(400, json={"detail": "任务名称不能为空"})

    client = WorkstepClient(transport=httpx.MockTransport(handler))
    result = await client.call("workstep_create_project", {
        "path": "/tmp/x",
        "confirm": "yes",
    })
    assert result["ok"] is False
    assert "任务名称不能为空" in result["error"]
