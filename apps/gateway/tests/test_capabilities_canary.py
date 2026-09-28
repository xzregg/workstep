import asyncio
import sqlite3
import threading
import time

import httpx
import pytest

from gateway.app import create_app
from gateway.config import GatewaySettings
from gateway.database import GatewayDatabase


@pytest.mark.asyncio
async def test_capability_write_lock_keeps_gateway_health_responsive(tmp_path):
    settings = GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test")
    app = create_app(settings)
    database = GatewayDatabase(settings)
    await database.start()
    app.state.database = database
    release = threading.Event()
    locked = threading.Event()

    def hold_write_lock():
        with sqlite3.connect(tmp_path / "workstep_platform.db") as connection:
            connection.execute("BEGIN IMMEDIATE")
            locked.set()
            release.wait(timeout=3)

    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                     base_url="https://gateway.test") as client:
            setup = await client.post("/api/platform/setup", json={
                "username": "owner", "display_name": "Owner", "password": "OwnerPassphrase-2026!",
                "recovery_username": "recovery", "recovery_password": "RecoveryPassphrase-2026!",
                "registration_mode": "closed",
            })
            csrf = setup.json()["csrf_token"]
            user_id = setup.json()["user"]["id"]
            headers = {"X-CSRF-Token": csrf}
            assert (await client.post("/api/auth/step-up", json={
                "password": "OwnerPassphrase-2026!",
            }, headers=headers)).status_code == 200
            locker = threading.Thread(target=hold_write_lock)
            locker.start()
            assert await asyncio.to_thread(locked.wait, 1)
            grant = asyncio.create_task(client.post(f"/api/admin/capabilities/{user_id}",
                headers=headers, json={"capability": "task.create", "scope_type": "global",
                                       "effect": "allow"}))
            await asyncio.sleep(0.05)
            start = time.perf_counter()
            health = await asyncio.wait_for(client.get("/api/health"), timeout=0.2)
            assert health.status_code == 200
            assert time.perf_counter() - start < 0.2
            release.set()
            assert (await grant).status_code == 200
            locker.join(timeout=1)
    finally:
        release.set()
        await database.close()
