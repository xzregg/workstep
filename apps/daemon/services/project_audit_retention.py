"""Periodically reclaim expired audit rows without VACUUM or event-loop SQL."""
import asyncio
import logging
from services.project_audit import prune_project_audit

logger = logging.getLogger(__name__)


class ProjectAuditRetention:
    def __init__(self, manager, interval=3600, *, startup_delay=30, batch_pause=0.05):
        self.manager = manager
        self.interval = interval
        self.startup_delay = startup_delay
        self.batch_pause = batch_pause
        self.stop = asyncio.Event()
        self.task = None

    async def _wait(self, delay):
        try:
            await asyncio.wait_for(self.stop.wait(), delay)
        except asyncio.TimeoutError:
            pass

    async def sweep(self):
        for project in list(self.manager.iter_projects()):
            if self.stop.is_set():
                return
            try:
                while not self.stop.is_set():
                    deleted = await self.manager.run_db(
                        project.id, lambda _project: prune_project_audit(project.id, batch_size=100),
                    )
                    if deleted < 100:
                        break
                    # Give queued project operations time before the next DB work unit.
                    await self._wait(self.batch_pause)
            except Exception:
                logger.warning("Project audit retention unavailable: project=%s", project.id, exc_info=True)

    async def run(self):
        await self._wait(self.startup_delay)
        while not self.stop.is_set():
            await self.sweep()
            await self._wait(self.interval)

    def start(self):
        self.task = asyncio.create_task(self.run())

    async def close(self):
        self.stop.set()
        if self.task is not None:
            await self.task
