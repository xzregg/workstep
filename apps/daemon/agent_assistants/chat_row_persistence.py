"""Project-local chat session and message row persistence."""

import json
import logging
import re
from datetime import datetime
from typing import Any

from agent_assistants.base import PersistenceAdapter, repair_message_times
from agent_assistants.event_truncation import truncate_large_tool_payloads
from engines.codex_visualize import (
    CODEX_ENGINE_IDS,
    convert_event_visualize_markers,
    convert_visualize_markers,
)
from models.chat_session import ChatMessage, ChatSession
from models.fields import utc_now

logger = logging.getLogger(__name__)
DEFAULT_TITLE_LENGTH = 40


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


def _from_iso(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def _load_json(raw: str | None, default):
    if not raw:
        return default
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return default


def _preview(text: str, limit: int) -> str:
    collapsed = re.sub(r"\s+", " ", text or "").strip()
    return collapsed if len(collapsed) <= limit else f"{collapsed[:limit]}…"


def _extract_usage(events: list | None) -> dict | None:
    for event in events or []:
        if isinstance(event, dict) and event.get("type") in ("usage", "usage_update"):
            data = event.get("data")
            return data if isinstance(data, dict) else dict(event)
    return None


class ChatRowPersistence(PersistenceAdapter):
    """Persist one chat conversation as rows in chat_sessions / chat_messages."""

    # ── session / messages loading ─────────────────────────────────────

    def load(self, session) -> None:
        row = ChatSession.get_or_none(ChatSession.id == session.session_id)
        if row is None:
            return
        session.messages = self._load_messages(row)
        session.resolved_session_id = row.engine_session_id
        if row.engine_state_json:
            try:
                session.engine_state = json.loads(row.engine_state_json)
            except json.JSONDecodeError:
                logger.exception("Failed to restore chat engine state")
        handoff = _load_json(row.fork_context_json, None)
        if isinstance(handoff, dict) and not handoff.get("consumed"):
            session.extra["pending_handoff"] = handoff
        session.engine = row.engine or session.engine
        if row.model is not None:
            session.model = row.model
        if row.fast_model is not None:
            session.fast_model = row.fast_model
        if row.vision_model is not None:
            session.vision_model = row.vision_model

    def _load_messages(self, row: ChatSession) -> list[dict]:
        messages: list[dict] = []
        rows = (
            ChatMessage.select()
            .where(ChatMessage.session == row)
            .order_by(ChatMessage.created_at, ChatMessage.id)
        )
        for item in rows:
            message: dict = {
                "role": item.role,
                "content": convert_visualize_markers(item.content or ""),
                "id": item.id,
                "created_at": _iso(item.created_at),
            }
            if item.author_name:
                message.update(
                    author_id=item.author_id,
                    author_name=item.author_name,
                    author_device_id=item.author_device_id,
                    author_device_name=item.author_device_name,
                )
            if item.status:
                message["status"] = item.status
            if item.engine:
                message["engine"] = item.engine
            if item.model:
                message["model"] = item.model
            if item.prompt:
                message["prompt"] = item.prompt
            if item.ended_at:
                message["ended_at"] = _iso(item.ended_at)
            events = _load_json(item.events_json, [])
            if events:
                # 历史出口同样截断超大工具载荷：events_json 按全量保真落库，
                # 单条消息可达数十 MB（raw_output）。整包随 history 下发会让
                # 前端 JSON.parse + store 常驻数百 MB（多会话缓存叠加后直接
                # 压垮渲染进程）。完整内容仍可在展开时经 messageEvents 懒加载。
                if item.engine in CODEX_ENGINE_IDS:
                    events = [
                        convert_event_visualize_markers(event) for event in events
                    ]
                message["events"] = [
                    truncate_large_tool_payloads(event) for event in events
                ]
            summary = _load_json(item.event_summary_json, {})
            if item.event_log_path:
                message["event_log_path"] = item.event_log_path
                message["event_summary"] = summary
                message["event_detail"] = {
                    "available": True,
                    "loaded": False,
                    "event_count": item.event_count or 0,
                    "last_event_seq": item.last_event_seq or 0,
                    **summary,
                }
            message = repair_message_times(message)
            messages.append(message)
        return messages

    # ── save ───────────────────────────────────────────────────────────

    def save(self, session) -> None:
        now = utc_now()
        row = ChatSession.get_or_none(ChatSession.id == session.session_id)
        if row is None:
            row = ChatSession.create(
                id=session.session_id,
                project_id=session.project_id,
                workflow_id=session.scope_key or "",
                title=self._default_title(session.messages),
                engine=session.engine,
                model=session.model,
                fast_model=session.fast_model,
                vision_model=session.vision_model,
                engine_session_id=session.resolved_session_id,
                engine_state_json=self._dump_state(session.engine_state),
                created_at=now,
                updated_at=now,
            )
        else:
            title = row.title or self._default_title(session.messages)
            row.title = title
            row.engine_session_id = session.resolved_session_id
            row.engine_state_json = self._dump_state(session.engine_state)
            pending_handoff = session.extra.get("pending_handoff")
            if isinstance(pending_handoff, dict):
                last = session.messages[-1] if session.messages else {}
                if last.get("role") == "assistant" and last.get("status") == "succeeded":
                    pending_handoff = {**pending_handoff, "consumed": True}
                    session.extra.pop("pending_handoff", None)
                row.fork_context_json = json.dumps(pending_handoff, ensure_ascii=False)
            row.updated_at = now
            row.save()
        for item in session.messages:
            message_id = str(item.get("id") or "")
            if not message_id:
                continue
            created_at = _from_iso(item.get("created_at")) or now
            ended_at = _from_iso(item.get("ended_at"))
            events = [e for e in (item.get("events") or []) if isinstance(e, dict)]
            values = {
                "session": row,
                "role": item.get("role", "assistant"),
                "content": item.get("content", ""),
                "author_id": item.get("author_id"),
                "author_name": item.get("author_name"),
                "author_device_id": item.get("author_device_id"),
                "author_device_name": item.get("author_device_name"),
                "status": item.get("status") or (
                    "succeeded" if item.get("role") == "assistant" else None
                ),
                "engine": item.get("engine"),
                "model": item.get("model"),
                "prompt": item.get("prompt"),
                "events_json": json.dumps(events, ensure_ascii=False) if events else None,
                "event_log_path": item.get("event_log_path"),
                "event_summary_json": (
                    json.dumps(item.get("event_summary"), ensure_ascii=False)
                    if item.get("event_summary") else None
                ),
                "event_count": int((item.get("event_summary") or {}).get("event_count") or 0),
                "last_event_seq": int((item.get("event_summary") or {}).get("last_event_seq") or 0),
                "usage_json": (
                    json.dumps(_extract_usage(events), ensure_ascii=False)
                    if _extract_usage(events) else None
                ),
                "created_at": created_at,
                "ended_at": ended_at,
            }
            existing = ChatMessage.get_or_none(ChatMessage.id == message_id)
            if existing is None:
                ChatMessage.create(id=message_id, **values)
            else:
                ChatMessage.update(**values).where(ChatMessage.id == message_id).execute()

    @staticmethod
    def _default_title(messages: list[dict]) -> str:
        """Auto-title from the first user message, using its first sentence."""
        for item in messages:
            if item.get("role") != "user":
                continue
            text = re.sub(r"\s+", " ", item.get("content") or "").strip()
            if not text:
                continue
            sentence = re.split(r"[。！？!?；;…]", text, maxsplit=1)[0].strip()
            if not sentence:
                sentence = text
            return _preview(sentence, DEFAULT_TITLE_LENGTH)
        return ""

    @staticmethod
    def _dump_state(state: Any) -> str | None:
        if state is None:
            return None
        try:
            return json.dumps(state, ensure_ascii=False)
        except Exception:
            logger.exception("Failed to serialize chat engine state")
            return None

    # ── history / delete ───────────────────────────────────────────────

    def load_history(
        self,
        project_id: str,
        scope_key: str,
    ) -> tuple[
        str, str | None, str | None, str | None, str | None, list[dict]
    ] | None:
        row = ChatSession.get_or_none(ChatSession.id == scope_key)
        if row is None:
            return None
        return (
            row.engine,
            row.model,
            row.fast_model,
            row.vision_model,
            row.engine_session_id,
            self._load_messages(row),
        )

    def delete(self, project_id: str, scope_key: str) -> bool:
        row = ChatSession.get_or_none(ChatSession.id == scope_key)
        if row is None:
            return False
        ChatMessage.delete().where(ChatMessage.session == row).execute()
        row.delete_instance()
        return True

