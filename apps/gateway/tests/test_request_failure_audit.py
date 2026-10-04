"""Failed administrative requests keep authenticated identity without secrets."""
import json
from fastapi.testclient import TestClient
from sqlalchemy import select
from gateway.app import create_app
from gateway.config import GatewaySettings
from gateway.models import AuditEvent
from test_org_api import _setup


def test_admin_denial_validation_and_server_failure_are_audited_without_request_content(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    @app.post('/api/admin/test-failure/{target}')
    async def fail(target: str):
        raise RuntimeError('secret exception text')
    with TestClient(app, base_url='https://gateway.test', raise_server_exceptions=False) as client:
        csrf = _setup(client)
        owner = client.get('/api/auth/session').json()['user']['id']
        assert client.post('/api/admin/users', json={'display_name': 'Sensitive', 'username': 'sensitive-name', 'password': 'sensitive-password'}).status_code == 403
        assert client.post('/api/admin/users', headers={'X-CSRF-Token': csrf}, json={'username': 'invalid name', 'password': 'sensitive-password'}).status_code == 422
        assert client.post('/api/admin/test-failure/secret-target?credential=private-query', headers={'X-CSRF-Token': csrf}, json={'token': 'secret-body'}).status_code == 500
        async def read():
            async with app.state.database.session() as session:
                return (await session.scalars(select(AuditEvent).where(AuditEvent.action.in_(['request.denied', 'request.failed'])).order_by(AuditEvent.created_at))).all()
        rows = client.portal.call(read)
        assert len(rows) == 3
        assert [(row.result, row.user_id, row.actor_username) for row in rows] == [
            ('denied', owner, 'owner'), ('denied', owner, 'owner'), ('failed', owner, 'owner')]
        assert json.loads(rows[-1].metadata_json) == {'method': 'POST', 'route': '/api/admin/test-failure/{target}', 'status': 500}
        text = json.dumps([row.metadata_json for row in rows])
        assert all(secret not in text for secret in ['secret-target', 'private-query', 'secret-body', 'sensitive-password', 'secret exception'])
        assert client.get('/api/health').status_code == 200


import asyncio
import sqlite3
import threading
import time
import httpx
import pytest
from gateway.database import GatewayDatabase


@pytest.mark.asyncio
async def test_failure_audit_sqlite_lock_does_not_block_health(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    database = GatewayDatabase(GatewaySettings(data_dir=tmp_path))
    await database.start(); app.state.database = database
    locked = threading.Event(); release = threading.Event()
    def hold():
        with sqlite3.connect(tmp_path / 'workstep_platform.db') as db:
            db.execute('BEGIN IMMEDIATE'); locked.set(); release.wait(3)
    locker = None
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='https://gateway.test') as client:
            setup = await client.post('/api/platform/setup', json={
                'username': 'owner', 'display_name': 'Owner', 'password': 'OwnerPassphrase-2026!',
                'recovery_username': 'recovery', 'recovery_password': 'RecoveryPassphrase-2026!',
                'registration_mode': 'closed',
            })
            assert setup.status_code == 201, setup.text
            locker = threading.Thread(target=hold); locker.start()
            assert await asyncio.to_thread(locked.wait, 1)
            failed = asyncio.create_task(client.post('/api/admin/users', json={
                'username': 'no-csrf', 'display_name': 'No CSRF', 'password': 'UserPassphrase-2026!',
            }))
            await asyncio.sleep(0.05)
            before = time.monotonic()
            assert (await asyncio.wait_for(client.get('/api/health'), 0.3)).status_code == 200
            assert time.monotonic() - before < 0.3
            release.set()
            assert (await failed).status_code == 403
    finally:
        release.set()
        if locker: await asyncio.to_thread(locker.join, 1)
        await database.close()
