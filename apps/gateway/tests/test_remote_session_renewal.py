from datetime import datetime, timedelta, timezone
from functools import partial

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from gateway.app import create_app
from gateway.config import GatewaySettings
from gateway.models import AuthSession, Device, PlatformProject


@pytest.mark.parametrize('path_workspace', [True, False])
@pytest.mark.parametrize('project_scope', [True, False])
def test_remote_session_renews_cookie_and_expiry_without_changing_scope(tmp_path, monkeypatch, path_workspace, project_scope):
    app = create_app(GatewaySettings(data_dir=tmp_path, public_origin='https://gateway.test'))
    with TestClient(app, base_url='https://gateway.test') as client:
        from test_external_identity import _setup
        _setup(client)

        async def seed():
            async with app.state.database.session() as session:
                async with session.begin():
                    session.add(Device(id='one', name='One', public_key='test', status='active'))
                    session.add(PlatformProject(id='project-one', device_id='one', host_project_id='host-one',
                                                name='Demo', access_mode='remote_published'))
        client.portal.call(seed)
        monkeypatch.setattr(app.state.control_connections, 'is_online', lambda _: True)
        access = client.get('/api/projects/project-one/access' if project_scope else '/api/devices/one/access').json()
        root = '/workspace/one/' if path_workspace else 'https://d-one.gateway.test/'
        assert client.post(root + 'api/remote/redeem', data={'ticket': access['ticket']}, follow_redirects=False).status_code == 303

        async def change_session(**values):
            async with app.state.database.session() as session:
                async with session.begin():
                    auth = await session.scalar(select(AuthSession).where(AuthSession.device_id == 'one'))
                    for key, value in values.items():
                        setattr(auth, key, value)
                    return auth.id

        now = datetime.now(timezone.utc)
        auth_id = client.portal.call(partial(change_session, expires_at=now + timedelta(seconds=30)))
        renewed = client.get(root + 'api/remote/session')
        assert renewed.status_code == 200, renewed.text
        assert renewed.json()['project_id'] == ('project-one' if project_scope else None)
        assert renewed.headers['cache-control'] == 'no-store'
        cookies = renewed.headers.get_list('set-cookie')
        assert any('Max-Age=3600' in cookie for cookie in cookies)
        if path_workspace:
            assert any('Path=/workspace/one/' in cookie for cookie in cookies)
            assert any('Path=/ws/workspace/one' in cookie for cookie in cookies)

        async def expiry():
            async with app.state.database.session() as session:
                return (await session.get(AuthSession, auth_id)).expires_at
        assert client.portal.call(expiry).replace(tzinfo=timezone.utc) > now + timedelta(minutes=59)
        # Frequent checks do not write or issue cookies until renewal is needed.
        assert 'set-cookie' not in client.get(root + 'api/remote/session').headers
        client.portal.call(partial(change_session, expires_at=now + timedelta(seconds=30)))
        monkeypatch.setattr(app.state.control_connections, 'is_online', lambda _: False)
        offline = client.get(root + 'api/remote/session')
        assert offline.status_code == 409
        assert 'set-cookie' not in offline.headers
        monkeypatch.setattr(app.state.control_connections, 'is_online', lambda _: True)
        client.portal.call(partial(change_session, revoked_at=now))
        denied = client.get(root + 'api/remote/session')
        assert denied.status_code == 401
        assert 'set-cookie' not in denied.headers
        client.portal.call(partial(change_session, revoked_at=None, expires_at=now - timedelta(seconds=1)))
        assert client.get(root + 'api/remote/session').status_code == 401


def test_session_renewal_sqlite_write_lock_keeps_health_responsive(tmp_path, monkeypatch):
    import asyncio
    import sqlite3
    import threading
    from httpx import AsyncClient, ASGITransport
    from sqlalchemy import event
    from test_external_identity import _setup

    app = create_app(GatewaySettings(data_dir=tmp_path, public_origin='https://gateway.test'))
    with TestClient(app, base_url='https://gateway.test') as client:
        _setup(client)

        async def seed():
            async with app.state.database.session() as session:
                async with session.begin():
                    session.add(Device(id='one', name='One', public_key='test', status='active'))
        client.portal.call(seed)
        monkeypatch.setattr(app.state.control_connections, 'is_online', lambda _: True)
        access = client.get('/api/devices/one/access').json()
        client.post('/workspace/one/api/remote/redeem', data={'ticket': access['ticket']}, follow_redirects=False)

        async def near_expiry():
            async with app.state.database.session() as session:
                async with session.begin():
                    auth = await session.scalar(select(AuthSession).where(AuthSession.device_id == 'one'))
                    auth.expires_at = datetime.now(timezone.utc) + timedelta(seconds=30)
        client.portal.call(near_expiry)
        reached_write = threading.Event()
        engine = app.state.database.engine.sync_engine

        def before_execute(_connection, _cursor, statement, _parameters, _context, _many):
            if statement.startswith('UPDATE'):
                reached_write.set()
        event.listen(engine, 'before_cursor_execute', before_execute)

        async def scenario():
            async with AsyncClient(transport=ASGITransport(app=app), base_url='https://gateway.test', cookies=client.cookies) as actor:
                pending = asyncio.create_task(actor.get('/workspace/one/api/remote/session'))
                try:
                    assert await asyncio.to_thread(reached_write.wait, 2)
                    assert (await asyncio.wait_for(actor.get('/api/health'), .5)).status_code == 200
                    assert not pending.done()
                finally:
                    await asyncio.to_thread(lock.rollback)
                assert (await pending).status_code == 200
        try:
            with sqlite3.connect(tmp_path / 'workstep_platform.db', check_same_thread=False) as lock:
                lock.execute('BEGIN IMMEDIATE')
                client.portal.call(scenario)
        finally:
            event.remove(engine, 'before_cursor_execute', before_execute)
