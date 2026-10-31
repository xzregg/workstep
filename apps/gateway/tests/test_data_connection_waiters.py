import asyncio

import pytest

from gateway.services.control_connection import ControlConnections


@pytest.mark.parametrize('failure', ['timeout', 'send'])
async def test_shared_data_waiters_receive_connection_failure(monkeypatch, failure):
    connections = ControlConnections()
    connections._active['device'] = ('control', None, None)
    sending = asyncio.Event()
    release = asyncio.Event()

    async def send(command):
        sending.set()
        await release.wait()
        if failure == 'send':
            raise ConnectionError('Control connection closed')

    connections._control_senders['device'] = send
    wait_for = asyncio.wait_for

    async def short_wait(awaitable, timeout):
        # The joining waiter starts first; only the initiating waiter times out.
        return await wait_for(awaitable, 0.02 if release.is_set() else 1)

    monkeypatch.setattr(asyncio, 'wait_for', short_wait)
    first = asyncio.create_task(connections.request_data('device'))
    await sending.wait()
    second = asyncio.create_task(connections.request_data('device'))
    await asyncio.sleep(0)
    release.set()
    results = await asyncio.gather(first, second, return_exceptions=True)
    expected = {'timeout': asyncio.TimeoutError, 'send': ConnectionError}[failure]
    assert isinstance(results[0], expected)
    # A sibling request must use the ordinary upstream failure path (HTTP 502),
    # rather than escaping the gateway handler with CancelledError (HTTP 500).
    assert isinstance(results[1], ConnectionError), repr(results[1])
    assert not connections._pending_data
    assert not connections._device_pending
