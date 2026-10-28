"""Manual review through the real API while a sibling stage is still running."""

import asyncio
import threading
import time

import pytest

from models import ReviewRun, Task
from tests.test_api_contracts import api_context  # noqa: F401
from tests.test_task_workflow_execution import scenario, node, edge  # noqa: F401


async def pending_review(s):
    async with asyncio.timeout(5):
        while True:
            review = await s.db(lambda _p: ReviewRun.get_or_none(
                (ReviewRun.task == s.task_id) & (ReviewRun.status == "pending")
            ))
            if review is not None:
                return review
            await asyncio.sleep(.01)


async def start_parallel(s, *, manual_sibling=False):
    def customize(flow):
        ui = node("requirements", ["PRD"])
        ui["review"] = {"mode": "manual"}
        flow["nodes"] = [ui, node("develop", ["API"]),
                         node("test", ["Report"], ["PRD", "API"]),
                         node("publish", ["Delivery"], ["PRD", "API"])]
        flow["connections"] = [edge("requirements", "test"), edge("develop", "test", 0, 1),
                               edge("requirements", "publish"),
                               edge("develop", "publish", 0, 1)]
        if manual_sibling:
            flow["nodes"][1]["review"] = {"mode": "manual"}
    await s.source_update(customize)
    s.script.block = ("develop", "execution", 1)
    handle = await s.runtime.start(s.pid, s.task_id)
    await asyncio.wait_for(s.script.entered.wait(), 5)
    return handle, await pending_review(s)


@pytest.mark.anyio
@pytest.mark.parametrize("decision", ["approve", "force-approve", "reject"])
async def test_parallel_review_is_accepted_and_continues_without_repeating_sibling(scenario, decision):
    s = scenario
    handle, review = await start_parallel(s)
    url = f"/api/task/{s.task_id}/steps/requirements/review/{decision}?project_id={s.pid}"
    try:
        response = await asyncio.wait_for(s.client.post(url, json={
            "review_run_id": review.id, "comment": "Please refine UI",
        }), 2)
        assert response.status_code == 200, response.text
        # Repeated submission is harmless while the sibling is still executing.
        duplicate = await s.client.post(url, json={"review_run_id": review.id})
        assert duplicate.status_code == 200, duplicate.text
        assert len(s.script.select("develop")) == 1
        assert not s.script.select("publish")
    finally:
        s.script.release.set()
    await s.runtime.wait(handle)
    if decision == "reject":
        next_review = await pending_review(s)
        assert next_review.id != review.id
        assert "Please refine UI" in s.script.select("requirements")[-1]["prompt"]
        response = await s.client.post(
            f"/api/task/{s.task_id}/steps/requirements/review/approve?project_id={s.pid}",
            json={"review_run_id": next_review.id},
        )
        assert response.status_code == 200, response.text
    async with asyncio.timeout(8):
        while await s.db(lambda _p: Task.get_by_id(s.task_id).status) != "completed":
            await asyncio.sleep(.01)
    assert len(s.script.select("requirements")) == (2 if decision == "reject" else 1)
    assert len(s.script.select("develop")) == len(s.script.select("publish")) == 1


@pytest.mark.anyio
async def test_parallel_reviews_can_be_approved_one_after_another(scenario):
    s = scenario
    handle, review = await start_parallel(s, manual_sibling=True)
    try:
        response = await s.client.post(
            f"/api/task/{s.task_id}/steps/requirements/review/approve?project_id={s.pid}",
            json={"review_run_id": review.id},
        )
        assert response.status_code == 200, response.text
    finally:
        s.script.release.set()
    await s.runtime.wait(handle)
    second = await pending_review(s)
    assert second.step_key == "develop"
    response = await s.client.post(
        f"/api/task/{s.task_id}/steps/develop/review/approve?project_id={s.pid}",
        json={"review_run_id": second.id},
    )
    assert response.status_code == 200, response.text
    async with asyncio.timeout(8):
        while await s.db(lambda _p: Task.get_by_id(s.task_id).status) != "completed":
            await asyncio.sleep(.01)
    assert len(s.script.select("requirements")) == len(s.script.select("develop")) == 1
    assert len(s.script.select("publish")) == 1


@pytest.mark.anyio
async def test_parallel_review_does_not_resume_after_user_stop(scenario):
    s = scenario
    handle, review = await start_parallel(s)
    try:
        response = await s.client.post(
            f"/api/task/{s.task_id}/steps/requirements/review/approve?project_id={s.pid}",
            json={"review_run_id": review.id},
        )
        assert response.status_code == 200, response.text
        assert await s.runtime.cancel(s.task_id)
    finally:
        s.script.release.set()
    await s.runtime.wait(handle)
    await asyncio.sleep(.1)
    assert not s.script.select("publish")


@pytest.mark.anyio
async def test_parallel_review_slow_sql_keeps_health_responsive(scenario, monkeypatch):
    import main
    s = scenario
    handle, review = await start_parallel(s)
    database = main.project_manager.get_project_by_id(s.pid).db
    execute = database.execute_sql
    entered = threading.Event()

    def slow_decision(sql, params=None, commit=None):
        if sql.startswith(f'UPDATE "{ReviewRun._meta.table_name}"'):
            entered.set()
            time.sleep(.3)
        return execute(sql, params)

    monkeypatch.setattr(database, "execute_sql", slow_decision)
    request = asyncio.create_task(s.client.post(
        f"/api/task/{s.task_id}/steps/requirements/review/approve?project_id={s.pid}",
        json={"review_run_id": review.id},
    ))
    try:
        assert await asyncio.to_thread(entered.wait, 3)
        started = time.monotonic()
        assert (await s.client.get("/api/health")).status_code == 200
        assert time.monotonic() - started < .15
        response = await request
        assert response.status_code == 200, response.text
    finally:
        s.script.release.set()
        await request
    await s.runtime.wait(handle)
