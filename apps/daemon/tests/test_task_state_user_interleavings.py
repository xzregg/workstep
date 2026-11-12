"""Conflicting browser operations through the real review API."""
import asyncio

import pytest

from tests.test_api_contracts import api_context  # noqa: F401
from tests.test_task_workflow_execution import scenario  # noqa: F401
from tests.test_parallel_review_decisions import start_parallel


@pytest.mark.anyio
@pytest.mark.parametrize('decisions', [('approve', 'approve'), ('approve', 'reject'),
    ('reject', 'approve'), ('reject', 'reject')])
async def test_two_browser_decisions_during_parallel_execution(scenario, decisions):
    s = scenario
    handle, review = await start_parallel(s)
    try:
        responses = await asyncio.gather(*(
            s.client.post(
                f'/api/task/{s.task_id}/steps/requirements/review/{decision}?project_id={s.pid}',
                json={'review_run_id': review.id, 'comment': f'Browser {index}'})
            for index, decision in enumerate(decisions)
        ))
        codes = sorted(response.status_code for response in responses)
        assert codes == ([200, 200] if decisions[0] == decisions[1] else [200, 409])
        assert len(s.script.select('develop')) == 1
        assert not s.script.select('publish')
    finally:
        s.script.release.set()
        await s.runtime.wait(handle)
        await s.runtime.shutdown()
