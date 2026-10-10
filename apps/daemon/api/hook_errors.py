"""Translate shared hook domain failures at the HTTP boundary."""
from fastapi import HTTPException
from services.hook_errors import HookError


async def invoke_hook(awaitable):
    try:
        return await awaitable
    except HookError as exc:
        raise HTTPException(exc.status_code, exc.detail) from exc
