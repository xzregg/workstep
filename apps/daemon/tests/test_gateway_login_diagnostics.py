import time
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from api.gateway_platform import router
from services.gateway_client.browser_login import GatewayBrowserLogin


@pytest.mark.asyncio
@pytest.mark.parametrize('case', ['missing_pending', 'expired', 'state_mismatch', 'callback_origin_mismatch'])
async def test_callback_logs_specific_failure_without_credentials(case, caplog):
    login = GatewayBrowserLogin(SimpleNamespace())
    state = 'sensitive-state-' + 's' * 32
    code = 'sensitive-code-' + 'c' * 32
    if case != 'missing_pending':
        login.pending = {'state': state, 'expires': time.monotonic() + 300,
                         'callback_origin': 'http://localhost:8765', 'desktop': True,
                         'diagnostic_id': 'abc123', 'started': time.monotonic()}
        if case == 'expired': login.pending['expires'] = time.monotonic() - 1
        if case == 'state_mismatch': login.pending['state'] = 'different-private-state'
        if case == 'callback_origin_mismatch': login.pending['callback_origin'] = 'http://localhost:9999'
    app = FastAPI(); app.include_router(router); app.state.gateway_browser_login = login
    with caplog.at_level('INFO'):
        async with AsyncClient(transport=ASGITransport(app=app), base_url='http://localhost:8765') as client:
            response = await client.get('/api/gateway-platform/callback', params={'code': code, 'state': state})
    assert response.status_code == 400
    logs = '\n'.join(r.getMessage() for r in caplog.records if r.name.endswith('browser_login'))
    assert 'GATEWAY_AUTH' in logs
    assert case in logs
    assert code not in logs and state not in logs and 'different-private-state' not in logs
    assert 'localhost' not in logs


@pytest.mark.asyncio
async def test_later_stage_exception_records_location_not_sensitive_message(monkeypatch, caplog):
    login = GatewayBrowserLogin(SimpleNamespace())
    async def fail(*args, diagnostic, **kwargs):
        diagnostic['stage'] = 'authorization_verify'
        raise ValueError('private-authorization-token-and-user')
    monkeypatch.setattr(login, '_complete', fail)
    with caplog.at_level('INFO'), pytest.raises(ValueError):
        await login.complete('private-code', 'private-state')
    logs = '\n'.join(r.getMessage() for r in caplog.records)
    assert 'authorization_verify' in logs and 'ValueError' in logs and ':fail:' in logs
    assert 'private-' not in logs


@pytest.mark.asyncio
async def test_slow_diagnostic_handler_does_not_block_health(monkeypatch):
    import asyncio
    import threading
    from services.gateway_client import browser_login as module
    entered = threading.Event()
    def slow_log(*args, **kwargs):
        entered.set()
        time.sleep(.3)
    monkeypatch.setattr(module.logger, 'log', slow_log)
    app = FastAPI(); app.include_router(router)
    app.state.gateway_browser_login = GatewayBrowserLogin(SimpleNamespace())
    @app.get('/health')
    async def health(): return {'ok': True}
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://localhost:8765') as client:
        pending = asyncio.create_task(client.get('/api/gateway-platform/callback', params={'code': 'c'*32, 'state': 's'*32}))
        try:
            assert await asyncio.to_thread(entered.wait, 1)
            assert not pending.done()
            response = await asyncio.wait_for(client.get('/health'), .15)
            assert response.status_code == 200
            assert not pending.done()
        finally:
            await pending
