"""An engine-side request ending invalidates its assistant/task UI question."""
import asyncio
from types import SimpleNamespace

import pytest

from engines.core.events import InternalEvent
from services.intervention import intervention_manager
from services.step_interaction_messages import StepInteractionMessages


@pytest.mark.anyio
@pytest.mark.parametrize('ending', ['engine_failure', 'user_answer', 'failure_during_delivery'])
async def test_task_interaction_finishes_with_cancelled_or_actual_response(ending):
    iid = 'task-request-' + ending
    native = asyncio.get_running_loop().create_future()
    event = InternalEvent(type='interaction_request', data={
        'interaction_id': iid, 'method':'session/request_permission',
    })
    recorded, published, events = [], [], []
    async def record(ref, data):
        recorded.append(data)
    async def run_db(operation):
        pass  # Projection persistence is covered by the task runner tests.
    async def publish(task, step, data):
        published.append(data)
    async def respond(request, response):
        if ending == 'engine_failure':
            assert native.cancelled()
            return False
        assert not native.done()  # Observing the UI reply must not cancel native.
        if ending == 'failure_during_delivery':
            native.cancel()
            return False
        native.set_result(response)
        return True
    engine = SimpleNamespace(_pending_interaction_responses={iid:native}, respond_interaction=respond)
    bridge = StepInteractionMessages(SimpleNamespace(arecord=record), run_db, publish, None)
    waiter = asyncio.create_task(intervention_manager.request_response(iid,'task','step',event.data))
    await asyncio.sleep(0)
    task = asyncio.create_task(bridge.finish(waiter=waiter, task_id='task', step_key='step',
        event=event,engine=engine,message_id='message',journal_ref=None,events_collected=events,
        resolved_model=None,engine_id='codex_sdk'))
    try:
        if ending=='engine_failure':
            native.cancel()
        else:
            assert intervention_manager.deliver_response(iid, {'outcome':{'option_id':'allow_once'}})
        await asyncio.wait_for(task,1)
        expected = ({'outcome':{'option_id':'allow_once'}} if ending=='user_answer'
                    else {'outcome':{'outcome':'cancelled'}})
        assert events[0]['data']['response'] == expected
        assert recorded[0]['data']['response'] == expected
        assert published[0]['data']['response'] == expected
        assert not intervention_manager.deliver_response(iid, {'outcome':{'option_id':'allow_once'}})
    finally:
        intervention_manager.cancel(iid)
        task.cancel()
        await asyncio.gather(task,waiter,return_exceptions=True)
