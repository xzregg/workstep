import asyncio
import pytest
from gateway.services import rate_limit
from gateway.services.errors import GatewayError


async def test_account_limit_is_atomic_and_success_clears_only_account(monkeypatch):
    monkeypatch.setattr(rate_limit, 'monotonic', lambda: 1000)
    limiter = rate_limit.IdentityRateLimiter()
    results = await asyncio.gather(*(limiter.check_login_account('owner') for _ in range(20)), return_exceptions=True)
    assert sum(isinstance(result, GatewayError) for result in results) == 10
    await limiter.check_login_account('other')
    await limiter.login_succeeded('owner')
    await limiter.check_login_account('owner')
    assert len(limiter._account_attempts['owner']) == 1
    assert len(limiter._account_attempts['other']) == 1


async def test_expired_client_and_account_entries_are_removed(monkeypatch):
    now = [1000]
    monkeypatch.setattr(rate_limit, 'monotonic', lambda: now[0])
    limiter = rate_limit.IdentityRateLimiter()
    await limiter.check('login', '192.0.2.1')
    await limiter.check_login_account('old')
    now[0] += 901
    await limiter.check('login', '192.0.2.2')
    await limiter.check_login_account('new')
    assert list(limiter._attempts) == [('login', '192.0.2.2')]
    assert list(limiter._account_attempts) == ['new']
