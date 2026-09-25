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
        "workstep_get_project_quick_buttons",
        "workstep_set_project_quick_buttons",
        "workstep_get_project_quick_buttons",
        "workstep_set_project_quick_buttons",
        "workstep_create_project_action",
        "workstep_list_workflows",
        "workstep_get_workflow",
        "workstep_create_workflow_action",
        "workstep_list_tasks",
        "workstep_get_task",
        "workstep_list_git_repositories",
        "workstep_get_task_workspace",
        "workstep_add_task_worktree",
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
    assert by_name["workstep_list_workflows"].path == "/api/workflow/list"
    assert by_name["workstep_get_workflow"].path == "/api/workflow/{workflow_id}"
    assert by_name["workstep_create_project_action"].path == "/api/projects/{project_id}/actions"
    assert by_name["workstep_create_workflow_action"].path == "/api/workflow/{workflow_id}/actions"
    assert "workflow_id" in by_name["workstep_create_task"].body_params
    assert "start_step_key" in by_name["workstep_create_task"].body_params
    assert by_name["workstep_add_task_worktree"].read_only is False


@pytest.mark.anyio
async def test_client_create_workflow_action_requires_confirmation():
    calls = []

    async def handler(request):
        calls.append((request.method, request.url.path, json.loads(request.content)))
        return httpx.Response(200, json={"action_id": "start-services"})

    client = WorkstepClient(transport=httpx.MockTransport(handler))
    args = {
        "project_id": "p", "workflow_id": "w", "action_id": "start-services",
        "title": "启动服务", "script_path": "start.sh",
        "script_content": "#!/bin/bash\necho ready\n",
    }
    rejected = await client.call("workstep_create_workflow_action", args)
    assert rejected["ok"] is False
    assert calls == []
    await client.call("workstep_create_workflow_action", {**args, "confirm": "yes"})
    assert calls == [("POST", "/api/workflow/w/actions", {
        "action_id": "start-services", "title": "启动服务",
        "script_path": "start.sh", "script_content": args["script_content"],
    })]


@pytest.mark.anyio
async def test_client_creates_task_worktree_only_with_confirmation():
    calls = []

    async def handler(request):
        calls.append((request.method, request.url.path, json.loads(request.content)))
        return httpx.Response(200, json={"path": "/project/.workstep/worktrees/t", "worktrees": []})

    client = WorkstepClient(transport=httpx.MockTransport(handler))
    arguments = {"project_id": "p", "task_id": "t", "repository_id": "repo", "alias": "api"}
    rejected = await client.call("workstep_add_task_worktree", arguments)
    assert rejected["ok"] is False
    assert calls == []
    await client.call("workstep_add_task_worktree", {**arguments, "confirm": "yes"})
    assert calls == [("POST", "/api/git/projects/p/tasks/t/worktrees", {"repository_id": "repo", "alias": "api"})]


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
async def test_client_forwards_packaged_desktop_token(monkeypatch):
    captured = {}

    async def handler(request):
        captured["token"] = request.headers.get("x-workstep-desktop-token")
        return httpx.Response(200, json={"projects": []})

    monkeypatch.setenv("WORKSTEP_DESKTOP_TOKEN", "desktop-secret")
    client = WorkstepClient(transport=httpx.MockTransport(handler))

    await client.call("workstep_list_projects", {})

    assert captured["token"] == "desktop-secret"


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
async def test_client_lists_and_gets_project_workflows():
    calls = []

    async def handler(request):
        calls.append((request.url.path, dict(request.url.params)))
        return httpx.Response(200, json={"workflows": []})

    client = WorkstepClient(transport=httpx.MockTransport(handler))
    await client.call("workstep_list_workflows", {"project_id": "p1"})
    await client.call("workstep_get_workflow", {
        "project_id": "p1", "workflow_id": "w1",
    })

    assert calls == [
        ("/api/workflow/list", {"project_id": "p1"}),
        ("/api/workflow/w1", {"project_id": "p1"}),
    ]


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
        "workflow_id": "w1",
        "start_step_key": "research",
        "confirm": "yes",
    })
    assert result["id"] == "task-new"
    assert captured["method"] == "POST"
    assert "project_id=p1" in captured["url"]
    assert captured["body"]["title"] == "新任务"
    assert captured["body"]["cwd"] == "/tmp/p1"
    assert captured["body"]["workflow_id"] == "w1"
    assert captured["body"]["start_step_key"] == "research"
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
