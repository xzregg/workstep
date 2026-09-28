import pytest

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
