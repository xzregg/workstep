"""Periodic task-only recovery through the existing failed-message retry entry.

All reads/claims run in project DB executors. Claims survive daemon restarts;
the runtime still owns validation, locking, execution and slot release.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import timedelta

from models import Message, StepRun, Task, TaskStep, TaskAutoRetryRecord
from models.base import db_proxy
from models.fields import utc_now
from services.concurrency import GRANTED, concurrency_gate
from services.remote_access import replayed_actor_context
from services.step_message_restart import inspect_failed_message_retry

logger = logging.getLogger(__name__)


def load_candidates(now, minutes, after=""):
    """Materialize one bounded page, never returning Peewee objects."""
    cutoff = now - timedelta(minutes=minutes)
    tasks = list(Task.select(Task.id, Task.active_workflow_run_id).where(
        (Task.status == "failed") & (Task.archived == 0) & (Task.id > after)
    ).order_by(Task.id).limit(100))
    candidates = []
    for task in tasks:
        record = TaskAutoRetryRecord.get_or_none(TaskAutoRetryRecord.task == task.id)
        if record and record.attempted_at > cutoff:
            continue
        # Only the latest attempt of a single currently failed step is eligible.
        # Historical failed attempts of that same step must not block recovery.
        failures = list(TaskStep.select(TaskStep.step_key).where(
            (TaskStep.task == task.id) & (TaskStep.status == "failed")
        ).limit(2))
        if len(failures) != 1:
            continue
        step = (StepRun.select().where(
            (StepRun.run == task.active_workflow_run_id)
            & (StepRun.step_key == failures[0].step_key)
        ).order_by(StepRun.attempt.desc(), StepRun.started_at.desc()).first())
        if (step is None or step.status != "failed" or not (step.error or "").strip()
                or not step.ended_at or step.ended_at > cutoff):
            continue
        message = (Message.select(Message.id).where(
            (Message.task == task.id) & (Message.step_run_id == step.id)
            & (Message.role == "assistant") & (Message.channel == "execution")
            & (Message.run_status == "failed")
        ).order_by(Message.sequence.desc(), Message.created_at.desc()).first())
        if message:
            candidates.append((task.id, message.id, step.id))
    return candidates, tasks[-1].id if len(tasks) == 100 else None


def claim_candidate(candidate, now, minutes):
    """Revalidate and reserve an attempt atomically across service instances."""
    task_id, message_id, step_run_id = candidate
    cutoff = now - timedelta(minutes=minutes)
    with db_proxy.atomic("IMMEDIATE"):
        task = Task.get_or_none(Task.id == task_id)
        if task is None or task.archived or task.status != "failed":
            return False
        message = Message.get_or_none(Message.id == message_id)
        if message is None or message.step_run_id != step_run_id:
            return False
        step = StepRun.get_or_none(StepRun.id == step_run_id)
        if step is None or not step.ended_at or step.ended_at > cutoff:
            return False
        try:
            inspect_failed_message_retry(task_id, message_id, False)
        except ValueError:
            return False
        record = TaskAutoRetryRecord.get_or_none(TaskAutoRetryRecord.task == task_id)
        if record and record.attempted_at > cutoff:
            return False
        (TaskAutoRetryRecord.insert(task=task_id, step_run_id=step_run_id, attempted_at=now)
         .on_conflict(conflict_target=[TaskAutoRetryRecord.task], update={
             TaskAutoRetryRecord.step_run_id: step_run_id,
             TaskAutoRetryRecord.attempted_at: now,
         }).execute())
        return True


class TaskAutoRetry:
    def __init__(self, manager, runtime, config):
        self.manager, self.runtime, self.config = manager, runtime, config
        self._stop = asyncio.Event()
        self._tick_lock = asyncio.Lock()
        self._task = None

    def start(self):
        if self._task is None:
            self._task = asyncio.create_task(self._run(), name="task-auto-retry")

    async def close(self):
        self._stop.set()
        if self._task is not None:
            await self._task
            self._task = None

    async def _run(self):
        last_scan = utc_now()
        # Read the live setting cheaply every 15s; scan only at the chosen interval.
        while not self._stop.is_set():
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=15)
            except TimeoutError:
                try:
                    minutes = await asyncio.to_thread(self.config.get_task_retry_interval_minutes)
                    now = utc_now()
                    if minutes and now - last_scan >= timedelta(minutes=minutes):
                        await self.tick(now)
                        last_scan = now
                    elif not minutes:
                        last_scan = now
                except Exception:
                    logger.exception("Task automatic retry scan failed")

    async def tick(self, now=None):
        if self._tick_lock.locked() or self._stop.is_set():
            return
        async with self._tick_lock:
            now = now or utc_now()
            minutes = await asyncio.to_thread(self.config.get_task_retry_interval_minutes)
            if not minutes:
                return
            for project in list(self.manager.iter_projects()):
                after = ""
                try:
                    while not self._stop.is_set():
                        candidates, after_next = await self.manager.run_db(
                            project.id, lambda _: load_candidates(now, minutes, after),
                        )
                        for candidate in candidates:
                            if self._stop.is_set():
                                return
                            # Stop dispatching immediately when the setting is disabled.
                            current = await asyncio.to_thread(self.config.get_task_retry_interval_minutes)
                            if not current:
                                return
                            await self._retry(project.id, candidate, now, current)
                        if after_next is None:
                            break
                        after = after_next
                        await asyncio.sleep(0)
                except Exception:
                    logger.exception("Task automatic retry unavailable: project=%s", project.id)

    async def _retry(self, project_id, candidate, now, minutes):
        task_id, message_id, _ = candidate
        # Do not add hidden queued tasks. Leave failures eligible for the next sweep
        # when the existing task pool is full. No chat slots are touched.
        counts = concurrency_gate.active_count(project_id)
        limit = concurrency_gate.effective_config(project_id)["max_tasks"]
        if limit and (counts["tasks_running"] >= limit or counts["tasks_queued"]):
            return
        acquired = await concurrency_gate.acquire_task(project_id, task_id, "manual")
        if acquired != GRANTED:
            return
        permit = concurrency_gate.task_permit(project_id, task_id)
        launched = False
        try:
            claimed = await self.manager.run_db(
                project_id, lambda _: claim_candidate(candidate, now, minutes),
            )
            if not claimed or self._stop.is_set():
                return
            if await asyncio.to_thread(self.config.get_task_retry_interval_minutes) != minutes:
                return
            # Preserve parent-run attribution; never impersonate the host's current user.
            with replayed_actor_context(None):
                await self.runtime.retry_failed_message(
                    project_id, task_id, message_id,
                    task_permit=permit,
                )
            launched = True
            logger.info("Automatically retried failed task: project=%s task=%s", project_id, task_id)
        except (ValueError, RuntimeError):
            logger.info("Skipped changed/unavailable retry: project=%s task=%s", project_id, task_id)
        except Exception:
            logger.exception("Automatic retry submission failed: project=%s task=%s", project_id, task_id)
        finally:
            if not launched:
                await concurrency_gate.release_task(project_id, task_id, permit=permit)
