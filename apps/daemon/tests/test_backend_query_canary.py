"""Real read routes remain responsive while their database worker is busy."""

import asyncio
import threading

import pytest
from models import Task, ReviewRun
from models.fields import utc_now
from tests.test_api_contracts import api_context


@pytest.mark.anyio
@pytest.mark.parametrize("route,model", [
    ("/api/search/tasks", Task),
    ("/api/sessions", Task),
    ("/api/task/query-task/reviews", ReviewRun),
])
async def test_read_projection_slow_sql_keeps_health_responsive(api_context, monkeypatch, route, model):
    import main
    client, tmp_path = api_context
    root = tmp_path / "query-canary"
    root.mkdir()
    initialized = await client.post("/api/project/init", json={"path": str(root)})
    project_id = initialized.json()["id"]
    now = utc_now()
    await main.project_manager.run_db(project_id, lambda _: Task.create(
        id="query-task", title="Query task", cwd=str(root), created_at=now, updated_at=now,
    ).id)
    entered = threading.Event()
    release = threading.Event()
    original = model.select

    def slow_select(*args, **kwargs):
        entered.set()
        assert release.wait(3)
        return original(*args, **kwargs)

    monkeypatch.setattr(model, "select", slow_select)
    query = "projectId" if route == "/api/search/tasks" else "project_id"
    pending = asyncio.create_task(client.get(f"{route}?{query}={project_id}"))
    try:
        assert await asyncio.to_thread(entered.wait, 1)
        health = await asyncio.wait_for(client.get("/api/health"), timeout=0.2)
        assert health.status_code == 200
        assert not pending.done()
    finally:
        release.set()
        result = await pending
    assert result.status_code == 200, result.text
    if model is Task:
        entries = result.json()["tasks" if route == "/api/search/tasks" else "sessions"]
        assert [entry["id"] for entry in entries] == ["query-task"]
    else:
        assert result.json() == {"reviews": []}
