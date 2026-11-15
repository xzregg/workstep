"""Bounded memory maintenance executed by the proactive-thinking scheduler."""
import asyncio
import logging
import time
from datetime import datetime, timezone

from services import digital_person, digital_person_memory as memory
from services import digital_person_memory_index as index

logger = logging.getLogger(__name__)


class MemoryWorker:
    def __init__(self, projects, bus):
        self.projects, self.bus = projects, bus
        self._lock = asyncio.Lock()

    async def _consolidate(self, window=None):
        from services.memory_knowledge import consolidate_batch, queue_status
        result = await consolidate_batch(self.projects, self.bus, limit=8, **(window or {}))
        ids = memory.allowed_projects(self.projects)
        result['queue'] = await asyncio.to_thread(queue_status, ids, **(window or {}))
        return result

    async def _save(self, value):
        await asyncio.to_thread(index.mutate_state, 'memory_worker', lambda state: state.update(value))
        return value

    async def sweep(self, *, index_sources=True, window=None):
        async with self._lock:
            started = datetime.now(timezone.utc).isoformat()
            try:
                profile = await asyncio.to_thread(digital_person.get_profile)
                if not profile.enabled:
                    return await self._save({'status': 'disabled', 'error_type': None})
                previous = await asyncio.to_thread(index.read_state, 'memory_worker') or {}
                if previous.get('retry_at', 0) > time.time():
                    # A provider outage affects all batches, not only leased rows.
                    # Recreating the worker must not bypass this persistent pause.
                    return await self._save({**previous, 'status': 'retrying', 'cooldown': True,
                                             'indexed': 0, 'finished_at': started})
                await self._save({'status': 'running', 'started_at': started, 'error_type': None})
                indexed = await memory.sync_projects(self.projects, batch_size=100) if index_sources else 0
                knowledge = await self._consolidate(window) if window else await self._consolidate()
                failed = knowledge.get('status') == 'retry'
                error = knowledge.get('error') if failed else None
                provider_failure = error in {'model_unavailable','ModelUnavailable','ModelHTTPError',
                                              'APIConnectionError','APITimeoutError','TimeoutError'}
                failures = previous.get('consecutive_failures', 0) + 1 if provider_failure else 0
                interval = max(60, getattr(profile, 'proactive_interval_minutes', 5) * 60)
                retry_at = time.time() + min(3600, interval * 2**min(failures-1, 4)) if provider_failure else 0
                return await self._save({
                    'status': 'retrying' if failed else 'idle', 'indexed': indexed, 'knowledge': knowledge,
                    'finished_at': datetime.now(timezone.utc).isoformat(), 'error_type': error,
                    'retry_at': retry_at, 'consecutive_failures': failures, 'cooldown': False,
                })
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                # Exception bodies may contain source text or provider credentials.
                logger.warning('Memory maintenance failed (%s)', type(exc).__name__)
                value = {'status': 'retrying', 'error_type': type(exc).__name__,
                         'finished_at': datetime.now(timezone.utc).isoformat()}
                try:
                    await self._save(value)
                except Exception:
                    logger.warning('Memory maintenance status unavailable')
                return value
