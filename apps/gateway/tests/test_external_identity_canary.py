import asyncio
from urllib.parse import parse_qs, urlparse

import httpx
import pytest

from gateway.app import create_app
from gateway.config import GatewaySettings
from gateway.database import GatewayDatabase
from gateway.services.identity_connectors import DingTalkConnector


@pytest.mark.asyncio
async def test_slow_identity_provider_does_not_block_health(tmp_path, monkeypatch):
    monkeypatch.setenv("WORKSTEP_TEST_DINGTALK_SECRET", "server-secret")
    settings = GatewaySettings(data_dir=tmp_path)
    app = create_app(settings)
    database = GatewayDatabase(settings)
    await database.start()
    app.state.database = database
    provider_started = asyncio.Event()
    release_provider = asyncio.Event()

    async def provider(request):
        if request.url.path.endswith("userAccessToken"):
            provider_started.set()
            await release_provider.wait()
            return httpx.Response(200, json={"corpId": "tenant-a", "accessToken": "user-token"})
        return httpx.Response(200, json={"unionId": "employee-1", "nick": "张三"})

    app.state.identity_connectors = {"dingtalk": DingTalkConnector(
        lambda: httpx.AsyncClient(transport=httpx.MockTransport(provider)),
    )}
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                     base_url="https://gateway.test") as client:
            setup = await client.post("/api/platform/setup", json={
                "username": "owner", "display_name": "Owner", "password": "OwnerPassphrase-2026!",
                "recovery_username": "recovery", "recovery_password": "RecoveryPassphrase-2026!",
                "registration_mode": "open",
            })
            assert setup.status_code == 201
            source = await client.post("/api/admin/identity-sources", headers={
                "X-CSRF-Token": setup.json()["csrf_token"],
            }, json={
                "provider": "dingtalk", "tenant_id": "tenant-a", "client_id": "test-client",
                "secret_env": "WORKSTEP_TEST_DINGTALK_SECRET",
            })
            source_id = source.json()["id"]
            start = await client.post(f"/api/auth/external/{source_id}/start")
            state = parse_qs(urlparse(start.json()["authorization_url"]).query)["state"][0]
            callback = asyncio.create_task(client.get(
                f"/api/auth/external/{source_id}/callback?state={state}&authCode=one-time-code",
            ))
            await asyncio.wait_for(provider_started.wait(), timeout=2)
            health = await asyncio.wait_for(client.get("/api/health"), timeout=0.2)
            assert health.status_code == 200
            release_provider.set()
            assert (await callback).status_code == 200
    finally:
        release_provider.set()
        await database.close()
