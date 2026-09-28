"""Bounded per-client limits for public identity endpoints."""

import asyncio
from collections import deque
from time import monotonic

from fastapi import HTTPException


class IdentityRateLimiter:
    def __init__(self, *, limit: int = 5, window_seconds: int = 60):
        self.limit = limit
        self.window_seconds = window_seconds
        self._attempts: dict[tuple[str, str], deque[float]] = {}
        self._lock = asyncio.Lock()

    async def check(self, action: str, client_ip: str) -> None:
        now = monotonic()
        key = (action, client_ip)
        async with self._lock:
            attempts = self._attempts.setdefault(key, deque())
            while attempts and now - attempts[0] >= self.window_seconds:
                attempts.popleft()
            if len(attempts) >= self.limit:
                raise HTTPException(status_code=429, detail="Too many attempts")
            attempts.append(now)
