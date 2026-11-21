"""Debug tasks exercise the existing runtime from an explicit artifact round."""

import asyncio
from pathlib import Path

import pytest

from tests.test_api_contracts import api_context, _create_test_workflow


DRAFT = {
    "nodes": [
        {"id": 1, "type": "a", "title": "A", "outputs": [{"name": "plan", "type": "Markdown"}]},
        {"id": 2, "type": "b", "title": "B", "inputs": [{"name": "plan"}], "prompt": "Use the plan."},
    ],
    "connections": [{"from": 1, "to": 2, "fromPort": 0, "toPort": 0, "kind": "solid"}],
}


@pytest.mark.anyio
async def test_debug_starts_from_sample_and_keeps_normal_lists_clean(api_context, monkeypatch):
    import main
    from models import StepRun
    from services import task_runner
    from tests.test_pipeline import PipelineFakeEngine

    client, tmp_path = api_context
    directory = tmp_path / "debug-flow"
    directory.mkdir()
    pid = (await client.post("/api/project/init", json={"path": str(directory)})).json()["id"]
    await _create_test_workflow(client, pid)
    params = {"project_id": pid}
    formal = (await client.get("/api/workflow/list", params=params)).json()["workflows"][0]["id"]
    endpoint = f"/api/workflow-debug/{formal}"
    launch = {"workflow": DRAFT, "title": "Unique debug title", "description": "Testing B",
              "step_key": "b", "samples": [{"step_key": "a", "port": 0, "content": "# A sample"}]}
    seen = []

    class Engine(PipelineFakeEngine):
        async def spawn(self, prompt, cwd, **kwargs):
            seen.append((prompt, cwd))
            async for event in super().spawn(prompt, cwd, **kwargs):
                yield event

    monkeypatch.setattr(task_runner, "create_engine", lambda *_: Engine())
    missing = await client.post(endpoint + "/start", params=params, json={**launch, "samples": []})
    assert missing.status_code == 422
    assert (await client.get(endpoint, params=params)).json()["workflow_id"] is None
    result = await client.post(endpoint + "/start", params=params, json=launch)
    assert result.status_code == 200, result.text
    record = result.json()
    assert record["workflow_id"] != formal
    task_id = record["id"]

    async def wait_task():
        for _ in range(100):
            runs = await main.project_manager.run_db(pid, lambda _: list(
                StepRun.select().where(StepRun.step_key == "b").dicts()
            ))
            if runs and runs[-1]["input_snapshot_json"]:
                return runs[-1]["input_snapshot_json"]
            await asyncio.sleep(.02)
        pytest.fail("B did not resolve its input")

    import json
    snapshot = json.loads(await wait_task())
    artifact = Path(snapshot["ports"][0]["sources"][0]["path"])
    assert artifact.read_text() == "# A sample"
    assert artifact.parts[-3] == "a"
    assert main.project_manager.get_project_by_id(pid).default_workflow()["id"] == formal
    assert [item["id"] for item in (await client.get("/api/workflow/list", params=params)).json()["workflows"]] == [formal]
    assert (await client.get("/api/task/list", params=params)).json()["tasks"] == []
    history = await client.get(endpoint, params=params)
    assert [item["id"] for item in history.json()["tasks"]] == [task_id]
    for _ in range(100):
        if seen:
            break
        await asyncio.sleep(.02)
    assert seen and "plan.md" in seen[0][0]
    assert not await main.project_manager.run_db(
        pid, lambda _: StepRun.select().where(StepRun.step_key == "a").exists(),
    )
    stop = await client.post(f"{endpoint}/tasks/{task_id}/stop", params=params)
    assert stop.status_code == 200, stop.text
    restarted = await client.post(f"{endpoint}/tasks/{task_id}/restart", params=params, json={
        "step_key": "b", "instruction": "Use the previous plan.",
    })
    assert restarted.status_code == 200, restarted.text
    await client.post(f"{endpoint}/tasks/{task_id}/stop", params=params)
    changed = {**DRAFT, "nodes": [
        {**DRAFT["nodes"][0], "outputs": [{"name": "new-plan", "type": "Markdown"}]}, DRAFT["nodes"][1],
    ]}
    saved = await client.put(endpoint + "/configuration", params=params, json={"workflow": changed})
    assert saved.status_code == 200, saved.text
    blocked = await client.post(f"{endpoint}/tasks/{task_id}/restart", params=params, json={"step_key": "b"})
    assert blocked.status_code == 422
    assert artifact.is_file(), "Incompatible historical artifacts remain readable"
    response = await client.delete(endpoint, params=params)
    assert response.status_code == 200, response.text
    assert not artifact.exists()
    second = (await client.post(endpoint + "/start", params=params, json=launch)).json()
    assert second["workflow_id"] == record["workflow_id"]
    assert second["id"] != task_id
    await client.delete(endpoint, params=params)
