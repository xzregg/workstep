"""Codex-style session chat assistant (per project, multiple sessions).

One assistant registered in the shared assistant layer
(``agent_assistants/base.py``): it only declares an ``AssistantConfig``
plus a persistence adapter that stores each conversation row in the new
``chat_sessions`` / ``chat_messages`` tables. Session lifecycle, idempotency,
engine invocation with resume and streaming events all live in the generic
``AssistantRuntime``.

Each project can hold many independent sessions. Sessions are created
explicitly (``create_session``), auto-titled from the first user message,
and can be renamed or deleted. Quick-action buttons above the composer are
configured per project via the ``project_settings`` table.
"""

import asyncio
import json
import logging
import peewee as pw
import re
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from engines.core.registry import COORDINATOR_FALLBACK_ORDER, create_engine
from models.chat_session import ChatMessage, ChatSession, ProjectSetting
from models.fields import utc_now
from agent_assistants.base import (
    AssistantConfig,
    AssistantRuntime,
    PersistenceAdapter,
    SCOPE_CHAT,
    assistant_registry,
    repair_message_times,
    validate_provider_override,
)
from agent_assistants.event_journal import TurnEventJournal
from agent_assistants.event_truncation import truncate_large_tool_payloads
from agent_assistants.context_handoff import (
    append_handoff_log,
    compile_handoff,
    mark_handoff_consumed,
    render_handoff,
    render_handoff_reference,
)
from engines.core.agui import AGUIContext, to_agui_events
from services.chat_permissions import is_valid_permission_mode
from services.config import config_store

logger = logging.getLogger(__name__)

CHAT_CHANNEL = "session_chat"

MAX_HISTORY_TURNS = 8
MAX_SESSIONS = 200
SESSION_TTL_SECONDS = 60 * 60

QUICK_BUTTONS_KEY = "chat_quick_buttons"
SYSTEM_PROMPT_KEY = "chat_system_prompt"
MAX_SYSTEM_PROMPT_LENGTH = 20000
MAX_QUICK_BUTTONS = 20
MAX_QUICK_BUTTON_LABEL = 40
MAX_QUICK_BUTTON_PROMPT = 400
DEFAULT_TITLE_LENGTH = 40
PREVIEW_LENGTH = 60
ENHANCE_MAX_LENGTH = 4000

ENHANCE_SYSTEM_PROMPT = (
    "You rewrite prompts to be clear, specific, and directly executable. "
    "Preserve intent; clarify goals, constraints, context, output format, and tone. "
    "Output only the rewritten prompt."
)

SYSTEM_PROMPT = """You are the WorkStep chat assistant. Work in the project root and help with programming and research: answer questions, explain code and project structure, propose solutions, design tests, review code, and debug.

Keep multi-turn context. Ask one brief question when information is missing. Be concise and actionable. Use Markdown code blocks for code. Reply in the user's language."""


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


_AGUI_EVENT_TYPES = {
    "TEXT_MESSAGE_START",
    "TEXT_MESSAGE_CHUNK",
    "TEXT_MESSAGE_CONTENT",
    "TEXT_MESSAGE_END",
    "REASONING_MESSAGE_CHUNK",
    "TOOL_CALL_START",
    "TOOL_CALL_ARGS",
    "TOOL_CALL_CHUNK",
    "TOOL_CALL_RESULT",
    "RUN_STARTED",
    "RUN_FINISHED",
    "RUN_ERROR",
    "CUSTOM",
}


def _detail_agui_events(
    events: list[dict],
    *,
    project_id: str,
    session_id: str,
    message_id: str,
) -> list[dict]:
    translated: list[dict] = []
    for index, event in enumerate(events, start=1):
        # 出口截断：JSONL 里单条工具输出可达数十 MB，全量下发会冻结浏览器
        # （前端展示上限本就远小于此）。日志保留全量，此处只影响响应。
        event = truncate_large_tool_payloads(event)
        event_type = str(event.get("type") or "")
        sequence = int(event.get("seq") or event.get("sequence") or index)
        if event_type in _AGUI_EVENT_TYPES:
            item = dict(event)
            item.setdefault("sequence", sequence)
            item.setdefault("messageId", message_id)
            translated.append(item)
            continue
        timestamp = event.get("timestamp")
        ctx = AGUIContext(
            project_id=project_id,
            message_id=message_id,
            channel=CHAT_CHANNEL,
            session_id=session_id,
            event_sequence=sequence,
            created_at=timestamp if isinstance(timestamp, str) else None,
            timestamp=timestamp if isinstance(timestamp, (int, float)) else None,
        )
        translated.extend(to_agui_events(event, ctx))
    return translated


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
                "content": item.content,
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


@dataclass(frozen=True, slots=True)
class ChatAccepted:
    session_id: str
    turn_id: str
    status: str

    def to_dict(self) -> dict:
        return {
            "session_id": self.session_id,
            "turn_id": self.turn_id,
            "status": self.status,
        }


DEFAULT_QUICK_BUTTONS = [
    {"id": "generate", "label": "生成实现", "prompt": "请根据当前项目目标，给出完整的实现方案与关键代码（只输出方案，不创建文件）。"},
    {"id": "explain", "label": "解释代码", "prompt": "请解释当前项目中最相关的一段代码或模块结构，说明职责、调用关系与关键实现细节。"},
    {"id": "test", "label": "设计测试", "prompt": "请为当前项目设计单元测试：列出测试文件、关键用例与断言思路（只输出设计，不创建文件）。"},
    {"id": "review", "label": "代码评审", "prompt": "请评审当前项目的代码质量、潜在缺陷与改进建议，按优先级列出。"},
]


class ChatSessionModule(AssistantRuntime):
    """The Codex-style session chat assistant — config + row persistence."""

    def __init__(self, event_bus, project_manager):
        self._event_journal = TurnEventJournal()
        config = AssistantConfig(
            name="chat_session",
            channel=CHAT_CHANNEL,
            system_prompt=SYSTEM_PROMPT,
            scope=SCOPE_CHAT,
            engine_label="Chat engine",
            max_history_turns=MAX_HISTORY_TURNS,
            max_sessions=MAX_SESSIONS,
            session_ttl_seconds=SESSION_TTL_SECONDS,
            persistence=ChatRowPersistence(),
            event_journal=self._event_journal,
            validate_engine=self._validate_engine,
        )
        super().__init__(config, event_bus, project_manager)
        assistant_registry.register(config)

    def recover_interrupted_messages(self) -> int:
        """Finalize journal-backed turns left running by a previous daemon."""
        recovered = 0
        now = utc_now()
        for project in tuple(self._project_manager.iter_projects()):
            try:
                with self._project_manager.activate_project(project.path):
                    pending_ids = [
                        row.id
                        for row in ChatSession.select(ChatSession.id).where(
                            ChatSession.fork_status == "pending"
                        )
                    ]
                    if pending_ids:
                        ChatMessage.delete().where(
                            ChatMessage.session.in_(pending_ids)
                        ).execute()
                        ChatSession.delete().where(
                            ChatSession.id.in_(pending_ids)
                        ).execute()
                    rows = list(ChatMessage.select().where(
                        ChatMessage.role == "assistant",
                        ChatMessage.status == "running",
                    ))
                    for row in rows:
                        summary: dict[str, Any] = {}
                        events: list[dict] = []
                        content = row.content or ""
                        if row.event_log_path:
                            ref = self._event_journal.reopen(
                                project.workstep_dir,
                                row.event_log_path,
                            )
                            snapshot = self._event_journal.snapshot(ref)
                            self._event_journal.finish(ref)
                            content = snapshot["content"] or content
                            summary = snapshot["summary"]
                            events = snapshot["events"]
                        row.content = content
                        row.status = "stopped"
                        row.ended_at = now
                        if events:
                            row.events_json = json.dumps(events, ensure_ascii=False)
                        if summary:
                            row.event_summary_json = json.dumps(summary, ensure_ascii=False)
                        row.event_count = int(summary.get("event_count") or row.event_count or 0)
                        row.last_event_seq = int(summary.get("last_event_seq") or row.last_event_seq or 0)
                        row.save()
                        ChatSession.update(updated_at=now).where(
                            ChatSession.id == row.session_id,
                        ).execute()
                        recovered += 1
            except Exception:
                logger.exception(
                    "Failed to recover interrupted chat messages for project %s",
                    project.id,
                )
        return recovered

    # ── session CRUD ───────────────────────────────────────────────────

    def list_sessions(self, project_id: str, workflow_id: str | None = None) -> list[dict]:
        """The active project database owns sessions, including historical registry IDs."""
        if not project_id:
            raise ValueError("project_id is required")
        with self._project_ctx(project_id):
            rows = (
                ChatSession.select()
                .where(
                    ChatSession.fork_status == "ready",
                )
                .order_by(ChatSession.sort_order, ChatSession.updated_at.desc())
            )
            return [self._session_summary(row, project_id) for row in rows]

    def create_session(
        self,
        project_id: str,
        workflow_id: str | None = None,
        title: str | None = None,
        engine: str | None = None,
        model: str | None = None,
        fast_model: str | None = None,
        vision_model: str | None = None,
        permission_mode: str | None = None,
        provider_id: str | None = None,
    ) -> dict:
        if not project_id:
            raise ValueError("project_id is required")
        permission_mode = (permission_mode or "").strip()
        if permission_mode and not is_valid_permission_mode(permission_mode):
            raise ValueError(f"Unsupported permission mode: {permission_mode}")
        engine_id, default_model, default_fast_model = self._resolve_engine_models()
        default_vision_model = config_store.get_assistant_defaults(
            self._config.name
        ).get("vision_model", "") or None
        if engine:
            self._validate_engine(engine)
            if engine != engine_id:
                default_model = (
                    config_store.get_engine_default_model(engine) or None
                )
                default_fast_model = default_model
                default_vision_model = None
            engine_id = engine
        defaults = config_store.get_assistant_defaults(self._config.name)
        default_provider = (
            defaults.get("provider_id", "")
            if engine_id == (defaults.get("engine") or engine_id)
            else ""
        )
        provider_id = provider_id or default_provider
        normalized_provider = validate_provider_override(provider_id, engine_id)
        model = model or default_model
        fast_model = fast_model or default_fast_model
        vision_model = vision_model or default_vision_model
        session_id = str(uuid.uuid4())
        now = utc_now()
        with self._project_ctx(project_id):
            min_order = (
                ChatSession.select(pw.fn.MIN(ChatSession.sort_order))
                .scalar()
            )
            ChatSession.create(
                id=session_id,
                project_id=project_id,
                workflow_id=workflow_id or "",
                sort_order=(min_order or 0) - 1,
                title=(title or "").strip(),
                engine=engine_id,
                model=model,
                fast_model=fast_model,
                vision_model=vision_model,
                provider_id=normalized_provider or None,
                permission_mode=permission_mode or None,
                created_at=now,
                updated_at=now,
            )
        return self.get_session(project_id, session_id)

    def get_session(self, project_id: str, session_id: str) -> dict | None:
        with self._project_ctx(project_id):
            row = ChatSession.get_or_none(ChatSession.id == session_id)
            if row is None:
                return None
            summary = self._session_summary(row, project_id)
        history = self.history(project_id, session_id) or {}
        for message in history.get("messages", []):
            if message.get("status") != "running" or not message.get("event_log_path"):
                continue
            try:
                with self._project_ctx(project_id) as project:
                    ref = self._event_journal.reopen(
                        project.workstep_dir,
                        str(message["event_log_path"]),
                    )
                    snapshot = self._event_journal.snapshot(ref)
                message["content"] = snapshot["content"]
                message["events"] = [
                    truncate_large_tool_payloads(event)
                    for event in snapshot["events"]
                ]
                message["event_summary"] = snapshot["summary"]
                message["event_detail"] = {
                    "available": True,
                    "loaded": False,
                    **snapshot["summary"],
                }
            except Exception:
                logger.exception("Failed to restore running chat snapshot")
        return {**summary, "messages": history.get("messages", [])}

    def message_events(
        self,
        project_id: str,
        session_id: str,
        message_id: str,
        *,
        cursor: int = 0,
        limit: int = 30000,
    ) -> dict:
        """Read one message's detailed timeline without loading it in history."""
        with self._project_ctx(project_id) as project:
            row = (
                ChatMessage.select(ChatMessage, ChatSession)
                .join(ChatSession)
                .where(
                    ChatMessage.id == message_id,
                    ChatSession.id == session_id,
                )
                .first()
            )
            if row is None:
                raise ValueError("Chat message not found")
            if row.event_log_path:
                ref = self._event_journal.reopen(
                    project.workstep_dir,
                    row.event_log_path,
                )
                page = self._event_journal.timeline(
                    ref,
                    cursor=cursor,
                    limit=limit,
                )
                page["events"] = _detail_agui_events(
                    page["events"],
                    project_id=project_id,
                    session_id=session_id,
                    message_id=message_id,
                )
                return {"message_id": message_id, **page}
            legacy = _load_json(row.events_json, [])
        start = max(0, cursor)
        bounded = min(max(1, limit), 200)
        raw_events = legacy[start:start + bounded]
        events = _detail_agui_events(
            raw_events,
            project_id=project_id,
            session_id=session_id,
            message_id=message_id,
        )
        next_cursor = start + len(raw_events)
        return {
            "message_id": message_id,
            "events": events,
            "event_count": len(legacy),
            "last_event_seq": next_cursor,
            "next_cursor": next_cursor if next_cursor < len(legacy) else None,
            "complete": next_cursor >= len(legacy),
        }

    def rename_session(
        self,
        project_id: str,
        session_id: str,
        title: str,
    ) -> dict | None:
        title = (title or "").strip()
        if not title:
            raise ValueError("Session title cannot be empty")
        with self._project_ctx(project_id):
            row = ChatSession.get_or_none(ChatSession.id == session_id)
            if row is None:
                return None
            row.title = title
            row.updated_at = utc_now()
            row.save()
            return self._session_summary(row, project_id)

    def delete_session(self, project_id: str, session_id: str) -> bool:
        with self._project_ctx(project_id):
            row = ChatSession.get_or_none(ChatSession.id == session_id)
            if row is None:
                raise ValueError("Chat session not found")
            engine_id, engine_session_id = row.engine, row.engine_session_id
        memory_key, sid = self._session_identity(project_id, session_id)
        removed = self.reset_scoped_session(project_id, session_id, memory_key, sid)
        with self._project_ctx(project_id) as project:
            self._event_journal.delete_session(project.workstep_dir, session_id)
        self._purge_engine_persistence(project_id, engine_id, engine_session_id)
        return removed

    def _purge_engine_persistence(
        self,
        project_id: str,
        engine_id: str | None,
        engine_session_id: str | None,
    ) -> None:
        """Reclaim engine-side durable storage (e.g. harness_runs.db) for a session."""
        if not engine_id or not engine_session_id:
            return
        from engines.core.registry import ENGINE_REGISTRY

        cls = ENGINE_REGISTRY.get(engine_id)
        if cls is None:
            return
        try:
            cls().delete_session_persistence(engine_session_id, self._cwd(project_id))
        except Exception:
            import logging

            logging.getLogger(__name__).exception(
                "Failed to purge engine session persistence"
            )

    def bulk_delete_sessions(
        self,
        project_id: str,
        session_ids: list[str],
    ) -> dict:
        """Delete multiple sessions; skip (don't error on) running sessions."""
        if not session_ids:
            raise ValueError("session_ids must not be empty")
        deleted: list[str] = []
        skipped: list[str] = []
        for session_id in session_ids:
            # Skip sessions that are actively running
            if any(
                state.get("session_id") == session_id
                and state.get("status") in {"queued", "running", "stopping"}
                for state in self._turn_states.values()
            ):
                skipped.append(session_id)
                continue
            with self._project_ctx(project_id):
                row = ChatSession.get_or_none(ChatSession.id == session_id)
                if row is None:
                    skipped.append(session_id)
                    continue
                if ChatMessage.select().where(
                    ChatMessage.session == row,
                    ChatMessage.status == "running",
                ).exists():
                    skipped.append(session_id)
                    continue
            memory_key, sid = self._session_identity(project_id, session_id)
            self.reset_scoped_session(project_id, session_id, memory_key, sid)
            with self._project_ctx(project_id) as project:
                self._event_journal.delete_session(project.workstep_dir, session_id)
            deleted.append(session_id)
        return {"deleted": deleted, "skipped": skipped}


    def reorder_sessions(
        self,
        project_id: str,
        ordered_ids: list[str],
    ) -> None:
        """Reassign sort_order from an explicit id list; unknown ids keep their
        relative order at the end of the list."""
        if not project_id:
            raise ValueError("project_id is required")
        with self._project_ctx(project_id):
            rows = list(
                ChatSession.select()
                .order_by(ChatSession.sort_order, ChatSession.updated_at.desc())
            )
            by_id = {row.id: row for row in rows}
            seen: set[str] = set()
            ordered: list[ChatSession] = []
            for session_id in ordered_ids:
                row = by_id.get(session_id)
                if row is not None and session_id not in seen:
                    ordered.append(row)
                    seen.add(session_id)
            for row in rows:
                if row.id not in seen:
                    ordered.append(row)
            for index, row in enumerate(ordered):
                if row.sort_order != index:
                    row.sort_order = index
                    row.save()

    def _session_summary(self, row: ChatSession, project_id: str) -> dict:
        last = (
            ChatMessage.select()
            .where(ChatMessage.session == row)
            .order_by(ChatMessage.created_at.desc())
            .first()
        )
        return {
            "id": row.id,
            "project_id": project_id,
            "workflow_id": row.workflow_id,
            "title": row.title or "未命名会话",
            "engine": row.engine,
            "model": row.model,
            "fast_model": row.fast_model,
            "vision_model": row.vision_model,
            "provider_id": row.provider_id,
            "permission_mode": row.permission_mode or "",
            "engine_session_id": row.engine_session_id,
            "parent_session_id": row.parent_session_id,
            "forked_from_message_id": row.forked_from_message_id,
            "fork_context_mode": row.fork_context_mode,
            "fork_status": row.fork_status or "ready",
            "message_count": ChatMessage.select()
            .where(ChatMessage.session == row)
            .count(),
            "running": ChatMessage.select()
            .where(
                ChatMessage.session == row,
                ChatMessage.status == "running",
            )
            .exists(),
            "last_message_status": last.status if last else None,
            "preview": _preview(last.content, PREVIEW_LENGTH) if last else "",
            "created_at": _iso(row.created_at),
            "updated_at": _iso(row.updated_at),
        }

    def handoff_session(
        self,
        project_id: str,
        session_id: str,
        *,
        engine: str,
        context_mode: str,
        model: str | None = None,
        fast_model: str | None = None,
        vision_model: str | None = None,
        provider_id: str | None = None,
        permission_mode: str | None = None,
    ) -> dict:
        """Switch engines while keeping the same visible chat session."""
        if context_mode not in {"smart", "full", "none"}:
            raise ValueError(f"Unsupported handoff context mode: {context_mode}")
        if any(
            state.get("session_id") == session_id
            and state.get("status") in {"queued", "running", "stopping"}
            for state in self._turn_states.values()
        ):
            raise ValueError("Chat session is running")
        self._validate_engine(engine)
        permission_mode = (permission_mode or "").strip()
        if permission_mode and not is_valid_permission_mode(permission_mode):
            raise ValueError(f"Unsupported permission mode: {permission_mode}")

        normalized_provider = validate_provider_override(
            provider_id,
            engine,
        )

        with self._project_ctx(project_id) as project:
            row = ChatSession.get_or_none(
                ChatSession.id == session_id,
            )
            if row is None:
                raise ValueError("Chat session not found")
            provider_changed = (row.provider_id or "") != normalized_provider
            if row.engine == engine and not provider_changed:
                raise ValueError("Target engine is already active")
            if ChatMessage.select().where(
                ChatMessage.session == row,
                ChatMessage.status == "running",
            ).exists():
                raise ValueError("Chat session is running")
            source_engine = row.engine
            source_provider = row.provider_id or ""
            messages = ChatRowPersistence()._load_messages(row)
            metadata = append_handoff_log(
                project.workstep_dir,
                session_id,
                messages,
                source_engine=source_engine,
                target_engine=engine,
                mode=context_mode,
                source_provider=source_provider,
                target_provider=normalized_provider,
            )
            row.engine = engine
            row.model = model or None
            row.fast_model = fast_model or None
            row.vision_model = vision_model or None
            row.provider_id = normalized_provider or None
            if permission_mode:
                row.permission_mode = permission_mode
            row.engine_session_id = None
            row.engine_state_json = None
            row.fork_context_mode = context_mode
            row.fork_context_json = json.dumps(metadata, ensure_ascii=False)
            row.updated_at = utc_now()
            row.save()

        memory_key, _ = self._session_identity(project_id, session_id)
        session = self._sessions.get(memory_key)
        if session is not None:
            session.engine = engine
            session.model = model or None
            session.fast_model = fast_model or None
            session.vision_model = vision_model or None
            session.resolved_session_id = None
            session.engine_state = None
            session.extra["pending_handoff"] = metadata
        result = self.get_session(project_id, session_id)
        if result is None:
            raise ValueError("Chat session not found")
        return result

    async def fork_session(
        self,
        project_id: str,
        source_session_id: str,
        *,
        title: str,
        engine: str,
        context_mode: str,
        model: str | None = None,
        fast_model: str | None = None,
        vision_model: str | None = None,
        provider_id: str | None = None,
        permission_mode: str | None = None,
        fork_message_id: str | None = None,
    ) -> dict:
        """Fork one stable chat session through a native or handoff strategy."""
        title = (title or "").strip()
        if not title:
            raise ValueError("Session title cannot be empty")
        if context_mode not in {"native", "smart", "full", "none"}:
            raise ValueError(f"Unsupported fork context mode: {context_mode}")
        if any(
            state.get("session_id") == source_session_id
            and state.get("status") in {"queued", "running", "stopping"}
            for state in self._turn_states.values()
        ):
            raise ValueError("Chat session is running")
        def load_source():
            source = ChatSession.get_or_none(
                ChatSession.id == source_session_id,
            )
            if source is None:
                raise ValueError("Chat session not found")
            if ChatMessage.select().where(
                ChatMessage.session == source,
                ChatMessage.status == "running",
            ).exists():
                raise ValueError("Chat session is running")
            messages = ChatRowPersistence()._load_messages(source)
            fork_at_tail = True
            if fork_message_id:
                selected_index = next(
                    (
                        index
                        for index, item in enumerate(messages)
                        if item.get("id") == fork_message_id
                    ),
                    None,
                )
                if selected_index is None:
                    raise ValueError("Fork message not found")
                fork_at_tail = selected_index == len(messages) - 1
                messages = messages[: selected_index + 1]
            fork_point = messages[-1].get("id") if messages else None
            source_engine = source.engine
            source_engine_session_id = source.engine_session_id
            source_workflow_id = source.workflow_id
            source_model = source.model
            source_fast_model = source.fast_model
            source_vision_model = source.vision_model
            source_provider_id = source.provider_id
            source_permission_mode = source.permission_mode
            return {
                "messages": messages,
                "fork_at_tail": fork_at_tail,
                "fork_point": fork_point,
                "engine": source_engine,
                "engine_session_id": source_engine_session_id,
                "workflow_id": source_workflow_id,
                "model": source_model,
                "fast_model": source_fast_model,
                "vision_model": source_vision_model,
                "provider_id": source_provider_id,
                "permission_mode": source_permission_mode,
            }

        source_data = await self._project_manager.run_db(
            project_id, lambda _project: load_source()
        )
        messages = source_data["messages"]
        fork_at_tail = source_data["fork_at_tail"]
        fork_point = source_data["fork_point"]
        source_engine = source_data["engine"]
        source_engine_session_id = source_data["engine_session_id"]
        source_workflow_id = source_data["workflow_id"]
        source_model = source_data["model"]
        source_fast_model = source_data["fast_model"]
        source_vision_model = source_data["vision_model"]
        source_provider_id = source_data["provider_id"]
        source_permission_mode = source_data["permission_mode"]

        self._validate_engine(engine)
        effective_context_mode = context_mode
        native_engine_session_id: str | None = None
        package: dict[str, Any] | None = None
        adapter = None
        if context_mode == "native":
            if not fork_at_tail:
                raise ValueError("Native fork only supports the latest message; use smart handoff")
            if not messages and not source_engine_session_id:
                effective_context_mode = "none"
            elif engine != source_engine:
                raise ValueError("Native fork requires the same engine")
            elif (provider_id or "").strip() and (provider_id or "").strip() != (source_provider_id or "").strip():
                # 引擎会话端点与供应商绑定：换供应商时不能直接 fork 原生会话。
                raise ValueError("Native fork requires the same provider; use smart handoff")
            else:
                adapter = create_engine(engine)
                if adapter is None or not adapter.supports_session_fork:
                    raise ValueError("Selected engine does not support native session fork")
            if effective_context_mode == "native" and not source_engine_session_id:
                if messages:
                    raise ValueError("Source engine session is unavailable; use smart handoff")
                effective_context_mode = "none"
        else:
            package = compile_handoff(
                messages,
                context_mode,
                source_session_id=source_session_id,
                forked_from_message_id=fork_point,
            )

        if engine == source_engine:
            model = source_model if model is None else model
            fast_model = source_fast_model if fast_model is None else fast_model
            vision_model = source_vision_model if vision_model is None else vision_model
            provider_id = source_provider_id if provider_id is None else provider_id

        created = await self._project_manager.run_db(
            project_id,
            lambda _project: self.create_session(
                project_id,
                source_workflow_id,
                title=title,
                engine=engine,
                model=model,
                fast_model=fast_model,
                vision_model=vision_model,
                provider_id=provider_id,
                permission_mode=permission_mode or source_permission_mode,
            ),
        )
        new_session_id = created["id"]
        try:
            def persist_fork():
                with ChatSession._meta.database.atomic():
                    target = ChatSession.get_by_id(new_session_id)
                    target.parent_session_id = source_session_id
                    target.forked_from_message_id = fork_point
                    target.fork_context_mode = effective_context_mode
                    target.fork_context_json = (
                        json.dumps(package, ensure_ascii=False) if package else None
                    )
                    target.engine_session_id = None
                    target.engine_state_json = None
                    target.fork_status = (
                        "pending"
                        if effective_context_mode == "native" and source_engine_session_id
                        else "ready"
                    )
                    target.save()
                    if effective_context_mode != "none":
                        for item in messages:
                            ChatMessage.create(
                                id=str(uuid.uuid4()),
                                session=target,
                                role=item["role"],
                                content=item.get("content", ""),
                                author_id=item.get("author_id"),
                                author_name=item.get("author_name"),
                                author_device_id=item.get("author_device_id"),
                                author_device_name=item.get("author_device_name"),
                                status=item.get("status"),
                                engine=item.get("engine"),
                                model=item.get("model"),
                                created_at=_from_iso(item.get("created_at")) or utc_now(),
                                ended_at=_from_iso(item.get("ended_at")),
                            )
            await self._project_manager.run_db(
                project_id, lambda _project: persist_fork()
            )
            if effective_context_mode == "native" and source_engine_session_id:
                native_engine_session_id = await adapter.fork_session(
                    source_engine_session_id,
                    self._cwd(project_id),
                    fork_point=fork_point,
                    model=model,
                    provider_id=provider_id,
                )
                if not native_engine_session_id:
                    raise ValueError("Native session fork failed")
                def mark_ready():
                    ChatSession.update(
                        engine_session_id=native_engine_session_id,
                        fork_status="ready",
                    ).where(ChatSession.id == new_session_id).execute()
                await self._project_manager.run_db(
                    project_id, lambda _project: mark_ready()
                )
        except Exception:
            def discard_fork():
                ChatMessage.delete().where(ChatMessage.session == new_session_id).execute()
                ChatSession.delete().where(ChatSession.id == new_session_id).execute()
            await self._project_manager.run_db(
                project_id, lambda _project: discard_fork()
            )
            if native_engine_session_id and adapter is not None:
                try:
                    await adapter.close_session(
                        native_engine_session_id,
                        self._cwd(project_id),
                    )
                except Exception:
                    logger.exception("Failed to clean up native fork %s", native_engine_session_id)
            raise
        return await self._project_manager.run_db(
            project_id,
            lambda _project: self.get_session(project_id, new_session_id),
        )

    # ── turn submission ────────────────────────────────────────────────

    async def update_permission_mode(
        self,
        project_id: str,
        session_id: str,
        permission_mode: str,
    ) -> dict:
        """Persist a permission mode and apply it to the active turn immediately."""
        permission_mode = (permission_mode or "").strip()
        if permission_mode and not is_valid_permission_mode(permission_mode):
            raise ValueError(f"Unsupported permission mode: {permission_mode}")

        def ensure_session_exists() -> None:
            with self._project_ctx(project_id):
                if ChatSession.get_or_none(
                    ChatSession.id == session_id,
                ) is None:
                    raise ValueError("Chat session not found")

        await self._project_manager.run_db(
            project_id, lambda _project: ensure_session_exists()
        )
        await self.set_running_permission_mode(session_id, permission_mode)

        def persist_and_load() -> dict:
            with self._project_ctx(project_id):
                ChatSession.update(
                    permission_mode=permission_mode or None,
                ).where(
                    ChatSession.id == session_id,
                ).execute()
                return self.get_session(project_id, session_id)

        return await self._project_manager.run_db(
            project_id, lambda _project: persist_and_load()
        )

    def submit_message(
        self,
        project_id: str,
        session_id: str,
        content: str,
        idempotency_key: str,
        engine: str | None = None,
        model: str | None = None,
        fast_model: str | None = None,
        vision_model: str | None = None,
        thinking_effort: str | None = None,
        permission_mode: str | None = None,
        plan_mode: bool | None = None,
        provider_id: str | None = None,
        schedule: bool = True,
    ) -> ChatAccepted:
        if not session_id:
            raise ValueError("Chat session id is required")
        permission_mode = (permission_mode or "").strip()
        if permission_mode and not is_valid_permission_mode(permission_mode):
            raise ValueError(f"Unsupported permission mode: {permission_mode}")
        requested_engine = engine
        requested_model = model
        requested_fast_model = fast_model
        requested_vision_model = vision_model
        requested_provider_id = provider_id
        with self._project_ctx(project_id):
            row = ChatSession.get_or_none(ChatSession.id == session_id)
            if row is None:
                raise ValueError("Chat session not found")
            engine = engine or row.engine
            if requested_engine is None:
                model = row.model if model is None else model
                fast_model = row.fast_model if fast_model is None else fast_model
                vision_model = row.vision_model if vision_model is None else vision_model
                provider_id = row.provider_id if provider_id is None else provider_id
            if permission_mode:
                ChatSession.update(permission_mode=permission_mode).where(
                    ChatSession.id == session_id
                ).execute()
            if requested_provider_id is not None and engine == (row.engine or ""):
                # 同引擎换供应商：显式传入的 provider 与会话绑定时，旧的引擎
                # 会话属于另一个端点，必须丢弃（UI 走交接对话框；API 直连退化为
                # 新会话，上下文由历史重发兜底）。
                switched_provider = validate_provider_override(
                    requested_provider_id,
                    engine,
                )
                if (row.provider_id or "") != switched_provider:
                    ChatSession.update(
                        provider_id=switched_provider or None,
                        engine_session_id=None,
                        engine_state_json=None,
                    ).where(ChatSession.id == session_id).execute()
                    memory_session = self._sessions.get(
                        self._session_identity(project_id, session_id)[0]
                    )
                    if memory_session is not None:
                        memory_session.resolved_session_id = None
                        memory_session.engine_state = None
        memory_key, resolved_sid = self._session_identity(project_id, session_id)
        accepted = super().submit_message(
            project_id,
            content,
            idempotency_key,
            session_id=resolved_sid,
            memory_key=memory_key,
            scope_key=session_id,
            idempotency_sid=session_id,
            engine=engine,
            model=model,
            fast_model=fast_model,
            vision_model=vision_model,
            thinking_effort=thinking_effort,
            permission_mode=permission_mode or None,
            plan_mode=plan_mode,
            provider_id=provider_id,
            schedule=schedule,
        )
        if requested_engine is not None:
            normalized_provider = validate_provider_override(
                requested_provider_id,
                engine,
            )
            with self._project_ctx(project_id):
                ChatSession.update(
                    engine=engine,
                    model=(requested_model or "").strip() or None,
                    fast_model=(requested_fast_model or "").strip() or None,
                    vision_model=(requested_vision_model or "").strip() or None,
                    provider_id=normalized_provider or None,
                ).where(ChatSession.id == session_id).execute()
        return ChatAccepted(
            session_id=accepted.session_id,
            turn_id=accepted.turn_id,
            status=accepted.status,
        )

    @staticmethod
    def _session_identity(
        project_id: str,
        session_id: str,
    ) -> tuple[tuple, str]:
        """Map one chat session row to (memory key, canonical sid)."""
        return ("chat", project_id, session_id), session_id

    # ── per-project system prompt ─────────────────────────────────────

    def _build_prompt(self, session) -> str:
        """Use the project-configured system prompt ("" when unset, no default)."""
        prompt = self.get_system_prompt(session.project_id)
        pending_handoff = session.extra.get("pending_handoff")
        if isinstance(pending_handoff, dict):
            project = self._project_manager.get_project_by_id(session.project_id)
            if project is None:
                raise ValueError(f"Project not found: {session.project_id}")
            user_message = next(
                (
                    str(item.get("content") or "")
                    for item in reversed(session.messages)
                    if item.get("role") == "user"
                ),
                "",
            )
            handoff_prompt = (
                render_handoff_reference(pending_handoff, project.workstep_dir)
                if pending_handoff.get("relative_path")
                else render_handoff(pending_handoff)
            )
            return "\n\n".join(
                part
                for part in (prompt, handoff_prompt, f"Current request:\n{user_message}")
                if part
            )
        engine = create_engine(session.engine)
        if engine is not None and engine.supports_resume:
            user_message = next(
                (
                    str(item.get("content") or "")
                    for item in reversed(session.messages)
                    if item.get("role") == "user"
                ),
                "",
            )
            if session.resolved_session_id or not prompt:
                return user_message
            return f"{prompt}\n\n{user_message}"
        turns = [
            item for item in session.messages
            if not (item.get("role") == "assistant" and item.get("status") == "running")
        ][-self._config.max_history_turns * 2:]
        history = "\n\n".join(
            f"{'User' if item['role'] == 'user' else 'Assistant'}: {item['content']}"
            for item in turns
        )
        tail = f"Conversation history:\n{history}\n\nContinue."
        return f"{prompt}\n\n{tail}" if prompt else tail

    def _build_rebuild_prompt(self, session) -> str:
        """Rebuild a lost engine thread from the persisted conversation."""
        prompt = self._build_prompt(session)
        if session.resolved_session_id:
            turns = [
                item for item in session.messages
                if not (
                    item.get("role") == "assistant"
                    and item.get("status") == "running"
                )
            ][-self._config.max_history_turns * 2:]
            history = "\n\n".join(
                f"{'User' if item['role'] == 'user' else 'Assistant'}: {item['content']}"
                for item in turns
            )
            tail = f"Conversation history:\n{history}\n\nContinue."
            prompt = (
                f"{self.get_system_prompt(session.project_id)}\n\n{tail}"
                if self.get_system_prompt(session.project_id)
                else tail
            )
        return prompt

    def _system_prompt_for_display(self, session) -> str:
        """Show the project-specific instruction, including on resumed turns."""
        return self.get_system_prompt(session.project_id)

    async def _on_engine_session_started(self, session) -> None:
        metadata = session.extra.get("pending_handoff")
        if not isinstance(metadata, dict) or not metadata.get("relative_path"):
            return

        def consume(project):
            row = ChatSession.get_or_none(ChatSession.id == session.session_id)
            if row is None:
                return
            stored = _load_json(row.fork_context_json, None)
            if not isinstance(stored, dict):
                return
            if stored.get("handoff_id") != metadata.get("handoff_id"):
                return
            mark_handoff_consumed(project.workstep_dir, metadata)
            row.fork_context_json = None
            row.updated_at = utc_now()
            row.save()

        await self._project_manager.run_db(session.project_id, consume)
        session.extra.pop("pending_handoff", None)

    def get_system_prompt(self, project_id: str) -> str:
        """Return the project's configured chat prompt ("" if unset or cleared).

        No built-in default is substituted: an empty prompt means the chat
        assistant runs without a system prompt.
        """
        with self._project_ctx(project_id):
            row = ProjectSetting.get_or_none(
                ProjectSetting.project_id == project_id,
                ProjectSetting.key == SYSTEM_PROMPT_KEY,
            )
        if row is None:
            return ""
        prompt = _load_json(row.value_json, "")
        return prompt if isinstance(prompt, str) else ""

    def set_system_prompt(self, project_id: str, prompt: str) -> str:
        """Persist the project's chat prompt; empty input clears the custom prompt."""
        prompt = (prompt or "").strip()
        now = utc_now()
        with self._project_ctx(project_id):
            row = ProjectSetting.get_or_none(
                ProjectSetting.project_id == project_id,
                ProjectSetting.key == SYSTEM_PROMPT_KEY,
            )
            if not prompt:
                if row is not None:
                    row.delete_instance()
                return ""
            if len(prompt) > MAX_SYSTEM_PROMPT_LENGTH:
                raise ValueError(
                    f"系统提示词不能超过 {MAX_SYSTEM_PROMPT_LENGTH} 字"
                )
            payload = json.dumps(prompt, ensure_ascii=False)
            if row is None:
                ProjectSetting.create(
                    id=str(uuid.uuid4()),
                    project_id=project_id,
                    key=SYSTEM_PROMPT_KEY,
                    value_json=payload,
                    updated_at=now,
                )
            else:
                row.value_json = payload
                row.updated_at = now
                row.save()
        return prompt

    async def enhance_prompt(self, project_id: str, prompt: str) -> str:
        """Rewrite a draft prompt via the configured enhance provider (direct chat/completions).

        未配置提示词增强供应商时回退 Pydantic AI 一次性调用；仍未配置时回退
        协调引擎（fast model + minimal 强度 + 自动批准）。
        """
        prompt = (prompt or "").strip()
        if not prompt:
            raise ValueError("提示词不能为空")
        if len(prompt) > ENHANCE_MAX_LENGTH:
            raise ValueError(f"提示词不能超过 {ENHANCE_MAX_LENGTH} 字")
        enhance_config = await asyncio.to_thread(
            config_store.get_prompt_enhance_config
        )
        if enhance_config["provider_id"] and enhance_config["model"]:
            from services import providers as provider_service

            provider = await asyncio.to_thread(
                config_store.get_provider, enhance_config["provider_id"]
            )
            if provider is None:
                raise ValueError("提示词增强的供应商不存在，请在设置中重新配置")
            raw = await provider_service.chat_completion(
                provider,
                enhance_config["model"],
                [
                    {"role": "system", "content": ENHANCE_SYSTEM_PROMPT},
                    {"role": "user", "content": prompt},
                ],
                thinking="disabled",
            )
            result = raw.strip()
            if not result:
                raise ValueError("提示词增强失败，请重试")
            return result
        enhance_input = f"{ENHANCE_SYSTEM_PROMPT}\n\n用户提示词：\n{prompt}"
        try:
            from engines.pydantic_ai import PydanticAIEngine

            raw = await PydanticAIEngine.run_simple(enhance_input)
        except RuntimeError:
            from agent_assistants.base import invoke_engine

            engine_id, _model, fast_model = self._resolve_engine_models()
            with self._project_ctx(project_id) as project:
                cwd = str(project.path)
            raw, _events, _session_id = await invoke_engine(
                engine_id,
                fast_model,
                cwd,
                enhance_input,
                None,
                None,
                error_prefix="Enhance engine",
                thinking_effort="minimal",
                permission_mode="auto",
            )
        result = raw.strip()
        if not result:
            raise ValueError("提示词增强失败，请重试")
        return result

    # ── engine / model resolution ──────────────────────────────────────

    @staticmethod
    def _fallback_engine(default_engine_id: str) -> tuple[str, object | None]:
        candidates = [default_engine_id] + [
            key for key in COORDINATOR_FALLBACK_ORDER if key != default_engine_id
        ]
        for candidate in candidates:
            engine = create_engine(candidate)
            if engine is not None and engine.capabilities.supports_coordinator:
                return candidate, engine
        return default_engine_id, None

    def _resolve_engine_models(self) -> tuple[str, str | None, str | None]:
        defaults = config_store.get_assistant_defaults(self._config.name)
        configured_id = defaults["engine"] or "claude"
        if (
            configured_id == "pydantic_ai"
            and (defaults.get("provider_id") or "").strip()
        ):
            if create_engine("pydantic_ai") is None:
                raise ValueError("内置引擎不可用")
            model = (
                defaults["model"]
                or config_store.get_engine_default_model("pydantic_ai")
                or None
            )
            return "pydantic_ai", model, defaults["fast_model"] or model
        engine_id, engine = self._fallback_engine(configured_id)
        if engine is None:
            raise ValueError(f"Chat engine is unavailable: {engine_id}")
        if engine_id == configured_id:
            model = (
                defaults["model"]
                or config_store.get_engine_default_model(engine_id)
                or None
            )
            fast_model = defaults["fast_model"] or model
        else:
            model = config_store.get_engine_default_model(engine_id) or None
            fast_model = model
        return engine_id, model, fast_model

    def _validate_engine(self, engine_id: str) -> None:
        candidate = create_engine(engine_id)
        if candidate is None or not (
            candidate.capabilities.supports_coordinator
            or engine_id == "pydantic_ai"
        ):
            raise ValueError(f"Chat engine is unavailable: {engine_id}")

    # ── per-project quick buttons ──────────────────────────────────────

    def get_quick_buttons(self, project_id: str) -> list[dict]:
        with self._project_ctx(project_id):
            row = ProjectSetting.get_or_none(
                ProjectSetting.project_id == project_id,
                ProjectSetting.key == QUICK_BUTTONS_KEY,
            )
            if row is None:
                return [dict(item) for item in DEFAULT_QUICK_BUTTONS]
            buttons = _load_json(row.value_json, None)
            if not isinstance(buttons, list):
                return [dict(item) for item in DEFAULT_QUICK_BUTTONS]
            return [
                dict(item)
                for item in buttons
                if isinstance(item, dict)
                and item.get("label")
                and item.get("prompt")
            ]

    def set_quick_buttons(self, project_id: str, buttons: list) -> list[dict]:
        if not isinstance(buttons, list) or len(buttons) > MAX_QUICK_BUTTONS:
            raise ValueError(f"最多配置 {MAX_QUICK_BUTTONS} 个快捷按钮")
        cleaned: list[dict] = []
        seen: set[str] = set()
        for item in buttons:
            if not isinstance(item, dict):
                raise ValueError("快捷按钮格式无效")
            label = str(item.get("label") or "").strip()
            prompt = str(item.get("prompt") or "").strip()
            if not label:
                raise ValueError("快捷按钮标签不能为空")
            if len(label) > MAX_QUICK_BUTTON_LABEL:
                raise ValueError(f"快捷按钮标签不能超过 {MAX_QUICK_BUTTON_LABEL} 字")
            if not prompt:
                raise ValueError("快捷按钮提示词不能为空")
            if len(prompt) > MAX_QUICK_BUTTON_PROMPT:
                raise ValueError(f"快捷按钮提示词不能超过 {MAX_QUICK_BUTTON_PROMPT} 字")
            button_id = str(item.get("id") or str(uuid.uuid4()))
            if button_id in seen:
                raise ValueError("快捷按钮 id 重复")
            seen.add(button_id)
            cleaned.append({"id": button_id, "label": label, "prompt": prompt})
        now = utc_now()
        with self._project_ctx(project_id):
            row = ProjectSetting.get_or_none(
                ProjectSetting.project_id == project_id,
                ProjectSetting.key == QUICK_BUTTONS_KEY,
            )
            payload = json.dumps(cleaned, ensure_ascii=False)
            if row is None:
                ProjectSetting.create(
                    id=str(uuid.uuid4()),
                    project_id=project_id,
                    key=QUICK_BUTTONS_KEY,
                    value_json=payload,
                    updated_at=now,
                )
            else:
                row.value_json = payload
                row.updated_at = now
                row.save()
        return cleaned
