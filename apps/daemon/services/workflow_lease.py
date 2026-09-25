"""Workflow run ownership, heartbeats and deferred stale-lease recovery."""

import asyncio
import logging
import uuid

from models import WorkflowRun
from models.fields import utc_now
from services.workflow_recovery import RUN_LEASE_STALE_SECONDS

logger = logging.getLogger(__name__)

# Only the owning daemon renews a run. Startup recovery may take over after
# the heartbeat becomes stale; a delayed retry covers a peer that crashes
# shortly after startup recovery checks its lease.
RUN_LEASE_HEARTBEAT_SECONDS = 5.0
ORPHAN_RECONCILE_SECONDS = 15.0


class WorkflowLeaseManager:
    """Own a runtime instance's lease state and background tasks."""

    def __init__(self, run_db, reconcile_orphans, recover_project_runs):
        self.instance_id = uuid.uuid4().hex
        self._run_db = run_db
        self._reconcile_orphans = reconcile_orphans
        self._recover_project_runs = recover_project_runs
        self._leased_runs: dict[str, str] = {}
        self._heartbeat_task: asyncio.Task | None = None
        self._retry_tasks: set[asyncio.Task] = set()
        self._last_orphan_reconcile = 0.0

    def register(self, run_id: str, project_id: str) -> None:
        self._leased_runs[run_id] = project_id
        if self._heartbeat_task is None or self._heartbeat_task.done():
            self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())

    def release(self, run_id: str) -> None:
        self._leased_runs.pop(run_id, None)

    def schedule_recovery_retry(self, project, run_id: str) -> None:
        """Retry a live peer's run after its lease could have expired."""

        async def retry():
            try:
                await asyncio.sleep(RUN_LEASE_STALE_SECONDS)
                current = await self._run_db(
                    project.id, lambda _project: project
                )
                await self._recover_project_runs(current)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception(
                    "Deferred recovery retry failed for run %s", run_id
                )

        task = asyncio.create_task(
            retry(), name=f"workflow-lease-retry:{run_id}"
        )
        self._retry_tasks.add(task)
        task.add_done_callback(self._retry_tasks.discard)

    async def _heartbeat_loop(self) -> None:
        """Renew leases in the project database executor."""
        while True:
            await asyncio.sleep(RUN_LEASE_HEARTBEAT_SECONDS)
            loop_now = asyncio.get_running_loop().time()
            if (
                loop_now - self._last_orphan_reconcile
                >= ORPHAN_RECONCILE_SECONDS
            ):
                self._last_orphan_reconcile = loop_now
                try:
                    await self._reconcile_orphans()
                except Exception:
                    logger.exception("Failed to run workflow orphan reconciliation")
            leased = dict(self._leased_runs)
            if not leased:
                continue
            by_project: dict[str, list[str]] = {}
            for run_id, project_id in leased.items():
                by_project.setdefault(project_id, []).append(run_id)
            for project_id, run_ids in by_project.items():
                def refresh(_project, run_ids=tuple(run_ids)):
                    WorkflowRun.update(heartbeat_at=utc_now()).where(
                        (WorkflowRun.id.in_(run_ids))
                        & (WorkflowRun.owner_id == self.instance_id)
                    ).execute()

                try:
                    await self._run_db(project_id, refresh)
                except Exception:
                    logger.exception(
                        "Failed to renew run leases for project %s", project_id
                    )

    async def shutdown(self) -> None:
        """Stop all lease and retry tasks during graceful shutdown."""
        if self._heartbeat_task is not None:
            self._heartbeat_task.cancel()
            try:
                await self._heartbeat_task
            except asyncio.CancelledError:
                pass
            self._heartbeat_task = None
        for task in tuple(self._retry_tasks):
            task.cancel()
        self._retry_tasks.clear()
        self._leased_runs.clear()
