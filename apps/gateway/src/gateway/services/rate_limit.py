"""Bounded per-client limits for public identity endpoints."""
from gateway.services.errors import GatewayError

import asyncio
from collections import deque
from time import monotonic


class IdentityRateLimiter:
    def __init__(self, *, limit: int = 5, window_seconds: int = 60):
        self.limit = limit
        self.window_seconds = window_seconds
        self._attempts: dict[tuple[str, str], deque[float]] = {}
        self._lock = asyncio.Lock()
        self._account_attempts: dict[str, deque[float]] = {}

    async def check(self, action: str, client_ip: str) -> None:
        now = monotonic()
        key = (action, client_ip)
        async with self._lock:
            for old_key in list(self._attempts):
                old = self._attempts[old_key]
                if not old or now - old[-1] >= self.window_seconds:
                    del self._attempts[old_key]
            if key not in self._attempts and len(self._attempts) >= 10000:
                raise GatewayError('rate_limited', 'Too many attempts')
            attempts = self._attempts.setdefault(key, deque())
            while attempts and now - attempts[0] >= self.window_seconds:
                attempts.popleft()
            if len(attempts) >= self.limit:
                raise GatewayError('rate_limited', 'Too many attempts')
            attempts.append(now)

    async def check_login_account(self, username: str) -> None:
        now = monotonic()
        async with self._lock:
            for key in list(self._account_attempts):
                attempts = self._account_attempts[key]
                while attempts and now - attempts[0] >= 900:
                    attempts.popleft()
                if not attempts:
                    del self._account_attempts[key]
            if username not in self._account_attempts and len(self._account_attempts) >= 10000:
                raise GatewayError('rate_limited', '登录尝试过多，请稍后重试。')
            attempts = self._account_attempts.setdefault(username, deque())
            if len(attempts) >= 10:
                raise GatewayError('rate_limited', '登录尝试过多，请稍后重试。')
            attempts.append(now)

    async def login_succeeded(self, username: str) -> None:
        async with self._lock:
            self._account_attempts.pop(username, None)
