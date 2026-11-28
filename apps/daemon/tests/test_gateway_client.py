import pytest
import asyncio
import time
from types import SimpleNamespace

from services.gateway_client import GatewayClientService
from workstep_gateway_protocol import PROTOCOL_VERSION


@pytest.mark.asyncio
async def test_unconfigured_gateway_client_does_not_connect(monkeypatch):
    assert PROTOCOL_VERSION == 1
    import websockets

    def reject_connection(*args, **kwargs):
        raise AssertionError("unconfigured daemon attempted Gateway connection")

    monkeypatch.setattr(websockets, "connect", reject_connection)
    client = GatewayClientService()
    await client.start()
    await client.close()


@pytest.mark.asyncio
async def test_managed_usage_initialization_and_actor_reads_do_not_block(monkeypatch, tmp_path):
    import services.gateway_client.service as service
    from services.remote_access import ActorSnapshot, actor_context
    monkeypatch.setenv('WORKSTEP_MANAGED_BUNDLE_DIR', str(tmp_path))
    monkeypatch.setattr(service, 'load_managed_config', lambda *_: SimpleNamespace(
        gateway_id='gateway', gateway_origin='https://gateway.test',
        gateway_public_key_fingerprint='pin'))
    def slow_outbox(_path):
        time.sleep(.15)
        return object()
    monkeypatch.setattr(service, 'UsageOutbox', slow_outbox)
    client = GatewayClientService()
    captured = []
    async def capture(**kwargs):
        captured.append(kwargs)
    monkeypatch.setattr(client, 'record_message_usage', capture)
    try:
        task = asyncio.create_task(client.start())
        await asyncio.sleep(.02)
        assert not task.done()
        await asyncio.wait_for(asyncio.sleep(.01), timeout=.05)
        await task
        with actor_context(ActorSnapshot('initiator', 'Caller', 'device', 'Device', 'managed')):
            await client.record_one_shot_usage(project_id='project', model='model', provider=None, usage=None)
        assert captured[0]['user_id'] == 'initiator'
    finally:
        await client.close()
