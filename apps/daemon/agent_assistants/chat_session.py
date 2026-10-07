"""Codex-style session chat assistant (per project, multiple sessions).

One assistant registered in the shared assistant layer
(``agent_assistants/base.py``): it only declares an ``AssistantConfig``
plus ``chat_row_persistence.py``, which stores conversation rows in
``chat_sessions`` / ``chat_messages``. Shared turn lifecycle, idempotency,
engine invocation with resume and streaming events live in ``AssistantRuntime``.
Engine handoff and session forks live in ``chat_session_transitions.py``.

Each project can hold many independent sessions. Sessions are created
explicitly (``create_session``), auto-titled from the first user message,
and can be renamed or deleted. Quick-action buttons above the composer are
configured per project via the ``project_settings`` table.
"""

import asyncio
import json
import logging
import peewee as pw
import uuid
from dataclasses import dataclass
from typing import Any

from engines.codex_visualize import (
    CODEX_ENGINE_IDS,
    convert_event_visualize_markers,
    convert_visualize_markers,
)
from engines.core.registry import COORDINATOR_FALLBACK_ORDER, create_engine
from models.chat_session import ChatMessage, ChatSession, ProjectSetting
from models.fields import utc_now
from agent_assistants.base import (
    AssistantConfig,
    AssistantRuntime,
    SCOPE_CHAT,
    assistant_registry,
    validate_provider_override,
)
from agent_assistants.history import default_history_message
from agent_assistants.event_journal import TurnEventJournal
from agent_assistants.chat_row_persistence import (
    ChatRowPersistence,
    _iso,
    _load_json,
    _preview,
)
from agent_assistants.event_replay import _detail_agui_events
from agent_assistants.event_truncation import truncate_large_tool_payloads
from agent_assistants.context_handoff import (
    mark_handoff_consumed,
    render_handoff,
    render_handoff_reference,
)
from agent_assistants.chat_session_transitions import ChatSessionTransitions
from services.chat_permissions import is_valid_permission_mode
from services.channels.session_source import channel_session_source
from services.config import config_store, resolve_execution_engine

logger = logging.getLogger(__name__)

CHAT_CHANNEL = "session_chat"

MAX_HISTORY_TURNS = 8
MAX_SESSIONS = 200
SESSION_TTL_SECONDS = 60 * 60

QUICK_BUTTONS_KEY = "chat_quick_buttons"
SYSTEM_PROMPT_KEY = "chat_system_prompt"
MAX_SYSTEM_PROMPT_LENGTH = 20000
MAX_QUICK_BUTTONS = 20
MAX_QUICK_BUTTON_LABEL = 1000
MAX_QUICK_BUTTON_PROMPT = 400
PREVIEW_LENGTH = 60
ENHANCE_MAX_LENGTH = 4000

ENHANCE_SYSTEM_PROMPT = (
    "You rewrite prompts to be clear, specific, and directly executable. "
    "Preserve intent; clarify goals, constraints, context, output format, and tone. "
    "Output only the rewritten prompt."
)

SYSTEM_PROMPT = """You are the WorkStep chat assistant. Work in the project root and help with programming and research: answer questions, explain code and project structure, propose solutions, design tests, review code, and debug.

Keep multi-turn context. Ask one brief question when information is missing. Be concise and actionable. Use Markdown code blocks for code. Reply in the user's language."""


@dataclass(frozen=True, slots=True)
class ChatAccepted:
    session_id: str
    turn_id: str
    assistant_message_id: str
    status: str

    def to_dict(self) -> dict:
        return {
            "session_id": self.session_id,
            "turn_id": self.turn_id,
            "assistant_message_id": self.assistant_message_id,
            "status": self.status,
        }


DEFAULT_QUICK_BUTTONS = [
    {"id": "generate", "label": "生成实现", "prompt": "请根据当前项目目标，给出完整的实现方案与关键代码（只输出方案，不创建文件）。"},
    {"id": "explain", "label": "解释代码", "prompt": "请解释当前项目中最相关的一段代码或模块结构，说明职责、调用关系与关键实现细节。"},
    {"id": "test", "label": "设计测试", "prompt": "请为当前项目设计单元测试：列出测试文件、关键用例与断言思路（只输出设计，不创建文件）。"},
    {"id": "review", "label": "代码评审", "prompt": "请评审当前项目的代码质量、潜在缺陷与改进建议，按优先级列出。"},
]


class ChatSessionModule(ChatSessionTransitions, AssistantRuntime):
    """The Codex-style session chat assistant and session operations."""

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
                            content = convert_visualize_markers(
                                snapshot["content"] or content
                            )
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

    async def stop_current(self, session_id: str, project_id: str | None = None, *, expected_message_id: str | None = None) -> bool:
        cutoff = utc_now()
        accepted = await super().stop_current(session_id, project_id=project_id, expected_message_id=expected_message_id)
        if expected_message_id is not None:
            return accepted
        if any(
            state.get("session_id") == session_id and self._turn_is_active(turn_id)
            for turn_id, state in self._turn_states.items()
        ):
            return accepted
        projects = (
            [self._project_manager.get_project_by_id(project_id)]
            if project_id is not None
            else list(self._project_manager.iter_projects())
        )
        for project in projects:
            if project is None:
                continue
            found, messages = await self._project_manager.run_db(
                project.id,
                lambda current: self._stop_orphaned_messages(current, session_id, cutoff),
            )
            if not found:
                continue
            for message in messages:
                for event in _detail_agui_events(
                    [{"type": "message_completed", "data": message, "seq": message["seq"]}],
                    project_id=project.id,
                    session_id=session_id,
                    message_id=message["id"],
                    engine=message["engine"],
                ):
                    await self._event_bus.publish(event)
            return True
        return accepted

    def _stop_orphaned_messages(self, project, session_id: str, cutoff) -> tuple[bool, list[dict]]:
        """Reconcile dead turns in the project DB worker, preserving journal output."""
        if not ChatSession.select().where(ChatSession.id == session_id).exists():
            return False, []
        now = utc_now()
        messages = []
        for row in ChatMessage.select().where(
            ChatMessage.session == session_id,
            ChatMessage.role == "assistant",
            ChatMessage.status == "running",
            ChatMessage.created_at <= cutoff,
        ):
            if row.event_log_path:
                ref = self._event_journal.reopen(project.workstep_dir, row.event_log_path)
                self._event_journal.record(ref, {"type": "status", "data": {"status": "stopped"}})
                snapshot = self._event_journal.snapshot(ref)
                self._event_journal.finish(ref)
                row.content = convert_visualize_markers(snapshot["content"] or row.content or "")
                row.events_json = json.dumps(snapshot["events"], ensure_ascii=False)
                row.event_summary_json = json.dumps(snapshot["summary"], ensure_ascii=False)
                row.event_count = snapshot["summary"].get("event_count", row.event_count)
                row.last_event_seq = snapshot["summary"].get("last_event_seq", row.last_event_seq)
            row.status = "stopped"
            row.ended_at = now
            row.save()
            messages.append({
                "id": row.id, "engine": row.engine, "status": "stopped",
                "content": row.content or "", "ended_at": now.isoformat(),
                "seq": (row.last_event_seq or 0) + 1,
            })
        if messages:
            ChatSession.update(updated_at=now).where(ChatSession.id == session_id).execute()
        return True, messages

    def list_sessions(self, project_id: str, workflow_id: str | None = None, archived: bool = False) -> list[dict]:
        """The active project database owns sessions, including historical registry IDs."""
        if not project_id:
            raise ValueError("project_id is required")
        with self._project_ctx(project_id):
            rows = (
                ChatSession.select()
                .where(
                    ChatSession.fork_status == "ready",
                    ChatSession.archived == archived,
                )
                .order_by(ChatSession.sort_order, ChatSession.updated_at.desc())
            )
            return [self._session_summary(row, project_id) for row in rows]

    def set_archived(self, project_id: str, session_id: str, archived: bool) -> dict:
        if archived and any(
            state.get("session_id") == session_id
            and state.get("status") in {"queued", "running", "stopping"}
            for state in self._turn_states.values()
        ):
            raise ValueError("Chat session is running")
        with self._project_ctx(project_id):
            row = ChatSession.get_or_none(ChatSession.id == session_id)
            if row is None:
                raise ValueError("Chat session not found")
            if archived and ChatMessage.select().where(
                ChatMessage.session == row, ChatMessage.status == "running"
            ).exists():
                raise ValueError("Chat session is running")
            row.archived = archived
            row.save()
            return self._session_summary(row, project_id)

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

    def get_session(self, project_id: str, session_id: str, *, limit: int | None = None, offset: int = 0) -> dict | None:
        with self._project_ctx(project_id):
            row = ChatSession.get_or_none(ChatSession.id == session_id)
            if row is None:
                return None
            summary = self._session_summary(row, project_id)
        if limit is None:
            history = self.history(project_id, session_id) or {}
        else:
            with self._project_ctx(project_id):
                normalize = self._config.history_message or default_history_message
                history = {"messages": [normalize(item) for item in self._config.persistence._load_messages(
                    row, limit=limit, offset=offset,
                )]}
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
                message["content"] = convert_visualize_markers(
                    snapshot["content"] or ""
                )
                snapshot_events = snapshot["events"]
                if message.get("engine") in CODEX_ENGINE_IDS:
                    snapshot_events = [
                        convert_event_visualize_markers(event)
                        for event in snapshot_events
                    ]
                message["events"] = [
                    truncate_large_tool_payloads(event)
                    for event in snapshot_events
                ]
                message["event_summary"] = snapshot["summary"]
                message["event_detail"] = {
                    "available": True,
                    "loaded": False,
                    **snapshot["summary"],
                }
            except Exception:
                logger.exception("Failed to restore running chat snapshot")
        messages = history.get("messages", [])
        if self._config.name in {"chat_session", "channel_chat"}:
            with self._project_ctx(project_id):
                self._attach_prompt_views(summary, messages)
        return {**summary, "messages": messages}

    def _attach_prompt_views(self, summary: dict, messages: list[dict]) -> None:
        """Prefer live captured input, retaining the stored snapshot after restart."""
        runtime = self
        if self._config.name == "chat_session" and summary.get("source") == "channel":
            from main import channel_chat_module

            if channel_chat_module is not None:
                runtime = channel_chat_module
        captured = {}
        for session in list(runtime._sessions.values()):
            if session.project_id != summary["project_id"] or session.session_id != summary["id"]:
                continue
            captured = {str(item.get("id")): item.get("prompt") for item in list(session.messages)}
            break
        for message in messages:
            # Never substitute the latest config for an unknown past request.
            prompt = captured.get(str(message.get("id")))
            if prompt:
                message["prompt"] = prompt

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
                    engine=row.engine,
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
            engine=row.engine,
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
            **channel_session_source(row.id, row.title),
            "archived": bool(row.archived),
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


    # ── turn submission ────────────────────────────────────────────────

    async def update_permission_mode(
        self,
        project_id: str,
        session_id: str,
        permission_mode: str,
    ) -> dict:
        """Persist a permission mode, then best-effort apply it to the active turn."""
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

        def persist_and_load() -> dict:
            with self._project_ctx(project_id):
                ChatSession.update(
                    permission_mode=permission_mode or None,
                ).where(
                    ChatSession.id == session_id,
                ).execute()
                return self.get_session(project_id, session_id)

        result = await self._project_manager.run_db(
            project_id, lambda _project: persist_and_load()
        )
        # 先落库保证用户设置一定保存成功；热切换失败（例如 CLI 拒绝运行中
        # 切换到 bypassPermissions）不能让请求 500，新模式下一轮生效。
        try:
            await self.set_running_permission_mode(session_id, permission_mode)
        except Exception:
            logger.warning(
                "权限模式 %r 落库成功，但应用到运行中会话 %s 失败（下一轮生效）",
                permission_mode,
                session_id,
                exc_info=True,
            )
        return result

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
        goal_mode: bool | None = None,
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
            self._restore_handoff_endpoint(
                project_id, row, engine,
                ((row.provider_id if provider_id is None else provider_id) or "").strip(),
            )
            if content.strip() == "/compact" and (
                not row.engine_session_id
                or engine != row.engine
                or (
                    requested_provider_id is not None
                    and requested_provider_id != (row.provider_id or "")
                )
            ):
                raise ValueError("没有可压缩的当前引擎会话")
            # 请求省略的字段一律沿用会话已存值：前端每条消息都带 engine
            # （空才省略），不能再用「请求没带 engine」作为是否继承的判断，
            # 否则第二条起会话绑定的供应商/模型丢失、回落引擎默认，
            # 且回写还会把绑定抹掉。
            engine_switched = (
                requested_engine is not None
                and requested_engine != (row.engine or "")
            )
            # 模型是引擎特有的：显式换引擎时不继承旧引擎的模型（回引擎默认）；
            # 供应商跨引擎可继承，前提是协议兼容。
            model = row.model if model is None and not engine_switched else model
            fast_model = (
                row.fast_model
                if fast_model is None and not engine_switched
                else fast_model
            )
            vision_model = (
                row.vision_model
                if vision_model is None and not engine_switched
                else vision_model
            )
            provider_id = row.provider_id if provider_id is None else provider_id
            if provider_id and engine_switched and requested_provider_id is None:
                # 从旧引擎继承的供应商与新引擎协议不兼容（或已删除）：
                # 本轮按「跟随引擎默认」执行，并在成功后的回写中清掉绑定
                # （与 UI chooseEngine 重置语义一致）。
                stored_provider = config_store.get_provider(provider_id)
                target_engine = create_engine(engine)
                if stored_provider is None or (
                    target_engine is None
                    or not target_engine.supports_provider(stored_provider)
                ):
                    provider_id = None
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
            goal_mode=goal_mode,
            provider_id=provider_id,
            schedule=schedule,
        )
        # 字段回写独立于 engine 是否在请求中出现；省略的字段不覆盖已有值。
        # 换引擎时同时保存上面解析出的兼容配置，避免遗留旧引擎的模型/供应商。
        updates: dict[str, Any] = {}
        if requested_engine is not None:
            updates["engine"] = engine
        for field, requested, effective in (
            ("model", requested_model, model),
            ("fast_model", requested_fast_model, fast_model),
            ("vision_model", requested_vision_model, vision_model),
        ):
            if requested is not None or engine_switched:
                updates[field] = (effective or "").strip() or None
        if requested_provider_id is not None or engine_switched:
            updates["provider_id"] = validate_provider_override(provider_id, engine) or None
        if updates:
            with self._project_ctx(project_id):
                ChatSession.update(**updates).where(
                    ChatSession.id == session_id
                ).execute()
        return ChatAccepted(
            session_id=accepted.session_id,
            turn_id=accepted.turn_id,
            assistant_message_id=accepted.assistant_message_id,
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

    def _prompt_system_instruction(self, session) -> str:
        if self._config.name == "chat_session" or self._config.system_prompt_transport:
            return ""
        return self.get_system_prompt(session.project_id)

    def _engine_system_prompt(self, session) -> str:
        if self._config.name != "chat_session":
            return super()._engine_system_prompt(session)
        return self.get_system_prompt(session.project_id)

    def _capture_prompt_input(self) -> bool:
        return self._config.name in {"chat_session", "channel_chat"} or super()._capture_prompt_input()

    def _display_prompt(self, session, prompt: str, system_prompt: str | None = None) -> str:
        if self._config.name not in {"chat_session", "channel_chat"}:
            return super()._display_prompt(session, prompt, system_prompt)
        # No preview assembled from config: wait for actual prepared inputs.
        return ""

    def _build_prompt(self, session) -> str:
        """Build user/context input; configured chat rules travel independently."""
        prompt = self._prompt_system_instruction(session)
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
                f"{self._prompt_system_instruction(session)}\n\n{tail}"
                if self._prompt_system_instruction(session)
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
        """Rewrite a draft through the configured provider protocol.

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
            from services.gateway_client.usage import snapshot_usage_provider
            from main import gateway_client

            provider = await asyncio.to_thread(
                config_store.get_provider, enhance_config["provider_id"]
            )
            if provider is None:
                raise ValueError("提示词增强的供应商不存在，请在设置中重新配置")
            provider_snapshot = snapshot_usage_provider(provider)
            usage: dict = {}
            raw = await provider_service.text_completion(
                provider,
                enhance_config["model"],
                [
                    {"role": "system", "content": ENHANCE_SYSTEM_PROMPT},
                    {"role": "user", "content": prompt},
                ],
                thinking="disabled",
                protocol=enhance_config.get("protocol") or None,
                usage_collector=usage,
            )
            result = raw.strip()
            if not result:
                raise ValueError("提示词增强失败，请重试")
            await gateway_client.record_one_shot_usage(
                project_id=project_id, model=enhance_config["model"],
                provider=provider_snapshot, usage=usage or None,
            )
            return result
        enhance_input = f"{ENHANCE_SYSTEM_PROMPT}\n\n用户提示词：\n{prompt}"
        usage_details: dict = {}
        try:
            from engines.pydantic_ai import PydanticAIEngine

            raw = await PydanticAIEngine.run_simple(
                enhance_input, usage_details=usage_details,
            )
        except RuntimeError:
            from agent_assistants.base import invoke_engine
            from services.messages import extract_usage_json

            engine_id, _model, fast_model = self._resolve_engine_models()
            with self._project_ctx(project_id) as project:
                cwd = str(project.path)
            _, provider_snapshot = await self._usage_provider_snapshot(engine_id, "")
            raw, events, _session_id = await invoke_engine(
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
            usage_json = extract_usage_json(events)
            usage_details = {
                "provider": provider_snapshot,
                "model": fast_model or "",
                "usage": json.loads(usage_json) if usage_json else None,
            }
        result = raw.strip()
        if not result:
            raise ValueError("提示词增强失败，请重试")
        from main import gateway_client

        await gateway_client.record_one_shot_usage(
            project_id=project_id, model=usage_details.get("model") or "",
            provider=usage_details.get("provider"),
            usage=usage_details.get("usage"),
        )
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
        configured_id = defaults["engine"] or resolve_execution_engine(None)
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
                and isinstance(item.get("prompt"), str)
            ]

    def set_quick_buttons(self, project_id: str, buttons: list) -> list[dict]:
        from services.quick_buttons import normalize_quick_buttons

        cleaned = normalize_quick_buttons(buttons, max_buttons=MAX_QUICK_BUTTONS)
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
