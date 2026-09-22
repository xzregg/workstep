"""Global concurrency gate for task and chat channels.

Two independent channels (tasks and chats) each carry their own concurrency
limit, waiting queue and FIFO wake-up. A channel being full never blocks the
other channel: a task waiting for a task slot does not consume a chat slot
and vice versa.

Effective limits resolve per project as: project explicit value > global
default > unlimited (0). Each project counts against its own pool: project A
configured to 2 and project B inheriting a global 3 never share slots.

Scheduled tasks are exempt from the task channel when ``schedule_exempt`` is
enabled for the effective scope.

The gate is an in-memory singleton. Configuration is pushed into it at
startup and whenever settings change (see ``configure`` /
``set_project_config``); the hot path never touches the database.
"""

from __future__ import annotations

import asyncio
import logging
from collections import defaultdict, deque

logger = logging.getLogger(__name__)

# Task sources. Scheduled dispatch is exempt when schedule_exempt is on.
SOURCE_MANUAL = "manual"
SOURCE_SCHEDULE = "schedule"
SOURCE_SCHEDULED_START = "scheduled_start"
SCHEDULE_SOURCES = {SOURCE_SCHEDULE, SOURCE_SCHEDULED_START}

# acquire results
GRANTED = "granted"
QUEUED = "queued"
ALREADY_ACTIVE = "already_active"


class ConcurrencyGate:
    """Per-project FIFO semaphores for the task and chat channels."""

    def __init__(self) -> None:
        self._global = {"max_tasks": 0, "max_chats": 0, "schedule_exempt": False}
        self._projects: dict[str, dict] = {}  # project_id -> override config or {}
        self._lock = asyncio.Lock()
        # task channel: project_id -> {running set, waiting deque}
        self._task_running: dict[str, set[str]] = defaultdict(set)
        self._task_waiters: dict[str, deque[tuple[str, asyncio.Future]]] = defaultdict(deque)
        # chat channel: project_id -> {running session keys, waiting deque}
        self._chat_running: dict[str, set[str]] = defaultdict(set)
        self._chat_waiters: dict[str, deque[tuple[str, asyncio.Future]]] = defaultdict(deque)

    # ── configuration ──────────────────────────────────────────────────

    def reset(self) -> None:
        """Clear all state and restore unlimited defaults (used on shutdown/tests)."""
        self._global = {"max_tasks": 0, "max_chats": 0, "schedule_exempt": False}
        self._projects.clear()
        self._task_running.clear()
        self._task_waiters.clear()
        self._chat_running.clear()
        self._chat_waiters.clear()

    def configure(self, *, max_tasks: int, max_chats: int, schedule_exempt: bool) -> None:
        """Push global defaults (0 = unlimited). Safe to call any time."""
        self._global = {
            "max_tasks": max_tasks,
            "max_chats": max_chats,
            "schedule_exempt": schedule_exempt,
        }
        self._schedule_rebalance()

    def set_project_config(self, project_id: str, config: dict | None) -> None:
        """Push a project's override (None or all-null removes the override)."""
        if config:
            cleaned = {k: v for k, v in config.items() if v is not None}
            if cleaned:
                self._projects[project_id] = cleaned
                self._schedule_rebalance(project_id)
                return
        self._projects.pop(project_id, None)
        self._schedule_rebalance(project_id)

    def drop_project(self, project_id: str) -> None:
        """Remove a project's override (project deleted / settings reset)."""
        self._projects.pop(project_id, None)

    def _effective(self, project_id: str) -> dict:
        override = self._projects.get(project_id) or {}
        max_tasks = override.get("max_tasks", self._global["max_tasks"])
        max_chats = override.get("max_chats", self._global["max_chats"])
        schedule_exempt = override.get(
            "schedule_exempt", self._global["schedule_exempt"]
        )
        return {
            "max_tasks": int(max_tasks) if int(max_tasks) > 0 else 0,
            "max_chats": int(max_chats) if int(max_chats) > 0 else 0,
            "schedule_exempt": bool(schedule_exempt),
        }

    def effective_config(self, project_id: str) -> dict:
        """Public snapshot for UI display (project > global)."""
        return dict(self._effective(project_id))

    # ── task channel ───────────────────────────────────────────────────

    async def acquire_task(
        self,
        project_id: str,
        task_id: str,
        source: str,
    ) -> str:
        """Try to take a task slot.

        Returns ``GRANTED`` when the task may run immediately (including
        exempt scheduled tasks and unlimited configs), ``QUEUED`` when the
        caller must wait on ``wait_task_slot``, or ``ALREADY_ACTIVE`` when
        the task already holds a slot or sits in the queue.
        """
        cfg = self._effective(project_id)
        if cfg["schedule_exempt"] and source in SCHEDULE_SOURCES:
            return GRANTED
        max_tasks = cfg["max_tasks"]
        if max_tasks <= 0:
            return GRANTED
        async with self._lock:
            if self._task_active(project_id, task_id):
                return ALREADY_ACTIVE
            if len(self._task_running[project_id]) < max_tasks:
                self._task_running[project_id].add(task_id)
                return GRANTED
            loop = asyncio.get_running_loop()
            fut: asyncio.Future = loop.create_future()
            self._task_waiters[project_id].append((task_id, fut))
        return QUEUED

    async def wait_task_slot(self, project_id: str, task_id: str) -> None:
        """Block until the queued task is granted its slot."""
        fut = self._pop_task_future(project_id, task_id)
        if fut is None:
            # Not actually queued (e.g. released between acquire and wait).
            return
        try:
            await fut
        except asyncio.CancelledError:
            async with self._lock:
                waiters = self._task_waiters[project_id]
                self._task_waiters[project_id] = deque(
                    item for item in waiters if item[1] is not fut
                )
                if not fut.done():
                    fut.cancel()
            raise

    def cancel_queued_task(self, project_id: str, task_id: str) -> bool:
        """Remove a queued (not yet running) task from the wait queue.

        Returns True when the task was actually waiting.
        """
        async def _cleanup() -> None:
            async with self._lock:
                waiters = self._task_waiters.get(project_id)
                if not waiters:
                    return
                kept: deque[tuple[str, asyncio.Future]] = deque()
                for item in waiters:
                    if item[0] == task_id:
                        if not item[1].done():
                            item[1].cancel()
                    else:
                        kept.append(item)
                self._task_waiters[project_id] = kept
                self._task_running[project_id].discard(task_id)

        asyncio.create_task(_cleanup())
        return True

    def task_queue_position(self, project_id: str, task_id: str) -> int:
        """1-based position in the project's task wait queue (0 = not queued)."""
        for index, (queued_id, _fut) in enumerate(
            self._task_waiters.get(project_id, ()), start=1
        ):
            if queued_id == task_id:
                return index
        return 0

    async def release_task(self, project_id: str, task_id: str) -> None:
        """Free a task slot and wake as many queued tasks of the project as fit."""
        async with self._lock:
            self._task_running[project_id].discard(task_id)
            max_tasks = self._effective(project_id)["max_tasks"]
            waiters = self._task_waiters.get(project_id)
            if not waiters or max_tasks <= 0:
                return
            while waiters and len(self._task_running[project_id]) < max_tasks:
                queued_id, fut = waiters.popleft()
                if fut.done():
                    continue
                self._task_running[project_id].add(queued_id)
                fut.set_result(None)

    # ── chat channel ───────────────────────────────────────────────────

    async def acquire_chat(self, project_id: str, session_key: str) -> None:
        """Take a chat slot for one turn.

        A session that already holds a running slot passes through immediately
        (its turns are serialized by the runtime's own session lock), so a
        follow-up message in the same conversation never blocks itself.
        """
        cfg = self._effective(project_id)
        max_chats = cfg["max_chats"]
        if max_chats <= 0:
            return
        async with self._lock:
            if session_key in self._chat_running[project_id]:
                return
            if len(self._chat_running[project_id]) < max_chats:
                self._chat_running[project_id].add(session_key)
                return
            loop = asyncio.get_running_loop()
            fut: asyncio.Future = loop.create_future()
            self._chat_waiters[project_id].append((session_key, fut))
        try:
            await fut
        except asyncio.CancelledError:
            async with self._lock:
                waiters = self._chat_waiters[project_id]
                self._chat_waiters[project_id] = deque(
                    item for item in waiters if item[1] is not fut
                )
                if not fut.done():
                    fut.cancel()
            raise

    async def release_chat(self, project_id: str, session_key: str) -> None:
        """Free a chat slot and wake the first waiting session of the project."""
        async with self._lock:
            self._chat_running[project_id].discard(session_key)
            max_chats = self._effective(project_id)["max_chats"]
            waiters = self._chat_waiters.get(project_id)
            if not waiters or max_chats <= 0:
                return
            while waiters and len(self._chat_running[project_id]) < max_chats:
                _session_key, fut = waiters.popleft()
                if fut.done():
                    continue
                self._chat_running[project_id].add(_session_key)
                fut.set_result(None)

    def chat_queue_position(self, project_id: str, session_key: str) -> int:
        """1-based position in the project's chat wait queue (0 = not queued)."""
        for index, (queued_key, _fut) in enumerate(
            self._chat_waiters.get(project_id, ()), start=1
        ):
            if queued_key == session_key:
                return index
        return 0

    # ── helpers ────────────────────────────────────────────────────────

    def _task_active(self, project_id: str, task_id: str) -> bool:
        if task_id in self._task_running[project_id]:
            return True
        return any(
            item[0] == task_id for item in self._task_waiters.get(project_id, ())
        )

    def _pop_task_future(
        self, project_id: str, task_id: str
    ) -> asyncio.Future | None:
        for index, (queued_id, fut) in enumerate(
            self._task_waiters.get(project_id, ())
        ):
            if queued_id == task_id:
                return fut
        return None

    def active_count(self, project_id: str) -> dict:
        """Diagnostic snapshot: running + queued per channel."""
        return {
            "tasks_running": len(self._task_running.get(project_id, ())),
            "tasks_queued": len(self._task_waiters.get(project_id, ())),
            "chats_running": len(self._chat_running.get(project_id, ())),
            "chats_queued": len(self._chat_waiters.get(project_id, ())),
        }

    def _schedule_rebalance(self, project_id: str | None = None) -> None:
        """Wake queued work after a live limit increase or unlimited switch."""
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        loop.create_task(self._rebalance(project_id))

    async def _rebalance(self, project_id: str | None = None) -> None:
        async with self._lock:
            project_ids = (
                {project_id}
                if project_id is not None
                else set(self._task_waiters) | set(self._chat_waiters)
            )
            for pid in project_ids:
                cfg = self._effective(pid)
                task_waiters = self._task_waiters.get(pid)
                if task_waiters:
                    max_tasks = cfg["max_tasks"]
                    while task_waiters and (
                        max_tasks <= 0
                        or len(self._task_running[pid]) < max_tasks
                    ):
                        queued_id, fut = task_waiters.popleft()
                        if fut.done():
                            continue
                        if max_tasks > 0:
                            self._task_running[pid].add(queued_id)
                        fut.set_result(None)

                chat_waiters = self._chat_waiters.get(pid)
                if chat_waiters:
                    max_chats = cfg["max_chats"]
                    while chat_waiters and (
                        max_chats <= 0
                        or len(self._chat_running[pid]) < max_chats
                    ):
                        queued_key, fut = chat_waiters.popleft()
                        if fut.done():
                            continue
                        if max_chats > 0:
                            self._chat_running[pid].add(queued_key)
                        fut.set_result(None)


# Module-level singleton used by the runtime and assistant runtime.
concurrency_gate = ConcurrencyGate()


def session_key(project_id: str, session_id: str) -> str:
    """Canonical chat-channel key for one conversation."""
    return f"{project_id}:{session_id}"
