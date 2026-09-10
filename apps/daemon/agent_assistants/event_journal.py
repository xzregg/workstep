"""Append-only JSONL persistence for long-running assistant turns.

The journal is the canonical process-event stream. SQLite remains the query
projection for sessions and messages; callers only need to start a turn,
record events, and request either a compact snapshot or a detailed timeline.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


_SAFE_SEGMENT = re.compile(r"^[A-Za-z0-9_.:-]+$")
_SUMMARY_EVENT_TYPES = {
    "interaction_request",
    "interaction_response",
    "plan",
    "plan_update",
    "plan_removed",
    "compacted",
    "session_started",
    "error",
    "a2ui",
    "flow_proposals",
    "flow_proposals_rejected",
}


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
    flush_handle: asyncio.TimerHandle | None = None


class TurnEventJournal:
    """Own JSONL layout, buffered appends, recovery and UI projections."""

    def __init__(self, *, flush_interval: float = 0.5, flush_bytes: int = 32 * 1024):
        self._flush_interval = flush_interval
        self._flush_bytes = flush_bytes
        self._states: dict[Path, _WriterState] = {}

    @staticmethod
    def _segment(value: str) -> str:
        if not value or not _SAFE_SEGMENT.fullmatch(value):
            raise ValueError("Invalid journal path segment")
        return value

    def start(self, workstep_dir: str | Path, session_id: str, message_id: str) -> JournalRef:
        root = Path(workstep_dir).resolve()
        relative = Path("event_logs") / self._segment(session_id) / f"{self._segment(message_id)}.jsonl"
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
        if state.flush_handle is None:
            try:
                loop = asyncio.get_running_loop()
            except RuntimeError:
                pass
            else:
                state.flush_handle = loop.call_later(
                    self._flush_interval,
                    self._flush_scheduled,
                    ref,
                )
        elapsed = time.monotonic() - state.last_flush
        if force or state.buffered_bytes >= self._flush_bytes or elapsed >= self._flush_interval:
            self.sync(ref, durable=force)
        return int(record["seq"])

    def sync(self, ref: JournalRef, *, durable: bool = False) -> None:
        path = self.resolve(ref.root, ref)
        state = self._states.get(path)
        if state is None or not state.buffered:
            return
        if state.flush_handle is not None:
            state.flush_handle.cancel()
            state.flush_handle = None
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

    def _flush_scheduled(self, ref: JournalRef) -> None:
        state = self._states.get(self.resolve(ref.root, ref))
        if state is None:
            return
        state.flush_handle = None
        self.sync(ref)

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
        state = self._states.pop(self.resolve(ref.root, ref), None)
        if state is not None and state.flush_handle is not None:
            state.flush_handle.cancel()

    def snapshot(self, ref: JournalRef) -> dict[str, Any]:
        self.sync(ref)
        events = self._read(ref)
        content_parts: list[str] = []
        thought_characters = 0
        commentary_characters = 0
        tool_ids: set[str] = set()
        summary_events: list[dict[str, Any]] = []
        latest_usage: dict[str, Any] | None = None
        for event in events:
            event_type = event.get("type")
            data = event.get("data") or {}
            if event_type == "agent_message_chunk":
                text = str((data.get("content") or {}).get("text", ""))
                if data.get("phase") == "commentary":
                    commentary_characters += len(text)
                else:
                    content_parts.append(text)
            elif event_type == "agent_thought_chunk":
                thought_characters += len(str((data.get("content") or {}).get("text", "")))
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
        return {
            "content": "".join(content_parts),
            "summary": {
                "event_count": len(events),
                "last_event_seq": int(events[-1].get("seq") or 0) if events else 0,
                "thought_characters": thought_characters,
                "commentary_characters": commentary_characters,
                "tool_count": len(tool_ids),
            },
            "events": summary_events,
        }

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

    def delete_session(self, workstep_dir: str | Path, session_id: str) -> None:
        root = Path(workstep_dir).resolve()
        directory = (root / "event_logs" / self._segment(session_id)).resolve()
        directory.relative_to((root / "event_logs").resolve())
        if not directory.exists():
            return
        for path in directory.glob("*.jsonl"):
            state = self._states.pop(path.resolve(), None)
            if state is not None and state.flush_handle is not None:
                state.flush_handle.cancel()
            path.unlink(missing_ok=True)
        try:
            directory.rmdir()
        except OSError:
            pass

    def close(self) -> None:
        for state in tuple(self._states.values()):
            self.sync(state.ref, durable=True)
        self._states.clear()

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
