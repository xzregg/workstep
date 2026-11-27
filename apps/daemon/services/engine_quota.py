"""Low-priority, bounded quota collection and unified 5-minute cache."""
import asyncio
from contextlib import suppress
from dataclasses import dataclass
import time
from weakref import WeakKeyDictionary, ref

from engines.core.process_cleanup import finish_cleanup

QUOTA_CACHE_TTL_SECONDS = 300.0
_MAX_PENDING_KEYS = 32
_MAX_CACHE_ENTRIES = 64


class QuotaBusyError(Exception):
    pass


@dataclass
class _Pending:
    task: asyncio.Task
    waiters: int = 0


class _State:
    def __init__(self):
        self.limit = asyncio.Semaphore(2)
        self.pending = {}


class QuotaRequests:
    """Merge identical requests; cap collectors and queued keys per event loop."""
    def __init__(self):
        self._loops = WeakKeyDictionary()

    def _state(self) -> _State:
        loop = asyncio.get_running_loop()
        state_ref = self._loops.get(loop)
        state = state_ref() if state_ref else None
        if state is None:
            state = _State()
            self._loops[loop] = ref(state)
        return state

    async def run(self, key, operation):
        state = self._state()
        limit, pending = state.limit, state.pending
        entry = pending.get(key)
        if entry is None:
            if len(pending) >= _MAX_PENDING_KEYS:
                raise QuotaBusyError()

            async def collect():
                async with asyncio.timeout(25):
                    async with limit:
                        return await operation()

            entry = pending[key] = _Pending(asyncio.create_task(collect()))
        entry.waiters += 1
        try:
            return await asyncio.shield(entry.task)
        finally:
            entry.waiters -= 1
            if entry.waiters == 0:
                if pending.get(key) is entry:
                    pending.pop(key)

                async def cleanup():
                    if not entry.task.done():
                        entry.task.cancel()
                    with suppress(asyncio.CancelledError, Exception):
                        await entry.task

                await finish_cleanup(cleanup())


def quota_scope_key(project_id: str) -> tuple[str, ...]:
    """Isolate cached quotas by current host/actor authorization scope and project."""
    from services.remote_access import get_current_actor

    actor = get_current_actor()
    normalized_project = project_id.strip()
    if actor is None:
        return ("host", "", "", normalized_project)
    if actor.project_id is not None:
        return ("project", actor.source, actor.actor_id, actor.device_id, actor.project_id)
    return ("host", actor.source, actor.actor_id, actor.device_id, normalized_project)


@dataclass
class _UnifiedCacheEntry:
    engines: list[dict]
    collected_at: float
    expires_at_wall: float
    expires_at_mono: float
    seq: int


class _UnifiedLoopState:
    def __init__(self):
        self.cache: dict[tuple[str, ...], _UnifiedCacheEntry] = {}
        self.normal_inflight: dict[tuple[tuple[str, ...], int], _Pending] = {}
        self.refresh_inflight: dict[tuple[tuple[str, ...], int], _Pending] = {}
        self.collector_limit = asyncio.Semaphore(2)
        self.seq = 0
        self.invalidated_seq = 0
        self.scope_invalidated_seq: dict[tuple[str, ...], int] = {}

    def generation(self, scope_key: tuple[str, ...]) -> int:
        return max(self.invalidated_seq, self.scope_invalidated_seq.get(scope_key, 0))


def _snapshot(entry: _UnifiedCacheEntry, *, cached: bool) -> dict:
    return {
        "engines": [dict(item) for item in entry.engines],
        "cached": cached,
        "collected_at": entry.collected_at,
        "expires_at": entry.expires_at_wall,
    }


class UnifiedQuotaService:
    """5-minute TTL cache + in-flight deduplication for unified multi-engine quota queries."""

    def __init__(self, *, ttl_seconds: float = QUOTA_CACHE_TTL_SECONDS,
                 clock=time.monotonic, wall_clock=time.time):
        self.ttl_seconds = ttl_seconds
        self._clock = clock
        self._wall_clock = wall_clock
        self._loops: WeakKeyDictionary = WeakKeyDictionary()

    def _state(self) -> _UnifiedLoopState:
        loop = asyncio.get_running_loop()
        state = self._loops.get(loop)
        if state is None:
            state = _UnifiedLoopState()
            self._loops[loop] = state
        return state

    def collector_semaphore(self) -> asyncio.Semaphore:
        return self._state().collector_limit

    def invalidate(self, scope_key: tuple[str, ...] | None = None) -> None:
        """Drop cached quotas across active loops so engine/config changes take effect immediately."""
        for state in list(self._loops.values()):
            state.seq += 1
            if scope_key is None:
                state.invalidated_seq = state.seq
                state.scope_invalidated_seq.clear()
                state.cache.clear()
            else:
                state.scope_invalidated_seq[scope_key] = state.seq
                state.cache.pop(scope_key, None)

    async def get(self, scope_key: tuple[str, ...], collect, *, refresh: bool = False) -> dict:
        state = self._state()
        now_mono = self._clock()
        generation = state.generation(scope_key)
        pending_key = (scope_key, generation)

        if not refresh:
            cached = state.cache.get(scope_key)
            if cached is not None and now_mono < cached.expires_at_mono:
                return _snapshot(cached, cached=True)
        bucket = state.refresh_inflight if refresh else state.normal_inflight
        if existing := state.refresh_inflight.get(pending_key):
            return await self._await_pending(state.refresh_inflight, pending_key, existing)
        if not refresh and (existing := bucket.get(pending_key)):
            return await self._await_pending(bucket, pending_key, existing)

        if len(state.normal_inflight) + len(state.refresh_inflight) >= _MAX_PENDING_KEYS:
            raise QuotaBusyError()

        state.seq += 1
        started_seq = state.seq

        async def run_collect() -> dict:
            engines = await collect()
            current_generation = generation == state.generation(scope_key)
            current = state.cache.get(scope_key) if current_generation else None
            previous_quotas = {item["engine_id"]: item["quota"] for item in current.engines
                               if item.get("quota") is not None} if current else {}
            collected_mono = self._clock()
            collected_wall = self._wall_clock()
            entry = _UnifiedCacheEntry(
                engines=[{**item, "quota": previous_quotas[item["engine_id"]]}
                         if item.get("status") == "unavailable" and item.get("quota") is None
                         and item["engine_id"] in previous_quotas else item for item in engines],
                collected_at=collected_wall,
                expires_at_wall=collected_wall + self.ttl_seconds,
                expires_at_mono=collected_mono + self.ttl_seconds,
                seq=started_seq,
            )
            if current_generation and (current is None or started_seq >= current.seq):
                if scope_key in state.cache:
                    del state.cache[scope_key]
                state.cache[scope_key] = entry
                if len(state.cache) > _MAX_CACHE_ENTRIES:
                    oldest_key = next(iter(state.cache))
                    state.cache.pop(oldest_key, None)
            return _snapshot(entry, cached=False)

        pending = _Pending(asyncio.create_task(run_collect()))
        bucket[pending_key] = pending
        return await self._await_pending(bucket, pending_key, pending)

    @staticmethod
    async def _await_pending(bucket: dict, pending_key: tuple[tuple[str, ...], int], entry: _Pending) -> dict:
        entry.waiters += 1
        try:
            return await asyncio.shield(entry.task)
        finally:
            entry.waiters -= 1
            if entry.waiters == 0:
                if bucket.get(pending_key) is entry:
                    bucket.pop(pending_key, None)

                async def cleanup():
                    if not entry.task.done():
                        entry.task.cancel()
                    with suppress(asyncio.CancelledError, Exception):
                        await entry.task

                await finish_cleanup(cleanup())


quota_requests = QuotaRequests()
unified_quota_service = UnifiedQuotaService()
