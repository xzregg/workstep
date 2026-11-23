"""Host-local retention intent; never forwarded to a model or native protocol."""
import asyncio
from contextlib import contextmanager
from contextvars import ContextVar
from functools import wraps
from weakref import WeakSet

_owner = ContextVar('engine_session_retention', default=None)


@contextmanager
def session_retention(owner: str | None):
    token = _owner.set(owner or None)
    try:
        yield
    finally:
        _owner.reset(token)


def with_session_retention(function):
    @wraps(function)
    async def run(*args, **kwargs):
        with session_retention(kwargs.get('session_retention_key')):
            return await function(*args, **kwargs)
    return run


def claim_session_retention(pool, entry):
    owner = _owner.get()
    entry.retention_owner = owner
    if owner:
        loop = asyncio.get_running_loop()
        pools = getattr(loop, '_workstep_retention_pools', None)
        if pools is None:
            pools = loop._workstep_retention_pools = WeakSet()
        pools.add(pool)
        # A host conversation can change its native thread or engine. Only
        # its latest lease remains protected; in-flight old work is not killed.
        for other in list(pools):
            other.unretain(owner, except_entry=entry)
    return entry


async def release_session_retention(owner: str):
    pools = getattr(asyncio.get_running_loop(), '_workstep_retention_pools', ())
    for pool in list(pools):
        pool.unretain(owner)
