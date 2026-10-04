"""Dependency direction and safe database entry points."""

import ast
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from services.project import ProjectContext


def test_services_do_not_import_api_layer():
    root = Path(__file__).parents[1] / "services"
    for path in root.rglob("*.py"):
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.ImportFrom):
                assert not (node.module or "").startswith("api."), path
            elif isinstance(node, ast.Import):
                assert all(name.name != "api" and not name.name.startswith("api.") for name in node.names), path


async def test_project_context_rejects_async_database_activation():
    database = Mock()
    context = ProjectContext(SimpleNamespace(db=database))
    with pytest.raises(RuntimeError, match="run_db"):
        async with context:
            pytest.fail("Database activation must use the project executor")
    database.connect.assert_not_called()


def test_archive_routes_delegate_database_work_to_services():
    path = Path(__file__).parents[1] / "api/task_archive.py"
    for node in ast.walk(ast.parse(path.read_text())):
        if isinstance(node, ast.ImportFrom):
            assert not (node.module or "").startswith("models"), node.lineno


def test_all_api_routes_delegate_database_work_to_services():
    root = Path(__file__).parents[1] / "api"
    violations = []
    for path in root.rglob("*.py"):
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.ImportFrom) and (node.module or "").startswith("models"):
                violations.append(f"{path.name}:{node.lineno}: {node.module}")
            if isinstance(node, ast.Import) and any(item.name.split(".")[0] == "models" for item in node.names):
                violations.append(f"{path.name}:{node.lineno}: models import")
    assert not violations, "\n".join(violations)


async def test_remote_dispatch_uses_injected_client(tmp_path):
    from services.task_dispatch import TaskDispatchService
    from streaming.bus import EventBus

    requests = []

    class Client:
        async def request(self, project_id, request):
            requests.append((project_id, request))
            body = {"steps": {"nodes": [{"id": 1, "type": "do", "title": "执行"}], "connections": []}}
            if request.method == "POST":
                body = {"id": "downstream"}
            return SimpleNamespace(status=200, json=lambda: body)

    bus = EventBus()
    service = TaskDispatchService(None, bus, None, remote_client=Client())
    try:
        result = await service._dispatch_remote(
            target_project_id="remote:target", target_workflow_id="flow", target_start_step_key="do",
            config={}, dispatch_id="dispatch", task=SimpleNamespace(
                id="source-task", title="派发", description="任务要求", workflow_id="source-flow",
            ), step=SimpleNamespace(key="dispatch", depends_on=[]), source_project_id="source",
            lineage=[], artifacts_dir=tmp_path,
        )
        assert result == {"id": "downstream"}
        assert [request.method for _, request in requests] == ["GET", "POST"]
        assert all(project_id == "remote:target" for project_id, _ in requests)
    finally:
        await bus.close()


def test_services_are_independent_of_http_framework():
    root = Path(__file__).parents[1] / "services"
    violations = []
    for path in root.rglob("*.py"):
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.ImportFrom) and (node.module or "").split(".")[0] in {"fastapi", "starlette"}:
                violations.append(f"{path.name}:{node.lineno}: {node.module}")
            if isinstance(node, ast.Import) and any(item.name.split(".")[0] in {"fastapi", "starlette"} for item in node.names):
                violations.append(f"{path.name}:{node.lineno}: HTTP framework import")
    assert not violations, "\n".join(violations)
