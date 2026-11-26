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
import hashlib
import json
import logging
import peewee as pw
import uuid
from dataclasses import dataclass
from datetime import timezone
from typing import Any

from engines.codex_visualize import (
    CODEX_ENGINE_IDS,
    convert_event_visualize_markers,
    convert_visualize_markers,
)
from engines.core.registry import COORDINATOR_FALLBACK_ORDER, create_engine
from models.base import db_proxy
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
    _from_iso,
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
from agent_assistants.session_state import PROVIDER_HANDOFF_REQUIRED
from agent_assistants.chat_session_transitions import ChatSessionTransitions
from agent_assistants.chat_roles import ChatRoleBindings
from services.chat_permissions import is_valid_permission_mode, validate_permission_selection
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


class ChatSessionModule(ChatRoleBindings, ChatSessionTransitions, AssistantRuntime):
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
        self._restart_candidates = []
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
                        (ChatMessage.status == "running") | ChatMessage.restart_pending,
                    ))
                    for row in rows:
                        session_row = ChatSession.get_by_id(row.session_id)
                        latest = ChatMessage.select().where(
                            ChatMessage.session == row.session_id,
                        ).order_by(ChatMessage.created_at.desc()).first()
                        if (row.status in {"running", "stopped"} and not session_row.archived
                                and latest is not None and latest.id == row.id):
                            self._restart_candidates.append((project.id, row.session_id, row.id))
                        row.restart_pending = False
                        if row.status not in {"running", "stopped"}:
                            row.save()
                            continue
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

    async def shutdown(self) -> None:
        # Persist the cause before cancellation changes running messages to stopped.
        by_project: dict[str, list[str]] = {}
        for state in self._turn_states.values():
            if (state.get("status") in {"queued", "running"}
                    and state.get("project_id") and state.get("assistant_message_id")):
                by_project.setdefault(state["project_id"], []).append(state["assistant_message_id"])
        for project_id, message_ids in by_project.items():
            try:
                await self._project_manager.run_db(project_id, lambda _p, ids=message_ids: (
                    ChatMessage.update(restart_pending=True).where(ChatMessage.id.in_(ids)).execute()
                ))
            except Exception:
                logger.exception("Failed to mark interrupted chats in project %s", project_id)
        await super().shutdown()

    async def resume_interrupted_chats(self) -> int:
        candidates = getattr(self, "_restart_candidates", [])
        self._restart_candidates = []
        if not await asyncio.to_thread(config_store.get, "auto_resume_interrupted_chats", False):
            return 0
        resumed = 0
        for project_id, session_id, message_id in candidates:
            def submit(_project):
                session = ChatSession.get_or_none(ChatSession.id == session_id)
                if session is None or session.archived:
                    return None
                latest = ChatMessage.select().where(ChatMessage.session == session_id).order_by(
                    ChatMessage.created_at.desc()
                ).first()
                if latest is None or latest.id != message_id or latest.status != "stopped":
                    return None
                trigger=ChatMessage.select().where(ChatMessage.session==session_id,
                    ChatMessage.role!='assistant').order_by(ChatMessage.created_at.desc()).first()
                if trigger is not None and trigger.author_type=='internal':
                    # The event owner retries its pending work; never invent a
                    # user continuation for an interrupted background event.
                    return None
                config = self.get_execution_config(project_id, session_id)
                return self.submit_message(
                    project_id, session_id, "Continue", f"restart-resume:{message_id}",
                    **{key: config[key] for key in ("engine", "model", "fast_model", "vision_model",
                                                   "provider_id", "thinking_effort", "service_tier")},
                    schedule=False,
                )
            try:
                accepted = await self._project_manager.run_db(project_id, submit)
                if accepted is not None:
                    self.start_queued_turn(accepted.turn_id)
                    resumed += 1
            except Exception:
                logger.exception("Failed to resume interrupted chat %s in project %s", session_id, project_id)
        return resumed

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
                .order_by(*(
                    (pw.fn.COALESCE(ChatSession.archived_at, ChatSession.updated_at).desc(), ChatSession.id)
                    if archived else (ChatSession.sort_order, ChatSession.updated_at.desc())
                ))
            )
            return [self._session_summary(row, project_id) for row in rows]

    def set_archived(
        self, project_id: str, session_id: str, archived: bool, *, ordinary_only: bool = False,
    ) -> dict:
        with self._project_ctx(project_id):
            row = ChatSession.get_or_none(ChatSession.id == session_id)
            if row is None or (ordinary_only and row.project_id != project_id):
                raise ValueError("Chat session not found")
            if archived and self._digital_person_session_kind(project_id, session_id) in {'main', 'reflection'}:
                raise ValueError('Digital hub system conversations cannot be archived or deleted')
            if archived:
                active = ("queued", "running", "stopping")
                if any(
                    state.get("session_id") == session_id and state.get("status") in active
                    for state in self._turn_states.copy().values()
                ) or ChatMessage.select().where(
                    ChatMessage.session == row, ChatMessage.status.in_(active),
                ).exists():
                    raise ValueError("Chat session is running")
            if ordinary_only and channel_session_source(row.id)["source"] != "chat":
                raise ValueError("The target must be an ordinary project conversation")
            from services.session_schedule_runtime import clear_session_schedules
            with db_proxy.atomic():
                if archived and not row.archived:
                    row.archived_at = utc_now()
                elif not archived:
                    row.archived_at = None
                row.archived = archived
                row.save()
                if archived:
                    clear_session_schedules(session_id)
                summary = self._session_summary(row, project_id)
                if (
                    archived
                    and summary["message_count"] == 0
                    and summary.get("source") != "channel"
                    and not row.parent_session_id
                ):
                    self.delete_session(project_id, session_id)
                    summary.update(archived=False, archived_at=None, deleted=True)
            return summary

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
        *,
        defaults_name: str | None = None,
    ) -> dict:
        if not project_id:
            raise ValueError("project_id is required")
        permission_mode = (permission_mode or "").strip()
        if permission_mode and not is_valid_permission_mode(permission_mode):
            raise ValueError(f"Unsupported permission mode: {permission_mode}")
        name = defaults_name or self._execution_settings_name(project_id)
        engine_id, default_model, default_fast_model = (
            self._resolve_named_engine_models(name) if defaults_name
            else self._resolve_project_engine_models(project_id)
        )
        defaults = config_store.get_assistant_defaults(name)
        default_vision_model = defaults.get("vision_model", "") or None
        if engine:
            self._validate_engine(engine)
            if engine != engine_id:
                default_model = (
                    config_store.get_engine_default_model(engine) or None
                )
                default_fast_model = default_model
                default_vision_model = None
            engine_id = engine
        if provider_id is None:
            if engine_id == (defaults.get("engine") or engine_id):
                provider_id = config_store.get_assistant_config(name).get("provider_id", "")
        validate_permission_selection(engine_id, permission_mode)
        normalized_provider = validate_provider_override(provider_id, engine_id)
        model = model or default_model
        fast_model = fast_model or default_fast_model
        vision_model = vision_model or default_vision_model
        from services.chat_identity import new_session_id
        session_id = new_session_id(project_id)
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
                thinking_effort=(defaults.get('thinking_effort') or None) if defaults_name else None,
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
            summary["pending_handoff"] = self._pending_handoff_view(row)
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
        file_changes: bool = False,
        preview: bool = False,
        file_path: str | None = None,
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
            if preview and not file_changes:
                context = dict(project_id=project_id, session_id=session_id, message_id=message_id, engine=row.engine)
                if row.event_log_path:
                    ref = self._event_journal.reopen(project.workstep_dir, row.event_log_path)
                    page = self._event_journal.preview(ref, **context)
                else:
                    from agent_assistants.process_preview import process_preview, preview_agui_events
                    page = {"events": process_preview(preview_agui_events(_load_json(row.events_json, []), **context)),
                            "complete": False, "next_cursor": None}
                return {"message_id": message_id, **page}
            if file_changes:
                from agent_assistants.file_change_index import legacy_changes
                if row.event_log_path:
                    ref = self._event_journal.reopen(project.workstep_dir, row.event_log_path)
                    return self._event_journal.file_changes(ref, file_path=file_path, project_root=project.path)
                return legacy_changes(_load_json(row.events_json, []), file_path=file_path, project_root=project.path)
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
            if self._digital_person_session_kind(project_id, session_id) in {'main', 'reflection'}:
                raise ValueError('Digital hub system conversations cannot be archived or deleted')
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
            "lifecycle_protected": self._digital_person_session_kind(project_id, row.id) in {'main', 'reflection'},
            **channel_session_source(row.id, row.title),
            "archived": bool(row.archived),
            "archived_at": _iso(row.archived_at),
            "engine": row.engine,
            "model": row.model,
            "fast_model": row.fast_model,
            "vision_model": row.vision_model,
            "provider_id": row.provider_id,
            "thinking_effort": row.thinking_effort,
            "service_tier": row.service_tier,
            "execution_config_revision": row.execution_config_revision,
            "permission_mode": row.permission_mode or "",
            "role_binding": _load_json(row.role_binding_json, None),
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
                row = ChatSession.get_or_none(ChatSession.id == session_id)
                if row is None:
                    raise ValueError("Chat session not found")
                validate_permission_selection(row.engine, permission_mode)

        await self._project_manager.run_db(
            project_id, lambda _project: ensure_session_exists()
        )

        def persist_and_load() -> dict:
            with self._project_ctx(project_id):
                ChatSession.update(
                    permission_mode=permission_mode or None,
                    execution_config_revision=ChatSession.execution_config_revision + 1,
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
        service_tier: str | None = None,
        permission_mode: str | None = None,
        plan_mode: bool | None = None,
        goal_mode: bool | None = None,
        provider_id: str | None = None,
        schedule: bool = True,
        *,
        reset_context: bool = False,
        internal_event: str | None = None,
        face_person_ids: list[str] | None = None,
        face_context_recent: bool = False,
        reserved_message_ids: tuple[str, str] | None = None,
        message_context: dict | None = None,
    ) -> ChatAccepted:
        if not session_id:
            raise ValueError("Chat session id is required")
        requested_permission_mode = permission_mode
        permission_mode = (permission_mode or "").strip()
        if permission_mode and not is_valid_permission_mode(permission_mode):
            raise ValueError(f"Unsupported permission mode: {permission_mode}")
        requested_engine = engine
        requested_model = model
        requested_fast_model = fast_model
        requested_vision_model = vision_model
        requested_provider_id = provider_id
        memory_key, resolved_sid = self._session_identity(project_id, session_id)
        with self._project_ctx(project_id):
            row = ChatSession.get_or_none(ChatSession.id == session_id)
            if row is None:
                raise ValueError("Chat session not found")
            cached = self._sessions.get(memory_key)
            if cached is not None and not cached.lock.locked():
                stored = _load_json(row.fork_context_json, None)
                stored_handoff_id = stored.get("handoff_id") if isinstance(stored, dict) else None
                cached_handoff = cached.extra.get("pending_handoff") or {}
                # Another runtime can confirm the handoff through the workbench.
                if (stored_handoff_id != cached_handoff.get("handoff_id")
                        or row.session_provider != cached.session_provider):
                    self._sessions.pop(memory_key, None)
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
                raise ValueError("No compressible current engine session")
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
            if requested_permission_mode is None:
                permission_mode = "" if engine_switched else (row.permission_mode or "")
            validate_permission_selection(engine, permission_mode)
            if permission_mode or engine_switched or requested_permission_mode == "":
                ChatSession.update(permission_mode=permission_mode or None).where(
                    ChatSession.id == session_id
                ).execute()
            if requested_provider_id is not None and engine == (row.engine or ""):
                # 有既有上下文的会话统一通过交接入口切换端点。
                switched_provider = validate_provider_override(
                    requested_provider_id,
                    engine,
                )
                if (row.provider_id or "") != switched_provider:
                    if row.session_provider is not None or row.engine_session_id or row.engine_state_json:
                        raise ValueError(PROVIDER_HANDOFF_REQUIRED)
                    ChatSession.update(
                        provider_id=switched_provider or None,
                        engine_session_id=None,
                        engine_state_json=None,
                        session_provider=None,
                    ).where(ChatSession.id == session_id).execute()
                    memory_session = self._sessions.get(
                        self._session_identity(project_id, session_id)[0]
                    )
                    if memory_session is not None:
                        memory_session.resolved_session_id = None
                        memory_session.engine_state = None
                        memory_session.session_provider = None
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
            service_tier=service_tier,
            permission_mode=permission_mode or None,
            plan_mode=plan_mode,
            goal_mode=goal_mode,
            provider_id=provider_id,
            schedule=schedule,
            reset_context=reset_context,
            internal_event=internal_event,
            reserved_message_ids=reserved_message_ids,
            message_context={
                **(message_context or {}),
                **({'face_person_ids': list(dict.fromkeys(face_person_ids)),
                    **({'face_context_recent': True} if face_context_recent else {})} if face_person_ids else {}),
            } or None,
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

    def submit_internal_event(self, project_id, session_id, event_type, content, idempotency_key,
                              *, schedule=True, reset_context=False, reserved_message_ids=None):
        """Host-only event submission; never exposed as a client message field."""
        if not event_type or not all(c.isalnum() or c in '._-' for c in event_type):
            raise ValueError('Invalid internal event type')
        return self.submit_message(project_id,session_id,content,idempotency_key,
            schedule=schedule,reset_context=reset_context,internal_event=event_type,
            reserved_message_ids=reserved_message_ids)

    @staticmethod
    def _history_line(item):
        from .context_commands import context_content
        if item.get('internal_event'):
            return f"Internal event ({item['internal_event']}): {item['content']}"
        if item.get('role')=='user':
            return f"User: {context_content(item['content'])}"
        return f"Assistant: {item['content']}"

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

    def _workstep_tools_for_project(self, project_id: str) -> bool:
        if self._config.name == 'digital_person':
            return self._config.workstep_tools
        from services.customization_workspace import is_default_workspace
        project = self._project_manager.get_project_by_id(project_id) if self._project_manager else None
        return self._config.workstep_tools or bool(
            self._config.name in {'chat_session', 'channel_chat'}
            and config_store.get('digital_person', {}).get('enabled')
            and project and is_default_workspace(project)
        )

    async def _prepare_turn_context(self, session):
        await super()._prepare_turn_context(session)
        turn_state = self._turn_states.get(session.extra.get('current_turn_id'), {})
        turn_state.pop('session_retention_key', None)
        if self._config.name == 'chat_session' and self._project_manager is not None:
            from services.customization_workspace import is_default_workspace
            from services.digital_person_runtime import read_state
            from services.chat_session_retention import main_session_retention_key
            project = self._project_manager.get_project_by_id(session.project_id)
            if project is not None and await asyncio.to_thread(is_default_workspace, project):
                is_main = await self._project_manager.run_db(session.project_id, lambda _: (
                    read_state(session.project_id)['main_session_id'] == session.session_id
                ))
                if is_main:
                    turn_state['session_retention_key'] = main_session_retention_key(session.project_id, session.session_id)
        session.extra.pop('digital_person_context', None)
        session.extra.pop('digital_person_session_kind', None)
        session.extra.pop('filter_legacy_affect', None)
        session.extra.pop('digital_person_memories', None)
        session.extra.pop('digital_person_memory_scope', None)
        session.extra.pop('memory_context_prompt', None)
        session.extra.pop('camera_frame_prompt', None)
        messages = self._messages_through_current_input(session)
        latest_input = next((m for m in reversed(messages) if m.get('role') != 'assistant'), {})
        if latest_input.get('internal_event'):
            return
        if self._config.name not in {'chat_session', 'channel_chat'} or self._project_manager is None:
            return
        from services.face_recognition import person_prompt
        # Recovered native sessions may retain the preceding turn's instructions.
        # History also restores the need to explicitly clear a camera observation.
        if any(m.get('role') == 'user' and m.get('context', {}).get('face_person_ids') for m in messages):
            session.extra['camera_context_each_turn'] = True
        camera_context = latest_input.get('context', {})
        camera_prompt = await asyncio.to_thread(person_prompt, camera_context.get('face_person_ids', []))
        if camera_prompt:
            session.extra['camera_context_each_turn'] = True
            session.extra['camera_frame_prompt'] = camera_prompt
        project = self._project_manager.get_project_by_id(session.project_id)
        from services.digital_person import get_profile
        kind = await self._project_manager.run_db(session.project_id, lambda _: self._digital_person_session_kind(session.project_id, session.session_id))
        session.extra['digital_person_session_kind'] = kind
        digital_person_enabled = (await asyncio.to_thread(get_profile)).enabled
        is_digital = bool(kind) and digital_person_enabled
        if digital_person_enabled:
            from services.digital_person_memory import prepare_chat_context
            latest = next((item for item in reversed(messages) if item.get('role') == 'user'), {})
            query = latest.get('content', '')
            scope, hits, context = await prepare_chat_context(self._project_manager, session.project_id, session.session_id,
                                             query, latest.get('id'))
            session.extra['digital_person_memories'] = hits
            session.extra['digital_person_memory_scope'] = scope
            session.extra['memory_context_prompt'] = context
        from .context_commands import context_content
        from services.customization_workspace import is_default_workspace
        if (latest_input.get('role') == 'user'
                and project is not None
                and (self._config.name == 'channel_chat' or is_digital
                     or await asyncio.to_thread(is_default_workspace, project))
                and context_content(latest_input.get('content', '')).strip() != '/compact'):
            context = await self._project_manager.run_db(session.project_id, lambda _: self._load_digital_person_context(session))
            if context is not None:
                management = getattr(self, 'digital_person_delegations', None)
                if management is not None and digital_person_enabled:
                    from services.digital_person_delegations import render_delegation_list
                    items = await management.for_conversation(session.session_id, context.pop('delegation_state', None))
                    context['delegation_list'] = render_delegation_list(items)
                session.extra['digital_person_context'] = context
        if not is_digital:
            return
        session.extra['filter_legacy_affect'] = True
        from services.digital_person_browser import attach
        await asyncio.to_thread(attach, session.project_id, session.session_id)

    def _extract_streaming_text(self, session, raw):
        text = super()._extract_streaming_text(session, raw)
        if session.extra.get('filter_legacy_affect'):
            from services.digital_person_affect import visible_text
            text = visible_text(text)
        return text

    async def _parse_response(self, session, raw):
        reply, structured, events = await super()._parse_response(session, raw)
        if session.extra.get('filter_legacy_affect'):
            # Old resumed engine contexts may still emit the retired header; hide it without applying updates.
            from services.digital_person_affect import visible_text
            reply = visible_text(reply)
        return reply, structured, events

    def _load_digital_person_context(self, session):
        notice_filter = pw.Value(False)
        delegation_state = None
        is_main_session = False
        notice_sources = {}
        channel_notices = []
        from services.digital_person_channels import binding_ids_for_session, shared_origins
        binding_ids = (binding_ids_for_session(session.session_id)
                       if self._config.name in ('chat_session', 'channel_chat') else set())
        if self._config.name == 'chat_session' or binding_ids:
            from services.digital_person_runtime import read_state

            state = read_state(session.project_id)
            is_main_session = state['main_session_id'] == session.session_id
            from services.digital_person_tasks import all_executions
            origins = shared_origins(session.session_id, state['main_session_id'])
            own_delegations = [item for item in all_executions(state) if item['origin_session_id'] in origins]
            delegation_state = state
            if self._config.name == 'chat_session' and not is_main_session and not own_delegations and len(origins) == 1:
                return None
            delegated = {identifier: item for item in own_delegations
                         for identifier in (item['id'], item.get('execution_id', item['id']))}
            def add_source(notice_id, source):
                references = notice_sources.setdefault(notice_id, [])
                if source not in references:
                    references.append(source)

            for item in own_delegations:
                if run_id := item.get('notification_run_id'):
                    notice_id = str(uuid.uuid5(uuid.NAMESPACE_URL, run_id + session.session_id))
                    add_source(notice_id, {'delegation_id': item['id'], 'project_id': item['project_id'],
                                          'session_id': item['session_id'], 'message_id': item['message_id']})
            for run in state['runs']:
                channel_delivered = any(receipt.get('kind') == 'channel' and receipt.get('status') == 'delivered'
                                        and receipt.get('binding_id') in binding_ids
                                        for receipt in run.get('deliveries', []))
                if not channel_delivered and not any(receipt.get('kind') == 'local' and receipt.get('status') == 'delivered'
                           and receipt.get('session_id') == session.session_id
                           and (receipt.get('project_id') or session.project_id) == session.project_id
                           for receipt in run.get('deliveries', [])):
                    continue
                notice_id = str(uuid.uuid5(uuid.NAMESPACE_URL, run['id'] + session.session_id))
                if channel_delivered:
                    # Platforms do not necessarily echo bot sends into the local chat.
                    # Project only confirmed deliveries to this exact bound peer.
                    content = run.get('notification_message') or run.get('summary')
                    created_at = _from_iso(run.get('notified_at') or run.get('ended_at') or run.get('created_at'))
                    if content and created_at:
                        channel_notices.append({'id': notice_id, 'role': 'assistant', 'content': content,
                                                'project_id': session.project_id, 'session_id': session.session_id,
                                                'created_at': _iso(created_at)})
                for reference in run.get('notification_sources', []):
                    exact = next((item for item in own_delegations
                                  if item.get('notification_run_id') == run['id']
                                  or item.get('execution_id') == run.get('delegation_execution_id')
                                  and run.get('delegation_execution_id')), None)
                    if item := exact or delegated.get(reference):
                        add_source(notice_id, {'delegation_id': item['id'], 'project_id': item['project_id'],
                                              'session_id': item['session_id'], 'message_id': item['message_id']})
                source = run.get('sources') or {}
                pid, sid = source.get('origin_project_id'), source.get('origin_session_id')
                if pid and sid and (pid, sid) != (session.project_id, session.session_id):
                    add_source(notice_id, {'project_id': pid, 'session_id': sid})
            legacy_ids = {
                str(uuid.uuid5(uuid.NAMESPACE_URL, run['id'] + session.session_id))
                for run in state['runs'] if run.get('trigger') in ('manual', 'interval') and any(
                    receipt.get('kind') == 'local' and receipt.get('status') == 'delivered'
                    and receipt.get('session_id') == session.session_id
                    and (receipt.get('project_id') or session.project_id) == session.project_id
                    for receipt in (run.get('deliveries') or []))
            }
            notice_filter = ((pw.fn.INSTR(ChatMessage.context_json, '"digital_person_proactive"') > 0)
                             | ChatMessage.id.in_(legacy_ids))
        receipt_filter = pw.fn.INSTR(ChatMessage.context_json, '"digital_person_injection"') > 0
        notice_content = pw.Case(None, [(notice_filter, ChatMessage.content)]).alias('notice_content')
        rows = ChatMessage.select(ChatMessage.id, notice_content, ChatMessage.created_at, ChatMessage.context_json).where(
            ChatMessage.session == session.session_id, ChatMessage.role == 'assistant',
            ChatMessage.status.in_(('completed', 'succeeded')), notice_filter | receipt_filter,
        ).order_by(ChatMessage.created_at, ChatMessage.id)
        boundary = ChatSession.get_by_id(session.session_id).context_reset_at
        if boundary:
            rows = rows.where(ChatMessage.created_at >= boundary)
        acknowledged = set()
        notices = []
        previous = None
        for row in rows:
            context = _load_json(row.context_json, {}) or {}
            if row.notice_content is not None:
                notices.append({'id': row.id, 'role': 'assistant', 'content': row.notice_content,
                                'project_id': session.project_id, 'session_id': session.session_id,
                                'created_at': _iso(row.created_at),
                                **({'sources': notice_sources[row.id]} if row.id in notice_sources else {})})
            receipt = context.get('digital_person_injection')
            if receipt:
                acknowledged.update(receipt['notice_ids'])
                if session.resolved_session_id and receipt['thread'] == [session.engine, session.resolved_session_id]:
                    previous = receipt['parts']
        from datetime import datetime
        local_ids = {notice['id'] for notice in notices}
        for notice in channel_notices:
            if notice['id'] in local_ids:
                continue
            if boundary and datetime.fromisoformat(notice['created_at']) < boundary:
                continue
            if notice['id'] in notice_sources:
                notice['sources'] = notice_sources[notice['id']]
            notices.append(notice)
        notices.sort(key=lambda notice: (notice['created_at'], notice['id']))
        pending = [notice for notice in notices if notice['id'] not in acknowledged]
        return {'previous': previous, 'notices': notices, 'pending': pending,
                'delegation_state': delegation_state, 'is_main_session': is_main_session}

    def _digital_person_prompt(self, session) -> str:
        parts = self._digital_person_prompt_parts(session)
        if parts:
            session.extra['digital_person_each_turn'] = True
        return '\n\n'.join(parts.values())

    def _digital_person_prompt_parts(self, session) -> dict:
        from services.digital_person import prompt_parts_for_project
        from services.customization_workspace import is_default_workspace
        if self._project_manager is None:
            return {}
        kind = session.extra.get('digital_person_session_kind')
        if kind is None:
            with self._project_ctx(session.project_id):
                kind = self._digital_person_session_kind(session.project_id, session.session_id)
        if not kind:
            return {}
        project = self._project_manager.get_project_by_id(session.project_id)
        parts = prompt_parts_for_project(project)
        if not parts and project is not None and is_default_workspace(project) and config_store.get('digital_person'):
            parts['identity'] = '[WorkStep digital hub] Digital hub mode is disabled. The previous digital hub identity and duties no longer apply.'
        return parts

    def _digital_person_session_kind(self, project_id: str, session_id: str) -> str:
        """Resolve persisted purpose inside the project database executor, never from titles."""
        from services.customization_workspace import is_default_workspace
        project = self._project_manager.get_project_by_id(project_id) if self._project_manager else None
        if project is None or not is_default_workspace(project):
            return ''
        from services.digital_person_runtime import read_state
        state = read_state(project_id)
        if session_id == state.get('main_session_id'):
            return 'main'
        if session_id == state.get('check_session_id'):
            return 'reflection'
        if self._config.name in {'digital_person', 'digital_person_reflection'}:
            return 'reflection'
        channels = config_store.get('channel_bots', {})
        if (self._config.name == 'channel_chat'
                or session_id in channels.get('sessions', {}).values()
                or channel_session_source(session_id).get('source') == 'channel'):
            return 'channel'
        return ''

    def _engine_system_prompt(self, session) -> str:
        if self._config.name != "chat_session":
            return super()._engine_system_prompt(session)
        return self._chat_system_prompt(session)

    def _turn_source_prompt_parts(self, session) -> dict[str, str]:
        if not getattr(session, 'messages', None):
            return {}
        current = next((item for item in reversed(self._messages_through_current_input(session))
                        if item.get('role') == 'user'), {})
        if current.get('context', {}).get('channel_source', {}).get('use_main_session'):
            from agent_assistants.channel_chat import build_channel_background
            background = build_channel_background(session)
            return {'channel_source': background} if background else {}
        return {}

    def _chat_system_prompt(self, session) -> str:
        """Shared identity and conversation rules regardless of message transport."""
        extra = getattr(session, 'extra', {})
        context = extra.get('digital_person_context')
        if context is not None:
            parts = self._digital_person_prompt_parts(session)
            if parts.get('identity', '').startswith('[WorkStep digital hub]\n'):
                from services.digital_calendar import CHAT_RULES
                parts['calendar'] = CHAT_RULES
            if self._config.name == 'chat_session' and parts.get('identity', '').startswith('[WorkStep digital hub]\n'):
                from services.digital_person import COMPANION_UI_PROMPT
                parts['companion_ui'] = COMPANION_UI_PROMPT
                if context.get('is_main_session'):
                    from services.digital_person import identity_setup_prompt
                    parts['identity_setup'] = identity_setup_prompt()
            parts.update(global_rules=self.get_system_prompt(session.project_id), role=self._role_system_prompt(session),
                         memory=extra.get('memory_context_prompt'), camera=extra.get('camera_frame_prompt'))
            if parts.get('identity') or context.get('delegation_list') or context.get('notices') or context.get('pending'):
                parts['conversation_reference'] = (
                    "Resolve references from the user's explicit wording and recent dialogue first, then recent relevant notifications. "
                    'Persistent task snapshots do not establish the current topic or recency; use them to identify a matched task and check its state. Ask if still ambiguous.'
                )
            if context.get('delegation_list'):
                parts['delegation_rules'] = (
                    'Act on tasks only when the user asks. '
                    'The background service handles delegation review and notifications; workflow task progress comes from its actual task state.'
                )
                parts['delegations'] = context['delegation_list']
            parts.update(self._turn_source_prompt_parts(session))
            context['parts'] = {key: value for key, value in parts.items() if value}
            context['fingerprints'] = {key: hashlib.sha256(value.encode()).hexdigest() for key, value in context['parts'].items()}
            pending = context['pending']
            lines = ['[WorkStep conversation history]',
                     'Already delivered notifications, newest first; times use the current local timezone. Do not resend. '
                     "After matching the topic from recent dialogue, use the relevant notice's Source; do not choose by delegation list order. "
                     'If only delegation_id is given, look it up. If the source is missing or ambiguous, ask instead of using another notice\'s IDs.'] if pending else []
            for index, notice in enumerate(reversed(pending)):
                latest = '[Latest notification] ' if index == 0 else ''
                created_at = notice.get('created_at', '')
                if parsed := _from_iso(created_at):
                    created_at = (parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)).astimezone().isoformat(timespec='seconds')
                lines.append(f"- {latest}{created_at}\n  " + str(notice['content']).replace('\n', '\n  '))
                references = set()
                for source in notice.get('sources', []):
                    if source.get('delegation_id'):
                        reference = f"delegation_id={source['delegation_id']}"
                    elif source.get('project_id') and source.get('session_id'):
                        reference = f"project_id={source['project_id']} session_id={source['session_id']}"
                    else:
                        continue
                    if reference not in references:
                        references.add(reference)
                        lines.append('  Source: ' + reference)
            context['notice_prompt'] = '\n'.join(lines)
            return '\n\n'.join(filter(None, (*context['parts'].values(), context['notice_prompt'])))
        return "\n\n".join(part for part in (
            self._digital_person_prompt(session), self.get_system_prompt(session.project_id), self._role_system_prompt(session),
            extra.get('memory_context_prompt'), extra.get('camera_frame_prompt'), *self._turn_source_prompt_parts(session).values(),
        ) if part)

    def _turn_system_prompt_kwargs(self, session, system_prompt, *, rebuilding=False):
        context = session.extra.get('digital_person_context')
        if context is None:
            return super()._turn_system_prompt_kwargs(session, system_prompt, rebuilding=rebuilding)
        previous = context['previous']
        if previous is not None and 'identity' in previous and 'project_delegation' not in previous:
            parts = context['parts']
            if 'project_delegation' in parts:
                # Older receipts fingerprinted the two sections as a single string.
                combined = '\n\n'.join((parts['identity'], parts['project_delegation']))
                if hashlib.sha256(combined.encode()).hexdigest() == previous['identity']:
                    previous = {**previous, **{key: context['fingerprints'][key]
                                               for key in ('identity', 'project_delegation')}}
        changed = rebuilding or previous != context['fingerprints'] or bool(context['pending'])
        if changed and session.engine == 'codex_sdk' and previous is not None and not rebuilding:
            updates = [value for key, value in context['parts'].items() if previous.get(key) != context['fingerprints'][key]]
            if not previous.keys() - context['parts'].keys():
                system_prompt = '\n\n'.join(filter(None, (*updates, context['notice_prompt'])))
        kwargs = {'system_prompt': system_prompt} if system_prompt else {}
        if changed:
            kwargs['system_prompt_each_turn'] = True
        return kwargs

    def _record_successful_turn_context(self, session, message):
        context = session.extra.get('digital_person_context')
        if context is not None:
            message.setdefault('context', {})['digital_person_injection'] = {
                'thread': [session.engine, session.resolved_session_id], 'parts': context['fingerprints'],
                'notice_ids': [notice['id'] for notice in context['pending']],
            }

    @staticmethod
    def _messages_through_current_input(session):
        turn_id = getattr(session, 'extra', {}).get('current_turn_id')
        if turn_id:
            for index, message in enumerate(session.messages):
                if message.get('id') == turn_id:
                    return session.messages[:index + 1]
        return session.messages

    def _chat_prompt_history(self, session):
        context = session.extra.get('digital_person_context')
        messages = self._messages_through_current_input(session)
        if context is not None:
            pending = {notice['id'] for notice in context['pending']}
            existing = {message['id'] for message in messages}
            notices = [notice for notice in context['notices'] if notice['id'] not in existing]
            messages = sorted((message for message in (*messages, *notices) if message['id'] not in pending),
                              key=lambda message: (message.get('created_at', ''), message['id']))
        return [item for item in messages if not (item.get('role') == 'assistant' and item.get('status') == 'running')
                ][-self._config.max_history_turns * 2:]

    def _session_system_prompt_each_turn(self, session) -> bool:
        return bool(session.extra.get('pending_role_checkpoint') or session.extra.get('digital_person_each_turn') or session.extra.get('memory_context_prompt') or session.extra.get('camera_context_each_turn')) or super()._session_system_prompt_each_turn(session)

    def _capture_prompt_input(self) -> bool:
        return self._config.name in {"chat_session", "channel_chat"} or super()._capture_prompt_input()

    def _display_prompt(self, session, prompt: str, system_prompt: str | None = None) -> str:
        if self._config.name not in {"chat_session", "channel_chat"}:
            return super()._display_prompt(session, prompt, system_prompt)
        # No preview assembled from config: wait for actual prepared inputs.
        return ""

    async def _run_turn_guarded(self, session, turn_id, assistant_message_id):
        from services.conversation_context import conversation_context

        if self._config.name not in {"chat_session", "channel_chat", "digital_person", "digital_person_reflection"}:
            return await super()._run_turn_guarded(session, turn_id, assistant_message_id)
        with conversation_context(session.project_id, session.session_id):
            return await super()._run_turn_guarded(session, turn_id, assistant_message_id)

    async def _run_turn(self, session, turn_id, assistant_message_id):
        from services.conversation_context import conversation_context

        if self._config.name in {"chat_session", "channel_chat"}:
            message = next((item for item in session.messages if item.get("id") == turn_id), {})
            is_user = (message.get("role") == "user" and not message.get("internal_event")
                       and message.get("author_type") not in {"scheduler", "assistant", "system", "coordinator"})
            with conversation_context(session.project_id, session.session_id, message_id=turn_id,
                                      sender_id=(message.get("author_id") or "") if is_user else "",
                                      sender_name=(message.get("author_name") or "") if is_user else ""):
                return await super()._run_turn(session, turn_id, assistant_message_id)
        return await super()._run_turn(session, turn_id, assistant_message_id)

    async def _publish(self, session, assistant_message_id, event_type, data, event_sequence):
        result = await super()._publish(session, assistant_message_id, event_type, data, event_sequence)
        management = getattr(self, 'digital_person_delegations', None)
        if management is not None:
            if event_type in ('interaction_request', 'interaction_response'):
                management.interaction(session.project_id, assistant_message_id, event_type, data)
            elif event_type == 'message_completed':
                try:
                    await management.finished(session.project_id, assistant_message_id)
                except Exception:
                    logger.exception('Failed to record delegation execution status for message %s', assistant_message_id)
        return result

    def is_turn_queued(self, turn_id: str) -> bool:
        return self._turn_states.get(turn_id, {}).get('status') == 'queued'

    def _build_prompt(self, session) -> str:
        return self._build_chat_prompt(session)

    async def _handle_context_command(self, session, turn_id: str) -> bool:
        from .context_commands import reset_command
        user = next(m for m in session.messages if m.get('id') == turn_id)
        remainder = None if user.get('internal_event') else reset_command(user.get('content', ''))
        internal_reset = self._turn_states[turn_id].get('reset_context', False)
        if remainder is None and not internal_reset:
            return False
        from datetime import datetime
        boundary = datetime.fromisoformat(user['created_at'])

        def reset(_project):
            ChatSession.update(
                engine_session_id=None, engine_state_json=None, session_provider=None, fork_context_json=None,
                role_checkpoint_json=None, context_reset_at=boundary, updated_at=utc_now(),
            ).where(ChatSession.id == session.session_id).execute()

        await self._project_manager.run_db(session.project_id, reset)
        from services.chat_session_retention import release_main_session_retention
        await release_main_session_retention(session.project_id, session.session_id)
        session.resolved_session_id = None
        session.engine_state = None
        session.session_provider = None
        for key in ('pending_handoff', 'role_checkpoint', 'pending_role_checkpoint'):
            session.extra.pop(key, None)
        session.messages = [m for m in session.messages if m.get('created_at', '') >= user['created_at']]
        # Internal control never becomes a message or a command acknowledgement.
        return False if internal_reset else not remainder

    def _build_chat_prompt(self, session) -> str:
        """Build user/context input; configured chat rules travel independently."""
        from .context_commands import context_content
        prompt = self._prompt_system_instruction(session)
        pending_handoff = session.extra.get("pending_handoff")
        if isinstance(pending_handoff, dict):
            project = self._project_manager.get_project_by_id(session.project_id)
            if project is None:
                raise ValueError(f"Project not found: {session.project_id}")
            user_message = next(
                (
                    str(item.get('content') or '') if item.get('internal_event') else context_content(str(item.get("content") or ""))
                    for item in reversed(self._messages_through_current_input(session))
                    if item.get("role") == "user" or item.get('internal_event')
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
                    str(item.get('content') or '') if item.get('internal_event') else context_content(str(item.get("content") or ""))
                    for item in reversed(self._messages_through_current_input(session))
                    if item.get("role") == "user" or item.get('internal_event')
                ),
                "",
            )
            if session.resolved_session_id or not prompt:
                return user_message
            return f"{prompt}\n\n{user_message}"
        turns = self._chat_prompt_history(session)
        history = "\n\n".join(
            self._history_line(item)
            for item in turns
        )
        tail = f"Conversation history:\n{history}\n\nContinue."
        return f"{prompt}\n\n{tail}" if prompt else tail

    def _build_rebuild_prompt(self, session) -> str:
        """Rebuild a lost engine thread from the persisted conversation."""
        prompt = self._build_chat_prompt(session)
        if session.resolved_session_id:
            turns = self._chat_prompt_history(session)
            history = "\n\n".join(
                self._history_line(item)
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
                    f"System prompt cannot exceed {MAX_SYSTEM_PROMPT_LENGTH} characters"
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
            raise ValueError("Prompt cannot be empty")
        if len(prompt) > ENHANCE_MAX_LENGTH:
            raise ValueError(f"Prompt cannot exceed {ENHANCE_MAX_LENGTH} characters")
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
                raise ValueError("Prompt enhancement provider not found. Update it in Settings.")
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
                raise ValueError("Prompt enhancement failed, please retry")
            await gateway_client.record_one_shot_usage(
                project_id=project_id, model=enhance_config["model"],
                provider=provider_snapshot, usage=usage or None,
            )
            return result
        enhance_input = f"{ENHANCE_SYSTEM_PROMPT}\n\nUser prompt:\n{prompt}"
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
                permission_mode=None,
            )
            usage_json = extract_usage_json(events)
            usage_details = {
                "provider": provider_snapshot,
                "model": fast_model or "",
                "usage": json.loads(usage_json) if usage_json else None,
            }
        result = raw.strip()
        if not result:
            raise ValueError("Prompt enhancement failed, please retry")
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

    def _execution_settings_name(self, project_id: str) -> str:
        from services.customization_workspace import is_default_workspace
        if self._config.name == "channel_chat" and config_store.get("digital_person", {}).get("enabled"):
            project = self._project_manager.get_project_by_id(project_id)
            if project and is_default_workspace(project):
                return "digital_person"
        return self._config.name

    def _resolve_project_engine_models(self, project_id: str):
        name = self._execution_settings_name(project_id)
        return self._resolve_named_engine_models(name) if name != self._config.name else self._resolve_engine_models()

    def _resolve_engine_models(self) -> tuple[str, str | None, str | None]:
        return self._resolve_named_engine_models(self._config.name)

    def _resolve_named_engine_models(self, name: str) -> tuple[str, str | None, str | None]:
        defaults = config_store.get_assistant_defaults(name)
        configured_id = defaults["engine"] or resolve_execution_engine(None)
        if (
            configured_id == "pydantic_ai"
            and (defaults.get("provider_id") or "").strip()
        ):
            if create_engine("pydantic_ai") is None:
                raise ValueError("Built-in engine unavailable")
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
