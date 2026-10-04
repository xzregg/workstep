"""Append-only JSONL persistence for long-running assistant turns.

The journal is the canonical process-event stream. SQLite remains the query
projection for sessions and messages; callers only need to start a turn,
record events, and request either a compact snapshot or a detailed timeline.
"""

from __future__ import annotations

import asyncio
import functools
import json
import logging
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


_SAFE_SEGMENT = re.compile(r"^[A-Za-z0-9_.:-]+$")
logger = logging.getLogger(__name__)
_SUMMARY_EVENT_TYPES = {
    "async_question",
    "interaction_request",
    "interaction_response",
    "plan",
    "plan_update",
    "plan_removed",
    "compacted",
    "goal_update",
    "session_started",
    "error",
    "a2ui",
    "flow_proposals",
    "flow_proposals_rejected",
}


def _event_time_ms(value: Any) -> int | None:
    """Event timestamp -> epoch milliseconds for summaries."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
        return int(number) if number >= 1_000_000_000_000 else int(number * 1000)
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value)
        except ValueError:
            return None
        return int(parsed.timestamp() * 1000)
    return None


@dataclass(frozen=True, slots=True)
class JournalRef:
    root: Path
    relative_path: str


@dataclass(slots=True)
class _WriterState:
    ref: JournalRef
    next_seq: int = 1
    buffered: list[dict[str, Any]] = field(default_factory=list)
    buffered_bytes: int = 0
    last_flush: float = field(default_factory=time.monotonic)


def _storage_operation(operation):
    @functools.wraps(operation)
    def serialized(self, *args, **kwargs):
        # Project database workers can also read or append the same journal.
        # Serialize complete storage operations across both kinds of worker.
        with self._storage_lock:
            return operation(self, *args, **kwargs)
    return serialized


class TurnEventJournal:
    """Own JSONL layout, buffered appends, recovery and UI projections."""

    def __init__(self, *, flush_interval: float = 0.5, flush_bytes: int = 32 * 1024):
        self._flush_interval = flush_interval
        self._flush_bytes = flush_bytes
        self._states: dict[Path, _WriterState] = {}
        self._storage_lock = threading.RLock()
        self._io_executor = ThreadPoolExecutor(
            max_workers=1,
            thread_name_prefix="workstep-event-journal",
        )
        self._io_closed = False
        self._flush_handles: dict[JournalRef, asyncio.TimerHandle] = {}
        self._flush_tasks: set[asyncio.Task] = set()

    async def _run_io(self, operation, /, *args, **kwargs):
        """Serialize journal storage work outside the daemon event loop."""
        if self._io_closed:
            raise RuntimeError("Turn event journal is closed")
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            self._io_executor,
            functools.partial(operation, *args, **kwargs),
        )

    async def astart(self, *args, **kwargs) -> JournalRef:
        return await self._run_io(self.start, *args, **kwargs)

    async def arecord(self, *args, **kwargs) -> int:
        sequence = await self._run_io(self.record, *args, **kwargs)
        self._schedule_flush(args[0] if args else kwargs["ref"])
        return sequence

    async def amove_to_conversation(self, *args, **kwargs) -> JournalRef:
        return await self._run_io(self.move_to_conversation, *args, **kwargs)

    async def async_flush(self, *args, **kwargs) -> None:
        await self._run_io(self.sync, *args, **kwargs)

    async def afinish(self, *args, **kwargs) -> None:
        self._cancel_flush(args[0] if args else kwargs["ref"])
        await self._run_io(self.finish, *args, **kwargs)

    async def asnapshot(self, *args, **kwargs) -> dict[str, Any]:
        return await self._run_io(self.snapshot, *args, **kwargs)

    async def atimeline(self, *args, **kwargs) -> dict[str, Any]:
        return await self._run_io(self.timeline, *args, **kwargs)

    async def adelete_session(self, *args, **kwargs) -> None:
        await self._run_io(self.delete_session, *args, **kwargs)

    async def aclose(self) -> None:
        if self._io_closed:
            return
        for handle in self._flush_handles.values():
            handle.cancel()
        self._flush_handles.clear()
        if self._flush_tasks:
            await asyncio.gather(*tuple(self._flush_tasks))
        await self._run_io(self._close_files)
        self._io_closed = True
        await asyncio.to_thread(self._io_executor.shutdown, True)

    @staticmethod
    def _segment(value: str) -> str:
        if not value or not _SAFE_SEGMENT.fullmatch(value):
            raise ValueError("Invalid journal path segment")
        return value

    @_storage_operation
    def start(
        self,
        workstep_dir: str | Path,
        session_id: str,
        message_id: str,
        conversation_id: str | None = None,
    ) -> JournalRef:
        root = Path(workstep_dir).resolve()
        relative = Path("event_logs") / self._segment(session_id)
        if conversation_id:
            relative /= self._segment(conversation_id)
        relative /= f"{self._segment(message_id)}.jsonl"
        ref = JournalRef(root=root, relative_path=relative.as_posix())
        path = self.resolve(root, ref)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.touch(exist_ok=True)
        next_seq = 1
        existing = self._read(ref)
        if existing:
            next_seq = max(int(item.get("seq") or 0) for item in existing) + 1
        self._states[path] = _WriterState(ref=ref, next_seq=next_seq)
        return ref

    @_storage_operation
    def move_to_conversation(
        self,
        ref: JournalRef,
        conversation_id: str,
    ) -> JournalRef:
        """Move a just-started task journal beneath its resolved engine session."""
        conversation = self._segment(conversation_id)
        source = self.resolve(ref.root, ref)
        if source.parent.name == conversation:
            return ref
        self.sync(ref, durable=True)
        destination = source.parent / conversation / source.name
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists() and destination.resolve() != source.resolve():
            raise FileExistsError(f"Journal destination already exists: {destination}")
        state = self._states.pop(source, None)
        source.replace(destination)
        moved = JournalRef(
            root=ref.root,
            relative_path=destination.relative_to(ref.root).as_posix(),
        )
        if state is not None:
            state.ref = moved
            self._states[destination.resolve()] = state
        return moved

    def reopen(self, workstep_dir: str | Path, relative_path: str) -> JournalRef:
        ref = JournalRef(Path(workstep_dir).resolve(), relative_path)
        self.resolve(workstep_dir, ref)
        return ref

    def resolve(self, workstep_dir: str | Path, ref: JournalRef) -> Path:
        root = Path(workstep_dir).resolve()
        if ref.root.resolve() != root:
            raise ValueError("Journal belongs to another project")
        candidate = (root / ref.relative_path).resolve()
        event_root = (root / "event_logs").resolve()
        try:
            candidate.relative_to(event_root)
        except ValueError as exc:
            raise ValueError("Journal path escapes project event_logs") from exc
        return candidate

    @_storage_operation
    def record(self, ref: JournalRef, event: dict[str, Any], *, force: bool = False) -> int:
        path = self.resolve(ref.root, ref)
        state = self._states.get(path)
        if state is None:
            state = _WriterState(ref=ref)
            existing = self._read(ref)
            if existing:
                state.next_seq = max(int(item.get("seq") or 0) for item in existing) + 1
            self._states[path] = state
        record = {
            "v": 1,
            "seq": state.next_seq,
            "timestamp": event.get("timestamp") or datetime.now(timezone.utc).isoformat(),
            "type": str(event.get("type") or ""),
            "data": event.get("data") if isinstance(event.get("data"), dict) else {},
        }
        state.next_seq += 1
        encoded = json.dumps(record, ensure_ascii=False, separators=(",", ":"))
        state.buffered.append(record)
        state.buffered_bytes += len(encoded.encode("utf-8")) + 1
        self._schedule_flush(ref)
        elapsed = time.monotonic() - state.last_flush
        if force or state.buffered_bytes >= self._flush_bytes or elapsed >= self._flush_interval:
            self.sync(ref, durable=force)
        return int(record["seq"])

    @_storage_operation
    def sync(self, ref: JournalRef, *, durable: bool = False) -> None:
        path = self.resolve(ref.root, ref)
        state = self._states.get(path)
        if state is None or not state.buffered:
            return
        payload = "".join(
            json.dumps(item, ensure_ascii=False, separators=(",", ":")) + "\n"
            for item in state.buffered
        ).encode("utf-8")
        with path.open("ab") as handle:
            handle.write(payload)
            handle.flush()
            if durable:
                os.fsync(handle.fileno())
        state.buffered.clear()
        state.buffered_bytes = 0
        state.last_flush = time.monotonic()

    def _schedule_flush(self, ref: JournalRef) -> None:
        # Timer/task ownership stays on the event loop; storage state stays on
        # the I/O worker. Synchronous worker calls never touch loop handles.
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        if not self._io_closed and ref not in self._flush_handles:
            self._flush_handles[ref] = loop.call_later(
                self._flush_interval, self._flush_scheduled, ref,
            )

    def _cancel_flush(self, ref: JournalRef) -> None:
        handle = self._flush_handles.pop(ref, None)
        if handle is not None:
            handle.cancel()

    def _flush_scheduled(self, ref: JournalRef) -> None:
        self._flush_handles.pop(ref, None)
        if self._io_closed:
            return
        task = asyncio.create_task(self.async_flush(ref))
        self._flush_tasks.add(task)
        task.add_done_callback(self._flush_done)

    def _flush_done(self, task: asyncio.Task) -> None:
        self._flush_tasks.discard(task)
        if not task.cancelled() and task.exception() is not None:
            logger.error("Scheduled event journal flush failed", exc_info=task.exception())

    @_storage_operation
    def finish(self, ref: JournalRef, event: dict[str, Any] | None = None) -> None:
        self.sync(ref)
        events = self._read(ref)
        answered = {
            str((item.get("data") or {}).get("interaction_id") or "")
            for item in events
            if item.get("type") == "interaction_response"
        }
        for item in events:
            if item.get("type") != "interaction_request":
                continue
            data = item.get("data") or {}
            interaction_id = str(data.get("interaction_id") or "")
            if not interaction_id or interaction_id in answered:
                continue
            method = data.get("method")
            response = (
                {"outcome": {"outcome": "cancelled"}}
                if method == "session/request_permission"
                else {"action": "cancel"}
            )
            self.record(ref, {
                "type": "interaction_response",
                "data": {
                    "interaction_id": interaction_id,
                    "method": method,
                    "response": response,
                },
            })
            answered.add(interaction_id)
        if event is not None:
            self.record(ref, event, force=True)
        else:
            self.sync(ref, durable=True)
        self._states.pop(self.resolve(ref.root, ref), None)

    @_storage_operation
    def snapshot(self, ref: JournalRef) -> dict[str, Any]:
        self.sync(ref)
        events = self._read(ref)
        content_parts: list[str] = []
        thought_characters = 0
        commentary_characters = 0
        tool_ids: set[str] = set()
        summary_events: list[dict[str, Any]] = []
        latest_usage: dict[str, Any] | None = None
        first_event_ms: int | None = None
        first_output_at: str | None = None
        last_event_ms: int | None = None
        for event in events:
            event_type = event.get("type")
            data = event.get("data") or {}
            event_ms = _event_time_ms(event.get("timestamp"))
            if event_ms is not None:
                if first_event_ms is None or event_ms < first_event_ms:
                    first_event_ms = event_ms
                if last_event_ms is None or event_ms > last_event_ms:
                    last_event_ms = event_ms
            if event_type == "agent_message_chunk":
                text = str((data.get("content") or {}).get("text", ""))
                if text and first_output_at is None and event_ms is not None:
                    first_output_at = event.get("timestamp")
                if data.get("phase") == "commentary":
                    commentary_characters += len(text)
                else:
                    content_parts.append(text)
            elif event_type == "agent_thought_chunk":
                text = str((data.get("content") or {}).get("text", ""))
                if text and first_output_at is None and event_ms is not None:
                    first_output_at = event.get("timestamp")
                thought_characters += len(text)
            elif event_type in {"tool_call", "tool_call_update"}:
                tool_id = str(data.get("tool_call_id") or data.get("id") or "")
                if tool_id:
                    tool_ids.add(tool_id)
            elif event_type == "usage_update":
                latest_usage = {
                    "type": event_type,
                    "data": data,
                    "timestamp": event.get("timestamp"),
                }
            elif event_type in _SUMMARY_EVENT_TYPES:
                summary_events.append({
                    "type": event_type,
                    "data": data,
                    "timestamp": event.get("timestamp"),
                })
        if latest_usage is not None:
            summary_events.append(latest_usage)
        summary: dict[str, Any] = {
            "event_count": len(events),
            "last_event_seq": int(events[-1].get("seq") or 0) if events else 0,
            "thought_characters": thought_characters,
            "commentary_characters": commentary_characters,
            "tool_count": len(tool_ids),
        }
        if first_output_at is not None:
            summary["first_output_at"] = first_output_at
        if first_event_ms is not None and last_event_ms is not None:
            summary["elapsed_ms"] = last_event_ms - first_event_ms
        return {
            "content": "".join(content_parts),
            "summary": summary,
            "events": summary_events,
        }

    @_storage_operation
    def timeline(
        self,
        ref: JournalRef,
        *,
        cursor: int = 0,
        limit: int = 30000,
    ) -> dict[str, Any]:
        self.sync(ref)
        all_events = self._read(ref)
        available = [
            event for event in all_events
            if int(event.get("seq") or 0) > max(0, cursor)
        ]
        bounded_limit = min(max(1, limit), 30000)
        events = available[:bounded_limit]
        last_seq = int(events[-1].get("seq") or cursor) if events else cursor
        return {
            "events": events,
            "event_count": len(all_events),
            "last_event_seq": last_seq,
            "next_cursor": last_seq if len(available) > len(events) else None,
            "complete": len(available) <= len(events),
        }

    @_storage_operation
    def delete_session(self, workstep_dir: str | Path, session_id: str) -> None:
        root = Path(workstep_dir).resolve()
        directory = (root / "event_logs" / self._segment(session_id)).resolve()
        directory.relative_to((root / "event_logs").resolve())
        if not directory.exists():
            return
        for path in directory.glob("*.jsonl"):
            self._states.pop(path.resolve(), None)
            path.unlink(missing_ok=True)
        try:
            directory.rmdir()
        except OSError:
            pass

    @_storage_operation
    def _close_files(self) -> None:
        for state in tuple(self._states.values()):
            self.sync(state.ref, durable=True)
        self._states.clear()

    def close(self) -> None:
        if self._io_closed:
            return
        self._close_files()
        self._io_closed = True
        self._io_executor.shutdown(wait=True)

    @_storage_operation
    def _read(self, ref: JournalRef) -> list[dict[str, Any]]:
        path = self.resolve(ref.root, ref)
        if not path.exists():
            return []
        events: list[dict[str, Any]] = []
        with path.open("r", encoding="utf-8") as handle:
            for line in handle:
                try:
                    item = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(item, dict) and item.get("type"):
                    events.append(item)
        return events
