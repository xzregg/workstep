"""Generic assistant conversation layer.

An "assistant" is an LLM-backed multi-turn chat — e.g. the task coordinator
(``agent_assistants/coordinator.py``) or the AI flow designer
(``agent_assistants/workflow_gen.py``). Everything about running such a conversation
is shared here: session identity & lifecycle, idempotency, engine invocation
with resume support, streaming event publishing, history and pruning.

Adding a new assistant only requires registering an ``AssistantConfig``
(system prompt + optional response parser / persistence adapter) in
``assistant_registry``; no new session or turn machinery is needed.
"""

import asyncio
import inspect
import json
import logging
import re
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable

from engines.core.agui import AGUIContext, to_agui_events
from engines.core.events import InternalEvent, is_commentary
from agent_assistants.event_journal import JournalRef, TurnEventJournal
from agent_assistants.engine_invocation import run_engine_turn
from agent_assistants.session_state import AssistantSession, AcceptedTurn
from agent_assistants.persistence import PersistenceAdapter, MemoryPersistence, JsonRowPersistence
from agent_assistants.history import _PERSISTED_EVENT_TYPES, _prune_events, default_history_message, repair_message_times
from agent_assistants.event_truncation import truncate_large_tool_payloads
from agent_assistants.thought_aggregation import ThoughtChunkAggregator
from engines.core.registry import create_engine
from engines.core.schema import EngineImage
from models.fields import utc_now
from services.chat_permissions import (
    is_valid_permission_mode,
)
from services.config import CODEX_REASONING_EFFORTS, config_store, resolve_execution_engine
from services.remote_project import get_effective_actor
from streaming.bus import EventBus

logger = logging.getLogger(__name__)

# Session scopes: how a conversation is identified and kept alive.
SCOPE_EPHEMERAL = "ephemeral"   # one-off chat; fresh session each time
SCOPE_WORKFLOW = "workflow"     # pinned to a workflow; survives daemon restarts
SCOPE_TASK = "task"             # pinned to a task
SCOPE_CHAT = "chat"             # Codex-style chat session (row in chat_sessions)

MAX_HISTORY_TURNS = 8
MAX_SESSIONS = 200
SESSION_TTL_SECONDS = 60 * 60
SHUTDOWN_DRAIN_TIMEOUT_SECONDS = 1.0

_IMAGE_MARKDOWN_RE = re.compile(r"!\[([^\]]*)\]\(([^)]+)\)")
_UPLOADS_PATH_RE = re.compile(r"([^\s`\"'()]+\.workstep/uploads/[^\s`\"'()]+)")
_CODEX_ROLLOUT_MISSING_RE = re.compile(
    r"no rollout found for thread id\s+\S+",
    re.IGNORECASE,
)


def is_missing_codex_rollout_error(error: BaseException | str) -> bool:
    """Return True only for Codex's explicit missing-rollout resume error."""
    return bool(_CODEX_ROLLOUT_MISSING_RE.search(str(error)))


def extract_uploaded_images(project, cwd: str, content: str) -> list[EngineImage]:
    """Resolve image references that are safely contained in project uploads."""
    if project is None:
        return []
    uploads = (Path(project.workstep_dir) / "uploads").resolve()
    root = Path(cwd).resolve()
    candidates = [(alt, target) for alt, target in _IMAGE_MARKDOWN_RE.findall(content)]
    candidates.extend(("", target) for target in _UPLOADS_PATH_RE.findall(content))
    images: list[EngineImage] = []
    seen: set[str] = set()
    for alt, target in candidates:
        resolved: Path | None = None
        candidate_paths: list[Path] = []
        legacy_prefix = f"{project.name}/.workstep/uploads/"
        if target.startswith(legacy_prefix):
            candidate_paths.append(uploads / target[len(legacy_prefix):])
        for base in (root, root.parent):
            candidate = Path(target)
            if not candidate.is_absolute():
                candidate = base / candidate
            candidate_paths.append(candidate)
        for candidate in candidate_paths:
            try:
                candidate = candidate.resolve()
                candidate.relative_to(uploads)
            except (OSError, ValueError):
                continue
            if candidate.is_file():
                resolved = candidate
                break
        if resolved is None or str(resolved) in seen:
            continue
        seen.add(str(resolved))
        images.append(EngineImage(path=str(resolved), description=alt))
    return images


def extract_streaming_reply(raw: str) -> str:
    """Extract the currently complete part of a JSON reply string."""
    match = re.search(r'"reply"\s*:\s*"', raw)
    if match is None:
        return ""
    index = match.end()
    result: list[str] = []
    escapes = {
        '"': '"',
        "\\": "\\",
        "/": "/",
        "b": "\b",
        "f": "\f",
        "n": "\n",
        "r": "\r",
        "t": "\t",
    }
    while index < len(raw):
        character = raw[index]
        if character == '"':
            break
        if character != "\\":
            result.append(character)
            index += 1
            continue
        if index + 1 >= len(raw):
            break
        escape = raw[index + 1]
        if escape == "u":
            digits = raw[index + 2:index + 6]
            if len(digits) != 4 or not all(char in "0123456789abcdefABCDEF" for char in digits):
                break
            result.append(chr(int(digits, 16)))
            index += 6
            continue
        if escape not in escapes:
            break
        result.append(escapes[escape])
        index += 2
    return "".join(result)


def validate_provider_override(provider_id: str, engine_id: str) -> str:
    """Validate a per-turn/per-session provider override (empty returns '')."""
    provider_id = (provider_id or "").strip()
    if not provider_id:
        return ""
    provider = config_store.get_provider(provider_id)
    if provider is None:
        raise ValueError("供应商不存在")
    if not provider.get("enabled", True):
        raise ValueError("所选供应商已停用")
    engine = create_engine(engine_id)
    if engine is None or not engine.supports_provider(provider):
        raise ValueError("供应商协议与所选引擎不兼容")
    return provider_id


async def invoke_engine(
    engine_id: str,
    model: str | None,
    cwd: str,
    prompt: str,
    session_id: str | None,
    on_event: Callable[[InternalEvent], Awaitable[None]] | None = None,
    *,
    spawner: Callable[[object], object] | None = None,
    error_prefix: str = "LLM engine failed",
    run_key: str | None = None,
    running_engines: dict[str, object] | None = None,
    assign_session_on_no_resume: bool = False,
    message_history: list | None = None,
    images: list[EngineImage] | None = None,
    report_engine_state: bool = False,
    thinking_effort: str | None = None,
    permission_mode: str | None = None,
    plan_mode: bool | None = None,
    goal_mode: bool | None = None,
    workstep_tools: bool = False,
    config_overrides: dict | None = None,
    live_message_queue: asyncio.Queue | None = None,
) -> tuple[str, list[dict], str | None]:
    """Compatibility entry point; the turn transport lives in engine_invocation."""
    return await run_engine_turn(
        engine_id, model, cwd, prompt, session_id, on_event,
        engine_factory=create_engine,
        settings_store=config_store,
        spawner=spawner,
        error_prefix=error_prefix,
        run_key=run_key,
        running_engines=running_engines,
        assign_session_on_no_resume=assign_session_on_no_resume,
        message_history=message_history,
        images=images,
        report_engine_state=report_engine_state,
        thinking_effort=thinking_effort,
        permission_mode=permission_mode,
        plan_mode=plan_mode,
        goal_mode=goal_mode,
        workstep_tools=workstep_tools,
        config_overrides=config_overrides,
        live_message_queue=live_message_queue,
    )


@dataclass
class AssistantConfig:
    """Declarative description of one assistant.

    Everything the shared runtime needs to run a conversation. Most
    assistants only need ``name`` / ``channel`` / ``system_prompt`` /
    ``scope``; richer ones supply a response parser, persistence and custom
    prompt building.
    """

    name: str
    channel: str
    system_prompt: str = ""
    scope: str = SCOPE_EPHEMERAL
    engine_label: str = "LLM engine"
    max_history_turns: int = MAX_HISTORY_TURNS
    max_sessions: int = MAX_SESSIONS
    session_ttl_seconds: int = SESSION_TTL_SECONDS
    persistence: PersistenceAdapter | None = None
    event_journal: TurnEventJournal | None = None
    # Per-assistant tool loading: when True, this assistant loads the WorkStep
    # internal tools natively (the engine registers the ``workstep_call``
    # function tool; its docstring carries the interface docs). Nothing is
    # injected into the prompt text. Only engines that can host the tool
    # (``supports_workstep_tools`` capability) actually register it.
    workstep_tools: bool = False
    # Hooks (defaults are provided by AssistantRuntime).
    session_identity: Callable[[str, str | None, str | None], tuple[tuple, str]] | None = None
    resolve_engine_models: Callable[[], tuple[str, str | None, str | None]] | None = None
    build_prompt: Callable[[AssistantSession], str] | None = None
    parse_response: Callable[[AssistantSession, str], tuple[str, list, list]] | None = None
    publish_structured: Callable[[AssistantSession, str, str, list, int], Awaitable[int]] | None = None
    extract_streaming_text: Callable[[str], str] | None = None
    history_message: Callable[[dict], dict] | None = None
    cwd_resolver: Callable[[object, str], str] | None = None
    validate_engine: Callable[[str], None] | None = None


class AssistantRuntime:
    """Shared conversation engine for any registered assistant."""

    def __init__(
        self,
        config: AssistantConfig,
        event_bus: EventBus,
        project_manager,
    ):
        self._config = config
        self._event_bus = event_bus
        self._project_manager = project_manager
        self._sessions: dict[tuple, AssistantSession] = {}
        self._turn_keys: dict[tuple[str, str, str], str] = {}
        self._turn_states: dict[str, dict] = {}
        self._active_tasks: set[asyncio.Task] = set()
        self._turn_tasks: dict[str, asyncio.Task] = {}
        self._running_engines: dict[str, object] = {}
        self._stop_tasks: set[asyncio.Task] = set()
        self._shutting_down = False

    # ── public API ──────────────────────────────────────────────────────

    def submit_message(
        self,
        project_id: str,
        content: str,
        idempotency_key: str,
        *,
        session_id: str,
        memory_key: tuple,
        scope_key: str | None = None,
        idempotency_sid: str | None = None,
        engine: str | None = None,
        model: str | None = None,
        fast_model: str | None = None,
        vision_model: str | None = None,
        thinking_effort: str | None = None,
        permission_mode: str | None = None,
        plan_mode: bool | None = None,
        goal_mode: bool | None = None,
        provider_id: str | None = None,
        steps: dict | None = None,
        extra: dict | None = None,
        schedule: bool = True,
        author_name: str | None = None,
    ) -> AcceptedTurn:
        """Queue one turn; returns immediately with an accepted turn.

        ``idempotency_sid`` decouples the idempotency key from the canonical
        session id: callers that mint a fresh session id on every request
        (ephemeral chats) should pass the *client-provided* session id (or an
        empty string) here so replays dedupe correctly.
        """
        normalized = (content or "").strip()
        if not normalized:
            raise ValueError("Message content cannot be empty")
        if not (idempotency_key or "").strip():
            raise ValueError("Idempotency-Key is required")
        normalized_effort = (thinking_effort or "").strip()
        if not normalized_effort:
            # “默认”表示不覆盖，由引擎自己的配置决定；只有协调助手
            # 有全局协调默认这一层显式回退。
            reader = (
                config_store.get_assistant_defaults
                if self._config.name == "task_coordinator"
                else config_store.get_assistant_config
            )
            normalized_effort = reader(self._config.name).get(
                "thinking_effort", ""
            ) or ""
        if normalized_effort and normalized_effort not in CODEX_REASONING_EFFORTS:
            raise ValueError(f"Invalid thinking effort: {normalized_effort}")
        normalized_permission = (permission_mode or "").strip()
        if normalized_permission and not is_valid_permission_mode(normalized_permission):
            raise ValueError(f"Invalid permission mode: {normalized_permission}")

        key_sid = idempotency_sid if idempotency_sid is not None else session_id
        key = (project_id, key_sid, idempotency_key)
        existing_turn_id = self._turn_keys.get(key)
        if existing_turn_id is not None and existing_turn_id in self._turn_states:
            return AcceptedTurn(
                session_id=self._turn_states[existing_turn_id].get(
                    "session_id", session_id
                ),
                turn_id=existing_turn_id,
                assistant_message_id=self._turn_states[existing_turn_id].get(
                    "assistant_message_id", ""
                ),
                status=self._turn_states[existing_turn_id]["status"],
            )

        engine_id, default_model, default_fast_model = self._resolve_engine_models()
        default_vision_model = config_store.get_assistant_defaults(
            self._config.name
        ).get("vision_model", "") or None
        if engine:
            if self._config.validate_engine is not None:
                self._config.validate_engine(engine)
            else:
                candidate = create_engine(engine)
                if (
                    candidate is None
                    or not candidate.capabilities.supports_coordinator
                ):
                    raise ValueError(
                        f"{self._config.engine_label} is unavailable: {engine}"
                    )
            if engine != engine_id:
                default_model = (
                    config_store.get_engine_default_model(engine) or None
                )
                default_fast_model = default_model
                default_vision_model = None
            engine_id = engine
        normalized_provider = validate_provider_override(provider_id, engine_id)
        model = model or default_model
        fast_model = fast_model or default_fast_model
        vision_model = vision_model or default_vision_model
        session = self._get_or_create_session(
            project_id,
            session_id,
            memory_key,
            scope_key,
            engine_id,
            model,
            fast_model,
            vision_model,
            steps,
            engine_override=engine,
            model_override=model,
            fast_model_override=fast_model,
            vision_model_override=vision_model,
            extra=extra,
        )

        turn_id = str(uuid.uuid4())
        assistant_message_id = str(uuid.uuid4())
        journal_ref: JournalRef | None = None
        if self._config.event_journal is not None:
            try:
                with self._project_ctx(session.project_id) as project:
                    journal_ref = self._config.event_journal.start(
                        project.workstep_dir,
                        session.session_id,
                        assistant_message_id,
                    )
            except Exception:
                logger.exception("Failed to start assistant event journal")
        actor = get_effective_actor()
        stored_author_name = (author_name or "").strip() or (
            actor.user_name if actor is not None else ""
        )
        stored_actor = (
            actor
            if actor is not None
            and (not (author_name or "").strip() or stored_author_name == actor.user_name)
            else None
        )
        session.messages.append(
            {
                "role": "user",
                "content": normalized,
                "id": turn_id,
                "created_at": utc_now().isoformat(),
                **(
                    {
                        "author_id": stored_actor.actor_id,
                        "author_username": stored_actor.username or stored_actor.user_name,
                        "author_name": stored_actor.user_name,
                        "initiated_by_user_id": stored_actor.actor_id,
                        "initiated_by_username": stored_actor.username or stored_actor.user_name,
                        "author_device_id": stored_actor.device_id,
                        "author_device_name": stored_actor.device_name,
                    }
                    if stored_actor is not None
                    else {}
                ),
                **(
                    {"author_name": stored_author_name}
                    if stored_author_name
                    else {}
                ),
                "author_type": "user",
            }
        )
        started_at = utc_now().isoformat()
        session.messages.append(
            {
                "role": "assistant",
                "content": "",
                "id": assistant_message_id,
                "engine": session.engine,
                "model": session.model,
                "author_id": session.engine or "assistant",
                "author_username": session.engine or "assistant",
                "author_name": session.engine or "助手",
                "author_type": "assistant",
                "initiated_by_user_id": stored_actor.actor_id if stored_actor else None,
                "initiated_by_username": (
                    (stored_actor.username or stored_actor.user_name)
                    if stored_actor else stored_author_name or None
                ),
                "status": "running",
                "created_at": started_at,
                "events": [],
                **({
                    "author_device_id": stored_actor.device_id,
                    "author_device_name": stored_actor.device_name,
                } if stored_actor is not None else {}),
                **(
                    {
                        "event_log_path": journal_ref.relative_path,
                        "event_summary": {},
                        "event_detail": {"available": True, "loaded": False},
                    }
                    if journal_ref is not None
                    else {}
                ),
            }
        )
        if self._config.persistence is not None:
            with self._project_ctx(session.project_id):
                self._config.persistence.save(session)
        self._turn_keys[key] = turn_id
        self._turn_states[turn_id] = {
            "status": "queued",
            "assistant_message_id": assistant_message_id,
            "session_id": session.session_id,
            "thinking_effort": normalized_effort or None,
            "permission_mode": normalized_permission or None,
            "plan_mode": bool(plan_mode),
            "goal_mode": bool(goal_mode),
            "provider_id": normalized_provider or None,
            "engine_overridden": bool(engine),
            "journal_ref": journal_ref,
            "memory_key": memory_key,
            "live_message_queue": asyncio.Queue(),
        }
        if schedule:
            self.start_queued_turn(turn_id)
        return AcceptedTurn(
            session_id=session.session_id,
            turn_id=turn_id,
            assistant_message_id=assistant_message_id,
            status="queued",
        )

    def start_queued_turn(self, turn_id: str) -> None:
        """Start a persisted assistant turn on the current event loop.

        The turn first acquires a chat-concurrency slot; while the project's
        chat channel is full the turn stays ``queued`` and waits (FIFO).
        """
        existing = self._turn_tasks.get(turn_id)
        if existing is not None and not existing.done():
            return
        state = self._turn_states.get(turn_id)
        if state is None:
            raise ValueError("Assistant turn not found")
        session = self._sessions.get(state.get("memory_key"))
        if session is None:
            raise ValueError("Assistant session not found")
        assistant_message_id = str(state.get("assistant_message_id") or "")
        background = asyncio.create_task(
            self._run_turn_guarded(session, turn_id, assistant_message_id),
            name=f"assistant-{self._config.name}:{turn_id}",
        )
        self._active_tasks.add(background)
        self._turn_tasks[turn_id] = background
        background.add_done_callback(
            lambda task, active_turn_id=turn_id: self._consume_background(
                task, active_turn_id
            )
        )

    async def _run_turn_guarded(
        self,
        session: AssistantSession,
        turn_id: str,
        assistant_message_id: str,
    ) -> None:
        """Acquire a chat slot, run the turn, then always release it.

        While waiting for a slot the turn keeps its ``queued`` status, so the
        UI shows the conversation waiting instead of running.
        """
        from services.concurrency import concurrency_gate, session_key

        project_id = session.project_id
        key = session_key(project_id, session.session_id)
        try:
            await concurrency_gate.acquire_chat(project_id, key)
        except asyncio.CancelledError:
            await self._finalize_queued_turn_as_stopped(
                session,
                turn_id,
                assistant_message_id,
            )
            return
        try:
            await self._run_turn(session, turn_id, assistant_message_id)
            state = self._turn_states.get(turn_id, {})
            if (
                not self._shutting_down
                and state.get("status") in {"completed", "error"}
            ):
                await self._consume_pending_inserts(
                    session,
                    turn_id,
                    str(state.get("assistant_message_id") or assistant_message_id),
                )
        finally:
            await concurrency_gate.release_chat(project_id, key)

    async def _finalize_queued_turn_as_stopped(
        self,
        session: AssistantSession,
        turn_id: str,
        assistant_message_id: str,
    ) -> None:
        """Persist and publish a terminal state when a queued turn is cancelled."""
        state = self._turn_states.get(turn_id)
        if state is None or state.get("status") == "stopped":
            return
        message = next(
            (
                item for item in session.messages
                if item.get("id") == assistant_message_id
            ),
            None,
        )
        ended_at = utc_now().isoformat()
        if message is not None:
            message.update({
                "status": "stopped",
                "ended_at": ended_at,
            })
            await self._finish_journal(
                state.get("journal_ref"),
                message,
                {"type": "status", "data": {"status": "stopped"}},
            )
        state["status"] = "stopped"
        await self._persist_session(session)
        try:
            await self._publish(
                session,
                assistant_message_id,
                "message_completed",
                {"status": "stopped", "content": "", "ended_at": ended_at},
                0,
            )
        except Exception:
            logger.exception("Failed to publish stopped queued turn %s", turn_id)

    async def _consume_pending_inserts(
        self,
        session: AssistantSession,
        completed_turn_id: str,
        target_message_id: str,
    ) -> None:
        """Merge one completed reply's pending inserts into one new turn."""
        if self._project_manager is None or not target_message_id:
            return
        state = self._turn_states.get(completed_turn_id, {})
        memory_key = state.get("memory_key")
        if memory_key is None:
            return

        def prepare(_project):
            from services.pending_message_inserts import (
                delete_pending_insert_batch,
                pending_insert_actor,
                pending_insert_batch,
            )
            from services.remote_access import replayed_actor_context

            ids, content, username = pending_insert_batch(target_message_id)
            if not ids or not content:
                return None
            actor = pending_insert_actor(target_message_id)
            with replayed_actor_context(actor):
                accepted = AssistantRuntime.submit_message(
                    self,
                    session.project_id,
                    content,
                    f"pending-insert:{target_message_id}:{','.join(ids)}",
                    session_id=session.session_id,
                    memory_key=memory_key,
                    scope_key=session.scope_key,
                    engine=session.engine,
                    model=session.model,
                    fast_model=session.fast_model,
                    vision_model=session.vision_model,
                    provider_id=state.get("provider_id"),
                    steps=session.steps,
                    extra=session.extra,
                    schedule=False,
                    author_name=username,
                )
            delete_pending_insert_batch(ids)
            return accepted

        try:
            accepted = await self._project_manager.run_db(
                session.project_id,
                prepare,
            )
        except Exception:
            logger.exception(
                "Failed to consume pending inserts for assistant message %s",
                target_message_id,
            )
            return
        if accepted is not None:
            self.start_queued_turn(accepted.turn_id)

    async def stop_current(self, session_id: str) -> bool:
        """Stop the newest queued or running turn for an assistant session."""
        for turn_id, state in reversed(self._turn_states.items()):
            if state.get("session_id") != session_id:
                continue
            if state.get("status") == "stopping":
                return True
            if state.get("status") not in ("queued", "running"):
                continue
            task = self._turn_tasks.get(turn_id)
            if task is None or task.done():
                session = self._sessions.get(state.get("memory_key"))
                if session is not None:
                    await self._finalize_queued_turn_as_stopped(
                        session,
                        turn_id,
                        str(state.get("assistant_message_id") or ""),
                    )
                else:
                    state["status"] = "stopped"
                return True
            state["status"] = "stopping"
            engine = self._running_engines.get(turn_id)
            if engine is not None:
                cleanup = asyncio.create_task(
                    self._stop_engine(turn_id, task, engine),
                    name=f"assistant-stop-{self._config.name}:{turn_id}",
                )
                self._stop_tasks.add(cleanup)
                cleanup.add_done_callback(self._consume_stop_task)
            else:
                task.cancel()
            return True
        return False

    async def set_running_permission_mode(
        self,
        session_id: str,
        permission_mode: str,
    ) -> bool:
        """Apply a permission change to a queued or running assistant turn."""
        matched = False
        for turn_id, state in reversed(self._turn_states.items()):
            if (
                state.get("session_id") != session_id
                or state.get("status") not in {"queued", "running"}
            ):
                continue
            engine = self._running_engines.get(turn_id)
            if engine is not None:
                await engine.set_permission_mode(permission_mode)
            state["permission_mode"] = permission_mode or None
            matched = True
        return matched

    async def send_live_message(
        self,
        session_id: str,
        content: str,
        project_id: str | None = None,
        pending_insert_ids: list[str] | None = None,
    ) -> dict:
        """Persist and queue a user message for the active assistant turn."""
        normalized = content.strip()
        if not normalized:
            raise ValueError("消息内容不能为空")
        active: tuple[str, dict] | None = None
        for turn_id, state in reversed(self._turn_states.items()):
            if (
                state.get("session_id") == session_id
                and state.get("status") in {"queued", "running"}
            ):
                active = (turn_id, state)
                break
        if active is None:
            raise ValueError("Chat session is not running")
        _turn_id, state = active
        session = self._sessions.get(state.get("memory_key"))
        if session is None:
            raise ValueError("Chat session not found")
        if project_id is not None and session.project_id != project_id:
            raise ValueError("Chat session not found")
        engine = await asyncio.to_thread(create_engine, session.engine)
        capabilities = getattr(engine, "capabilities", None)
        if not getattr(capabilities, "supports_live_step_message", False):
            raise ValueError("该引擎不支持执行中消息注入")
        queue = state.get("live_message_queue")
        if not isinstance(queue, asyncio.Queue):
            raise ValueError("会话消息队列不可用")

        message_id = str(uuid.uuid4())
        created_at = utc_now().isoformat()
        actor = get_effective_actor()
        message = {
            "role": "user",
            "content": normalized,
            "id": message_id,
            "created_at": created_at,
            **(
                {
                    "author_id": actor.actor_id,
                    "author_username": actor.username or actor.user_name,
                    "author_name": actor.user_name,
                    "author_type": "user",
                    "initiated_by_user_id": actor.actor_id,
                    "initiated_by_username": actor.username or actor.user_name,
                    "author_device_id": actor.device_id,
                    "author_device_name": actor.device_name,
                }
                if actor is not None
                else {}
            ),
        }
        pending_ids = list(dict.fromkeys(pending_insert_ids or []))
        session.messages.append(message)
        if self._config.persistence is not None:
            def persist(_project):
                if pending_ids:
                    from models import PendingMessageInsert
                    from services.pending_message_inserts import delete_pending_insert_batch

                    existing = list(
                        PendingMessageInsert.select(PendingMessageInsert.id).where(
                            PendingMessageInsert.id.in_(pending_ids)
                        )
                    )
                    if len(existing) != len(pending_ids):
                        raise ValueError("待插入消息已被处理")
                    self._config.persistence.save(session)
                    delete_pending_insert_batch(pending_ids)
                    return
                self._config.persistence.save(session)

            try:
                await self._project_manager.run_db(session.project_id, persist)
            except Exception:
                session.messages = [item for item in session.messages if item.get("id") != message_id]
                raise
        await self._publish(
            session,
            message_id,
            "message_started",
            {"content": normalized, "status": "queued", "role": "user"},
            0,
        )
        queue.put_nowait((message_id, normalized))
        return {
            "message_id": message_id,
            "status": "queued",
            "created_at": created_at,
        }

    async def _stop_engine(
        self,
        turn_id: str,
        task: asyncio.Task,
        engine: object,
    ) -> None:
        try:
            await engine.stop()
        except Exception:
            logger.exception(
                "Engine stop raised while stopping assistant turn %s",
                turn_id,
            )
        if not task.done():
            done, _ = await asyncio.wait(
                {task},
                timeout=SHUTDOWN_DRAIN_TIMEOUT_SECONDS,
            )
            if task not in done:
                task.cancel()

    def history(self, project_id: str, scope_key: str) -> dict | None:
        """Return the persisted conversation for a scoped session (or None)."""
        try:
            engine, model, fast_model = self._resolve_engine_models()
            vision_model = config_store.get_assistant_defaults(
                self._config.name
            ).get("vision_model", "") or None
        except ValueError:
            # 只读历史接口不因协调引擎未配置而失败：回退为尽力而为的元数据。
            engine, model, fast_model = "", None, None
            vision_model = None
        if self._config.persistence is None:
            return None
        with self._project_ctx(project_id):
            loaded = self._config.persistence.load_history(project_id, scope_key)
        if loaded is None:
            return None
        (
            restored_engine,
            restored_model,
            restored_fast,
            restored_vision,
            restored_engine_session_id,
            messages,
        ) = loaded
        engine = restored_engine or engine
        model = restored_model if restored_model is not None else model
        fast_model = restored_fast if restored_fast is not None else fast_model
        vision_model = (
            restored_vision if restored_vision is not None else vision_model
        )
        normalize = self._config.history_message or default_history_message
        return {
            "engine": engine,
            "model": model,
            "fast_model": fast_model,
            "vision_model": vision_model,
            "engine_session_id": restored_engine_session_id,
            "messages": [normalize(item) for item in messages],
        }

    def reset_scoped_session(
        self,
        project_id: str,
        scope_key: str,
        memory_key: tuple,
        session_id: str,
    ) -> bool:
        """Delete one idle scoped conversation from memory and persistence."""
        related_turn_ids = {
            turn_id
            for turn_id, state in self._turn_states.items()
            if state.get("session_id") == session_id
        }
        if any(
            self._turn_is_active(turn_id)
            for turn_id in related_turn_ids
        ):
            raise ValueError("Cannot reset a running assistant session")

        removed = self._sessions.pop(memory_key, None) is not None
        for turn_id in related_turn_ids:
            self._turn_states.pop(turn_id, None)
            self._turn_tasks.pop(turn_id, None)
            self._running_engines.pop(turn_id, None)
        self._turn_keys = {
            key: turn_id
            for key, turn_id in self._turn_keys.items()
            if turn_id not in related_turn_ids
        }

        if self._config.persistence is not None:
            with self._project_ctx(project_id):
                removed = self._config.persistence.delete(project_id, scope_key) or removed
        return removed

    def _turn_is_active(self, turn_id: str) -> bool:
        """Return whether a turn still has work that can actually execute."""
        state = self._turn_states.get(turn_id, {})
        status = state.get("status")
        if status not in {"queued", "running", "stopping"}:
            return False
        task = self._turn_tasks.get(turn_id)
        if task is not None:
            return not task.done()
        # A queued turn briefly exists before the API schedules its task.
        return status == "queued"

    async def shutdown(self) -> None:
        self._shutting_down = True
        for state in self._turn_states.values():
            if state.get("status") in {"queued", "running"}:
                state["status"] = "stopping"
        engines = [
            engine for engine in self._running_engines.values()
            if callable(getattr(engine, "stop", None))
        ]
        if engines:
            await asyncio.gather(
                *(engine.stop() for engine in engines),
                return_exceptions=True,
            )
        active_tasks = tuple(self._active_tasks)
        if active_tasks:
            done, _ = await asyncio.wait(
                active_tasks,
                timeout=SHUTDOWN_DRAIN_TIMEOUT_SECONDS,
            )
            for task in active_tasks:
                if task not in done:
                    task.cancel()
        for task in tuple(self._stop_tasks):
            task.cancel()
        tasks = active_tasks + tuple(self._stop_tasks)
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        if self._config.event_journal is not None:
            await self._config.event_journal.aclose()
        self._sessions.clear()
        self._turn_keys.clear()
        self._turn_states.clear()
        self._turn_tasks.clear()
        self._running_engines.clear()
        self._stop_tasks.clear()

    # ── session management ──────────────────────────────────────────────

    def _get_or_create_session(
        self,
        project_id: str,
        session_id: str,
        memory_key: tuple,
        scope_key: str | None,
        engine_id: str,
        model: str | None,
        fast_model: str | None,
        vision_model: str | None = None,
        steps: dict | None = None,
        engine_override: str | None = None,
        model_override: str | None = None,
        fast_model_override: str | None = None,
        vision_model_override: str | None = None,
        extra: dict | None = None,
    ) -> AssistantSession:
        self._prune_sessions()
        session = self._sessions.get(memory_key)
        if session is None:
            cwd = self._cwd(project_id)
            messages: list[dict] = []
            resolved: str | None = None
            restored_engine_state: Any = None
            restored_extra: dict = {}
            restored_engine, restored_model, restored_fast, restored_vision = (
                engine_id,
                model,
                fast_model,
                vision_model,
            )
            if self._config.persistence is not None:
                candidate = AssistantSession(
                    session_id=session_id,
                    project_id=project_id,
                    scope=self._config.scope,
                    scope_key=scope_key,
                    cwd=cwd,
                    engine=engine_id,
                    model=model,
                    fast_model=fast_model,
                    vision_model=vision_model,
                )
                with self._project_ctx(project_id):
                    self._config.persistence.load(candidate)
                messages = candidate.messages
                resolved = candidate.resolved_session_id
                restored_engine_state = candidate.engine_state
                restored_extra = dict(candidate.extra)
                restored_engine = candidate.engine or engine_id
                restored_model = (
                    candidate.model if candidate.model is not None else model
                )
                restored_fast = (
                    candidate.fast_model if candidate.fast_model is not None else fast_model
                )
                restored_vision = (
                    candidate.vision_model
                    if candidate.vision_model is not None
                    else vision_model
                )
            session = AssistantSession(
                session_id=session_id,
                project_id=project_id,
                scope=self._config.scope,
                scope_key=scope_key,
                cwd=cwd,
                engine=engine_override or restored_engine,
                model=(
                    model_override if model_override is not None else restored_model
                ),
                fast_model=(
                    fast_model_override
                    if fast_model_override is not None
                    else restored_fast
                ),
                vision_model=(
                    vision_model_override
                    if vision_model_override is not None
                    else restored_vision
                ),
                steps=steps,
                messages=messages,
                resolved_session_id=resolved,
                extra={**restored_extra, **dict(extra or {})},
                engine_state=restored_engine_state,
            )
            self._sessions[memory_key] = session
        else:
            if session.engine != (engine_override or engine_id):
                session.resolved_session_id = None
                session.engine_state = None
            session.engine = engine_override or engine_id
            session.model = (
                model_override if model_override is not None else model
            )
            session.fast_model = (
                fast_model_override
                if fast_model_override is not None
                else fast_model
            )
            session.vision_model = (
                vision_model_override
                if vision_model_override is not None
                else vision_model
            )
            if steps is not None:
                session.steps = steps
            session.extra.update(extra or {})
        return session

    def _prune_sessions(self) -> None:
        now = time.monotonic()
        stale = [
            key
            for key, session in self._sessions.items()
            if now - session.last_active > self._config.session_ttl_seconds
        ]
        for key in stale:
            self._sessions.pop(key, None)
        if len(self._sessions) > self._config.max_sessions:
            oldest = sorted(
                self._sessions.items(), key=lambda item: item[1].last_active
            )[: len(self._sessions) - self._config.max_sessions]
            for key, _ in oldest:
                self._sessions.pop(key, None)
        # Bound turn idempotency state (dicts preserve insertion order).
        if len(self._turn_states) > self._config.max_sessions * 5:
            overflow = len(self._turn_states) - self._config.max_sessions * 5
            for turn_id in list(self._turn_states)[:overflow]:
                self._turn_states.pop(turn_id, None)
        if len(self._turn_keys) > self._config.max_sessions * 5:
            overflow = len(self._turn_keys) - self._config.max_sessions * 5
            for key in list(self._turn_keys)[:overflow]:
                self._turn_keys.pop(key, None)

    def _resolve_engine_models(self) -> tuple[str, str | None, str | None]:
        resolver = self._config.resolve_engine_models
        if resolver is not None:
            return resolver()
        defaults = config_store.get_assistant_defaults(self._config.name)
        engine_id = defaults["engine"] or resolve_execution_engine(None)
        engine = create_engine(engine_id)
        if engine is None:
            raise ValueError(f"{self._config.engine_label} is unavailable: {engine_id}")
        return engine_id, defaults.get("model") or None, None

    def _project_ctx(self, project_id: str):
        """Activate the project DB context for persistence calls."""
        from contextlib import nullcontext

        if self._project_manager is None:
            return nullcontext()
        if not project_id:
            # Project-less sessions (e.g. flow-template editing) persist to
            # the daemon-global session store instead of a project DB.
            from services.global_sessions import global_sessions_ctx

            return global_sessions_ctx()
        return self._project_manager.activate_project_by_id(project_id)

    async def _await_maybe(self, value):
        if inspect.isawaitable(value):
            return await value
        return value

    def _cwd(self, project_id: str) -> str:
        resolver = self._config.cwd_resolver
        if resolver is not None:
            return resolver(self._project_manager, project_id)
        with self._project_manager.activate_project_by_id(project_id) as project:
            return str(project.path)

    def _build_prompt(self, session: AssistantSession) -> str:
        builder = self._config.build_prompt
        if builder is not None:
            return builder(session)
        engine = create_engine(session.engine)
        if engine is not None and engine.supports_resume:
            # 引擎侧维护会话上下文：历史不拼进 prompt。首轮带完整系统提示，
            # 续轮只发当前用户消息，避免重复污染引擎会话。
            user_message = next(
                (
                    str(item.get("content") or "")
                    for item in reversed(session.messages)
                    if item.get("role") == "user"
                ),
                "",
            )
            head = (
                self._config.system_prompt
                if not session.resolved_session_id
                else ""
            )
            return f"{head}\n\n{user_message}"
        # 无引擎侧会话的引擎（不支持 resume）：保留最近对话记录拼接。
        turns = [
            item for item in session.messages
            if not (item.get("role") == "assistant" and item.get("status") == "running")
        ][-self._config.max_history_turns * 2:]
        history = "\n\n".join(
            f"{'User' if item['role'] == 'user' else 'Assistant'}: {item['content']}"
            for item in turns
        )
        return (
            f"{self._config.system_prompt}"
            f"\n\nConversation history:\n{history}\n\nContinue."
        )

    def _system_prompt_for_display(self, session: AssistantSession) -> str:
        """Return the system instruction that remains effective for this session."""
        return self._config.system_prompt

    def _display_prompt(self, session: AssistantSession, prompt: str) -> str:
        """Return the complete effective prompt shown by ``查看提示词``.

        Resume-capable engines retain the system instruction in their session,
        so later wire prompts intentionally omit it.  The inspection view must
        still show that effective instruction without sending it again.
        """
        system_prompt = self._system_prompt_for_display(session).strip()
        if not system_prompt or prompt.lstrip().startswith(system_prompt):
            return prompt
        return f"{system_prompt}\n\n{prompt.lstrip()}"

    async def _on_engine_session_started(self, session: AssistantSession) -> None:
        """Assistant-specific hook after the target engine session starts."""
        return None

    # ── turn execution ──────────────────────────────────────────────────

    async def _run_turn(
        self,
        session: AssistantSession,
        turn_id: str,
        assistant_message_id: str,
    ) -> None:
        async with session.lock:
            session.last_active = time.monotonic()
            self._turn_states[turn_id]["status"] = "running"
            seq = 0
            prompt = ""
            _events: list[dict] = []
            assistant_message = next(
                item for item in session.messages
                if item.get("id") == assistant_message_id
            )
            started_at = str(assistant_message.get("created_at") or utc_now().isoformat())
            journal_ref = self._turn_states[turn_id].get("journal_ref")
            streamed_reply = ""
            structured_events: list[dict] = []
            active_message_id = [assistant_message_id]
            active_message = [assistant_message]
            active_started_at = [started_at]
            active_journal_ref = [journal_ref]
            active_segment_events: list[dict] = []
            live_split_count = [0]
            turn_persisted = [False]
            try:
                session.cwd = await asyncio.to_thread(self._cwd, session.project_id)
                prompt = await asyncio.to_thread(self._build_prompt, session)
                display_prompt = self._display_prompt(session, prompt)
                active_prompt = [display_prompt]
                user_messages = [
                    message
                    for message in session.messages
                    if message.get("role") == "user"
                ]
                if user_messages:
                    seq = await self._publish(
                        session,
                        turn_id,
                        "message_started",
                        {
                            "content": user_messages[-1].get("content", ""),
                            "status": "completed",
                            "role": "user",
                        },
                        seq,
                    )
                images: list[EngineImage] = []
                if user_messages and self._project_manager is not None:
                    def load_images() -> list[EngineImage]:
                        with self._project_ctx(session.project_id) as project:
                            return extract_uploaded_images(
                                project,
                                session.cwd,
                                str(user_messages[-1].get("content", "")),
                            )

                    images = await asyncio.to_thread(load_images)
                turn_model = (
                    session.vision_model or session.model
                    if images
                    else session.model
                )
                seq = await self._publish(
                    session,
                    assistant_message_id,
                    "message_started",
                    {"prompt": display_prompt},
                    seq,
                )
                seq_holder = [seq]
                extract_text = (
                    self._config.extract_streaming_text
                    or (lambda raw: raw)
                )

                # 思考增量聚合：token 级的思考/子代理增量在进日志与广播前合并为
                # 少量大事件（长回合中此类事件占比 ~90%，逐条下发会造成 WS 消息
                # 风暴与前端 store 每条事件复制一次数组）。emit_aggregated 与原
                # 逐条分支走完全相同的出口（journal + _publish + seq 递增）。
                thought_aggregator = ThoughtChunkAggregator()

                async def emit_aggregated(aggregated: dict) -> None:
                    await self._record_journal_event(active_journal_ref[0], aggregated)
                    await self._publish(
                        session,
                        active_message_id[0],
                        aggregated["type"],
                        aggregated["data"],
                        seq_holder[0],
                    )
                    seq_holder[0] += 1

                def make_live_callback(journaled_events: list[dict]):
                    raw_content = ""

                    async def publish_live_event(event: InternalEvent) -> None:
                        nonlocal raw_content, streamed_reply
                        if event.type == "session_started":
                            resolved = str(event.data.get("session_id") or "")
                            if resolved:
                                session.resolved_session_id = resolved
                                await self._on_engine_session_started(session)
                        elif event.type == "engine_state":
                            state = event.data.get("state")
                            if state is not None:
                                session.engine_state = state
                        event_dict = event.to_dict()
                        journaled_events.append(event_dict)
                        active_segment_events.append(event_dict)
                        # 可合并的思考增量进聚合器（预算达到才落日志/广播）；
                        # 其他事件先冲刷挂起的思考流，保证顺序与消息归属
                        # （下方 live-split 会切换 active_message_id）。
                        if thought_aggregator.is_mergeable(event_dict):
                            merged = thought_aggregator.offer(event_dict)
                            if merged is not None:
                                await emit_aggregated(merged)
                            return
                        for pending in thought_aggregator.flush():
                            await emit_aggregated(pending)
                        if is_commentary(event):
                            await self._record_journal_event(active_journal_ref[0], event_dict)
                            await self._publish(
                                session, active_message_id[0], event.type,
                                event.data, seq_holder[0],
                            )
                            seq_holder[0] += 1
                        elif event.type == "agent_message_chunk":
                            content_block = event.data.get("content") or {}
                            raw_content += str(content_block.get("text", ""))
                            partial_reply = extract_text(raw_content)
                            if not partial_reply.startswith(streamed_reply):
                                return
                            delta = partial_reply[len(streamed_reply):]
                            if not delta:
                                return
                            streamed_reply = partial_reply
                            await self._record_journal_event(
                                active_journal_ref[0],
                                {
                                    "type": "agent_message_chunk",
                                    "data": {**event.data, "content": {"text": delta}},
                                },
                            )
                            await self._publish(
                                session,
                                active_message_id[0],
                                "agent_message_chunk",
                                {**event.data, "content": {"text": delta}},
                                seq_holder[0],
                            )
                            seq_holder[0] += 1
                        elif event.type == "agent_thought_chunk":
                            await self._record_journal_event(active_journal_ref[0], event_dict)
                            await self._publish(
                                session,
                                active_message_id[0],
                                "agent_thought_chunk",
                                {"content": {"text": str(
                                    (event.data.get("content") or {}).get("text", "")
                                )}},
                                seq_holder[0],
                            )
                            seq_holder[0] += 1
                        elif event.type in {
                            "async_question",
                            "interaction_request",
                            "interaction_response",
                            "plan",
                            "plan_update",
                            "plan_removed",
                            "tool_call",
                            "tool_call_update",
                            "subagent",
                            "compacted",
                            "goal_update",
                            "session_started",
                        }:
                            await self._record_journal_event(
                                active_journal_ref[0],
                                event_dict,
                                force=event.type in {"interaction_request", "session_started"},
                            )
                            await self._publish(
                                session,
                                active_message_id[0],
                                event.type,
                                dict(event.data),
                                seq_holder[0],
                            )
                            seq_holder[0] += 1
                        elif event.type == "usage_update":
                            await self._record_journal_event(active_journal_ref[0], event_dict)
                            await self._publish(
                                session,
                                active_message_id[0],
                                "usage_update",
                                dict(event.data),
                                seq_holder[0],
                            )
                            seq_holder[0] += 1
                        elif event.type == "live_message":
                            live_message_id = str(
                                event.data.get("message_id") or ""
                            )
                            if live_message_id:
                                inserted = next(
                                    (
                                        item for item in session.messages
                                        if item.get("id") == live_message_id
                                    ),
                                    None,
                                )
                                if inserted is not None:
                                    inserted["status"] = (
                                        "succeeded"
                                        if event.data.get("status") == "delivered"
                                        else "error"
                                    )
                                    inserted["ended_at"] = utc_now().isoformat()
                                delivered = event.data.get("status") == "delivered"
                                if delivered:
                                    active_prompt[0] = str(
                                        (inserted or {}).get("content") or ""
                                    ).strip()
                                    ended_at = utc_now().isoformat()
                                    sealed = active_message[0]
                                    sealed.update({
                                        "role": "assistant",
                                        "content": streamed_reply,
                                        "status": "succeeded",
                                        "ended_at": ended_at,
                                    })
                                    await self._finish_journal(
                                        active_journal_ref[0],
                                        sealed,
                                        {"type": "status", "data": {"status": "succeeded"}},
                                    )
                                    await self._publish(
                                        session,
                                        active_message_id[0],
                                        "message_snapshot",
                                        {"content": streamed_reply},
                                        seq_holder[0],
                                    )
                                    seq_holder[0] += 1
                                    await self._publish(
                                        session,
                                        active_message_id[0],
                                        "message_completed",
                                        {
                                            "status": "succeeded",
                                            "content": streamed_reply,
                                            "ended_at": ended_at,
                                        },
                                        seq_holder[0],
                                    )
                                    seq_holder[0] += 1
                                await self._publish(
                                    session,
                                    live_message_id,
                                    "live_message",
                                    dict(event.data),
                                    seq_holder[0],
                                )
                                seq_holder[0] += 1
                                if delivered:
                                    next_message_id = str(uuid.uuid4())
                                    next_started_at = utc_now().isoformat()
                                    next_journal_ref = None
                                    if (
                                        self._config.event_journal is not None
                                        and active_journal_ref[0] is not None
                                    ):
                                        next_journal_ref = await self._config.event_journal.astart(
                                            active_journal_ref[0].root,
                                            session.session_id,
                                            next_message_id,
                                        )
                                    next_message = {
                                        "role": "assistant",
                                        "content": "",
                                        "id": next_message_id,
                                        "prompt": active_prompt[0],
                                        "engine": session.engine,
                                        "model": session.model,
                                        "author_id": session.engine or "assistant",
                                        "author_username": session.engine or "assistant",
                                        "author_name": session.engine or "助手",
                                        "author_type": "assistant",
                                        "initiated_by_user_id": (
                                            inserted.get("author_id") if inserted else None
                                        ),
                                        "initiated_by_username": (
                                            inserted.get("author_username") if inserted else None
                                        ),
                                        "status": "running",
                                        "created_at": next_started_at,
                                        "events": [],
                                        **{
                                            key: inserted[key]
                                            for key in (
                                                "author_device_id",
                                                "author_device_name",
                                            )
                                            if inserted is not None and inserted.get(key)
                                        },
                                        **(
                                            {
                                                "event_log_path": next_journal_ref.relative_path,
                                                "event_summary": {},
                                                "event_detail": {
                                                    "available": True,
                                                    "loaded": False,
                                                },
                                            }
                                            if next_journal_ref is not None
                                            else {}
                                        ),
                                    }
                                    session.messages.append(next_message)
                                    active_message_id[0] = next_message_id
                                    active_message[0] = next_message
                                    active_started_at[0] = next_started_at
                                    active_journal_ref[0] = next_journal_ref
                                    self._turn_states[turn_id][
                                        "assistant_message_id"
                                    ] = next_message_id
                                    raw_content = ""
                                    streamed_reply = ""
                                    active_segment_events.clear()
                                    live_split_count[0] += 1
                                    if self._project_manager is not None:
                                        previous_message_id = sealed["id"]

                                        def persist_split(_project):
                                            from models import PendingMessageInsert
                                            from models.base import db_proxy

                                            with db_proxy.atomic():
                                                PendingMessageInsert.update(
                                                    target_message_id=next_message_id,
                                                ).where(
                                                    PendingMessageInsert.target_message_id
                                                    == previous_message_id
                                                ).execute()
                                                if self._config.persistence is not None:
                                                    self._config.persistence.save(session)

                                        await self._project_manager.run_db(
                                            session.project_id,
                                            persist_split,
                                        )
                                    await self._publish(
                                        session,
                                        next_message_id,
                                        "message_started",
                                        {"prompt": active_prompt[0]},
                                        seq_holder[0],
                                    )
                                    seq_holder[0] += 1
                        else:
                            # Keep the host-side journal complete even when an
                            # event has no current AG-UI rendering path.
                            await self._record_journal_event(active_journal_ref[0], event_dict)

                    return publish_live_event

                journaled_events: list[dict] = []
                invoke_kwargs = {"message_history": session.engine_state}
                if images:
                    invoke_kwargs["images"] = images
                try:
                    raw, _events, resolved = await self._invoke(
                        session.engine,
                        turn_model,
                        session.cwd,
                        prompt,
                        session.resolved_session_id,
                        make_live_callback(journaled_events),
                        **invoke_kwargs,
                    )
                except RuntimeError as exc:
                    if (
                        not session.resolved_session_id
                        or not is_missing_codex_rollout_error(exc)
                    ):
                        raise
                    logger.warning(
                        "Engine session %s lost its rollout; rebuilding from history",
                        session.resolved_session_id,
                    )
                    rebuild_prompt = await asyncio.to_thread(
                        self._build_rebuild_prompt,
                        session,
                    )
                    raw, _events, resolved = await self._invoke(
                        session.engine,
                        turn_model,
                        session.cwd,
                        rebuild_prompt,
                        None,
                        make_live_callback(journaled_events),
                        **invoke_kwargs,
                    )
                # 回合结束：先冲刷聚合器里剩余的思考流，再补录非实时事件。
                for pending in thought_aggregator.flush():
                    await emit_aggregated(pending)
                await self._record_unstreamed_journal_events(
                    active_journal_ref[0], _events, journaled_events
                )
                if self._turn_states[turn_id]["status"] == "stopping":
                    raise asyncio.CancelledError
                session.resolved_session_id = resolved
                if resolved:
                    await self._on_engine_session_started(session)
                for engine_event in _events:
                    if engine_event.get("type") == "engine_state":
                        state = (engine_event.get("data") or {}).get("state")
                        if state is not None:
                            session.engine_state = state
                        break

                reply, structured, repair_events = await self._parse_response(
                    session, raw
                )
                if live_split_count[0] > 0 and not structured:
                    reply = streamed_reply
                for extra_event in repair_events:
                    await self._record_journal_event(active_journal_ref[0], extra_event)
                    await self._publish(
                        session,
                        active_message_id[0],
                        extra_event.get("type", "status"),
                        extra_event.get("data", {}),
                        seq_holder[0],
                    )
                    seq_holder[0] += 1
                if structured:
                    seq_holder[0], structured_events = await self._publish_structured(
                        session,
                        active_message_id[0],
                        reply,
                        structured,
                        seq_holder[0],
                    )
                    for structured_event in structured_events:
                        await self._record_journal_event(
                            active_journal_ref[0], structured_event
                        )
                active_message[0].update(
                    {
                        "role": "assistant",
                        "content": reply,
                        "id": active_message_id[0],
                        "engine": session.engine,
                        "model": session.model,
                        "status": "succeeded",
                        "created_at": active_started_at[0],
                        "ended_at": utc_now().isoformat(),
                        "prompt": active_prompt[0],
                        "events": _prune_events(active_segment_events)
                        + [
                            event
                            for event in repair_events
                            if isinstance(event, dict)
                            and event.get("type")
                            in _PERSISTED_EVENT_TYPES
                        ]
                        + [
                            event
                            for event in structured_events
                            if isinstance(event, dict)
                            and event.get("type")
                            in _PERSISTED_EVENT_TYPES
                        ],
                    }
                )
                await self._finish_journal(
                    active_journal_ref[0],
                    active_message[0],
                    {"type": "status", "data": {"status": "succeeded"}},
                )
                # 终态对外可见之前先落库最终快照：否则客户端可能在
                # message_completed / status=completed 之后、最终 save 之前
                # 读历史，拿到缺 engine_session_id 或旧消息的快照。
                turn_persisted[0] = await self._persist_session(session)
                seq_holder[0] = await self._publish(
                    session,
                    active_message_id[0],
                    "message_snapshot",
                    {"content": reply},
                    seq_holder[0],
                )
                seq_holder[0] = await self._publish(
                    session,
                    active_message_id[0],
                    "message_completed",
                    {"status": "succeeded", "content": reply},
                    seq_holder[0],
                )
                self._turn_states[turn_id]["status"] = "completed"
            except asyncio.CancelledError:
                ended_at = utc_now().isoformat()
                stopped_content = streamed_reply
                if self._shutting_down and not stopped_content:
                    stopped_content = "后台服务已重启，本次生成已中断。"
                active_message[0].update(
                    {
                        "role": "assistant",
                        "content": stopped_content,
                        "id": active_message_id[0],
                        "engine": session.engine,
                        "model": session.model,
                        "status": "stopped",
                        "created_at": active_started_at[0],
                        "ended_at": ended_at,
                        "prompt": active_prompt[0],
                        "events": _prune_events(active_segment_events),
                    }
                )
                await self._finish_journal(
                    active_journal_ref[0],
                    active_message[0],
                    {"type": "status", "data": {"status": "stopped"}},
                )
                turn_persisted[0] = await self._persist_session(session)
                try:
                    await self._publish(
                        session,
                        active_message_id[0],
                        "message_completed",
                        {
                            "status": "stopped",
                            "content": stopped_content,
                            "ended_at": ended_at,
                        },
                        seq_holder[0] if "seq_holder" in locals() else seq,
                    )
                except Exception:
                    pass
                self._turn_states[turn_id]["status"] = "stopped"
            except Exception as exc:
                if self._turn_states.get(turn_id, {}).get("status") == "stopping":
                    ended_at = utc_now().isoformat()
                    stopped_content = streamed_reply
                    if self._shutting_down and not stopped_content:
                        stopped_content = "后台服务已重启，本次生成已中断。"
                    active_message[0].update(
                        {
                            "role": "assistant",
                            "content": stopped_content,
                            "id": active_message_id[0],
                            "engine": session.engine,
                            "model": session.model,
                            "status": "stopped",
                            "created_at": active_started_at[0],
                            "ended_at": ended_at,
                            "prompt": active_prompt[0],
                            "events": _prune_events(active_segment_events),
                        }
                    )
                    await self._finish_journal(
                        active_journal_ref[0],
                        active_message[0],
                        {"type": "status", "data": {"status": "stopped"}},
                    )
                    turn_persisted[0] = await self._persist_session(session)
                    try:
                        await self._publish(
                            session,
                            active_message_id[0],
                            "message_completed",
                            {
                                "status": "stopped",
                                "content": stopped_content,
                                "ended_at": ended_at,
                            },
                            seq_holder[0] if "seq_holder" in locals() else seq,
                        )
                    except Exception:
                        pass
                    self._turn_states[turn_id]["status"] = "stopped"
                    return
                logger.exception(
                    "Assistant turn %s (%s) failed",
                    turn_id,
                    self._config.name,
                )
                active_message[0].update(
                    {
                        "role": "assistant",
                        "content": f"（生成失败：{exc}）",
                        "id": active_message_id[0],
                        "engine": session.engine,
                        "model": session.model,
                        "status": "error",
                        "created_at": active_started_at[0],
                        "ended_at": utc_now().isoformat(),
                        "prompt": active_prompt[0],
                        "events": _prune_events(active_segment_events),
                    }
                )
                await self._finish_journal(
                    active_journal_ref[0],
                    active_message[0],
                    {"type": "error", "data": {"message": str(exc)}},
                )
                turn_persisted[0] = await self._persist_session(session)
                try:
                    seq = await self._publish(
                        session,
                        active_message_id[0],
                        "error",
                        {"message": str(exc)},
                        seq,
                    )
                    await self._publish(
                        session,
                        active_message_id[0],
                        "message_completed",
                        {"status": "error", "content": str(exc)},
                        seq,
                    )
                except Exception:
                    pass
                self._turn_states[turn_id]["status"] = "error"
                self._turn_states[turn_id]["error"] = str(exc)
            finally:
                session.last_active = time.monotonic()
                # 兜底：各终态分支已在对外可见前落库；只有终态保存失败
                # （或被跳过）时才在这里重试一次，避免状态先于数据可见。
                if not turn_persisted[0]:
                    await self._persist_session(session)

    async def _persist_session(self, session: "AssistantSession") -> bool:
        """持久化会话快照；保存失败只记日志、不中断回合。

        Returns:
            保存是否执行成功（无持久化适配器时为 True，表示无需兜底）。
        """
        if self._config.persistence is None:
            return True
        if self._project_manager is None:
            return False
        try:
            await self._project_manager.run_db(
                session.project_id,
                lambda _project: self._config.persistence.save(session),
            )
            return True
        except Exception:
            logger.exception(
                "Failed to persist assistant session %s", session.session_id
            )
            return False

    async def _record_journal_event(
        self,
        ref: JournalRef | None,
        event: dict,
        *,
        force: bool = False,
    ) -> None:
        if ref is None or self._config.event_journal is None:
            return
        try:
            await self._config.event_journal.arecord(ref, event, force=force)
        except Exception:
            logger.exception("Failed to append assistant event journal")

    async def _record_unstreamed_journal_events(
        self,
        ref: JournalRef | None,
        returned_events: list[dict],
        journaled_events: list[dict],
    ) -> None:
        """Persist events returned by adapters that skipped the live callback."""
        unmatched = list(journaled_events)
        for event in returned_events:
            if event in unmatched:
                unmatched.remove(event)
            else:
                await self._record_journal_event(ref, event)

    async def _finish_journal(
        self,
        ref: JournalRef | None,
        message: dict,
        terminal_event: dict,
    ) -> None:
        if ref is None or self._config.event_journal is None:
            return
        try:
            await self._config.event_journal.afinish(ref, terminal_event)
            snapshot = await self._config.event_journal.asnapshot(ref)
            message["event_summary"] = snapshot["summary"]
            message["events"] = snapshot["events"]
            message["event_detail"] = {
                "available": True,
                "loaded": False,
                **snapshot["summary"],
            }
        except Exception:
            logger.exception("Failed to finalize assistant event journal")

    async def await_turn(
        self,
        turn_id: str,
        *,
        timeout: float | None = None,
    ) -> dict:
        """Wait for a queued/running turn to finish and return its final state.

        Headless callers (e.g. scheduled assistant runs) use this to await a
        turn that was submitted with ``submit_message``. Raises ``RuntimeError``
        when the turn failed or is no longer tracked; raises ``TimeoutError``
        when ``timeout`` elapses (the background turn keeps running).
        """
        task = self._turn_tasks.get(turn_id)
        if task is None:
            raise RuntimeError(f"Assistant turn is no longer tracked: {turn_id}")
        if timeout is not None:
            await asyncio.wait_for(asyncio.shield(task), timeout=timeout)
        else:
            await asyncio.shield(task)
        state = dict(self._turn_states.get(turn_id, {}))
        status = state.get("status")
        if status != "completed":
            raise RuntimeError(
                state.get("error") or f"Assistant turn did not complete: {status}"
            )
        return state

    async def _parse_response(
        self,
        session: AssistantSession,
        raw: str,
    ) -> tuple[str, list, list]:
        parser = self._config.parse_response
        if parser is not None:
            return await self._await_maybe(parser(session, raw))
        return raw, [], []

    async def _publish_structured(
        self,
        session: AssistantSession,
        assistant_message_id: str,
        reply: str,
        structured: list,
        seq: int,
    ) -> tuple[int, list[dict]]:
        """发布结构化结果；返回 (next_seq, 待持久化的事件字典列表)。"""
        publisher = self._config.publish_structured
        if publisher is not None:
            result = await self._await_maybe(
                publisher(session, assistant_message_id, reply, structured, seq)
            )
            if isinstance(result, tuple) and len(result) == 2:
                return int(result[0]), list(result[1])
            return int(result), []
        return seq, []

    async def _invoke(
        self,
        engine_id: str,
        model: str | None,
        cwd: str,
        prompt: str,
        session_id: str | None,
        on_event: Callable[[InternalEvent], Awaitable[None]] | None = None,
        message_history: list | None = None,
        images: list[EngineImage] | None = None,
    ) -> tuple[str, list[dict], str | None]:
        current_task = asyncio.current_task()
        run_key = next(
            (
                turn_id
                for turn_id, task in self._turn_tasks.items()
                if task is current_task
            ),
            None,
        )
        thinking_effort = (
            self._turn_states.get(run_key, {}).get("thinking_effort")
            if run_key
            else None
        )
        permission_mode = (
            self._turn_states.get(run_key, {}).get("permission_mode")
            if run_key
            else None
        )
        plan_mode = (
            self._turn_states.get(run_key, {}).get("plan_mode")
            if run_key
            else None
        )
        goal_mode = (
            self._turn_states.get(run_key, {}).get("goal_mode")
            if run_key
            else None
        )
        turn_state = self._turn_states.get(run_key, {}) if run_key else {}
        turn_provider = turn_state.get("provider_id")
        if turn_provider or turn_state.get("engine_overridden"):
            provider_id = turn_provider or ""
        else:
            defaults = await asyncio.to_thread(
                config_store.get_assistant_defaults, self._config.name
            )
            provider_id = defaults.get("provider_id", "")
        config_overrides = (
            {"provider_id": provider_id} if provider_id else None
        )
        return await invoke_engine(
            engine_id,
            model,
            cwd,
            prompt,
            session_id,
            on_event,
            error_prefix=self._config.engine_label,
            message_history=message_history,
            images=images,
            report_engine_state=True,
            run_key=run_key,
            running_engines=self._running_engines,
            thinking_effort=thinking_effort,
            permission_mode=permission_mode,
            plan_mode=plan_mode,
            goal_mode=goal_mode,
            workstep_tools=self._config.workstep_tools,
            config_overrides=config_overrides,
            live_message_queue=turn_state.get("live_message_queue"),
        )

    def _build_rebuild_prompt(self, session: AssistantSession) -> str:
        """Build a stateless prompt after an engine session was lost."""
        turns = [
            item
            for item in session.messages
            if not (
                item.get("role") == "assistant"
                and item.get("status") == "running"
            )
        ][-self._config.max_history_turns * 2:]
        history = "\n\n".join(
            f"{'User' if item['role'] == 'user' else 'Assistant'}: {item['content']}"
            for item in turns
        )
        return (
            f"{self._config.system_prompt}"
            f"\n\nConversation history:\n{history}\n\nContinue."
        )

    async def _publish(
        self,
        session: AssistantSession,
        assistant_message_id: str,
        event_type: str,
        data: dict,
        event_sequence: int,
    ) -> int:
        """发布出口：内部事件 → AG-UI 标准事件后推送。"""
        payload = {
            "event_id": str(uuid.uuid4()),
            "project_id": session.project_id,
            "session_id": session.session_id,
            "channel": self._config.channel,
            "message_id": assistant_message_id,
            "engine": session.engine,
            "model": session.model,
            "event_sequence": event_sequence,
            "type": event_type,
            # 广播出口截断超大工具载荷（30MB 级 raw_output 会冻结浏览器）；
            # JSONL 日志走 _record_journal_event，独立于本路径，保留全量。
            "data": truncate_large_tool_payloads(data),
            "created_at": utc_now().isoformat(),
        }
        actor = get_effective_actor()
        if actor is not None:
            payload["actor"] = {
                "id": actor.actor_id,
                "name": actor.user_name,
                "device_id": actor.device_id,
                "device_name": actor.device_name,
            }
        elif data.get("role") == "user":
            message_id = str(payload.get("message_id") or "")
            stored = next(
                (item for item in session.messages if item.get("id") == message_id),
                None,
            )
            if stored and str(stored.get("role") or "") == "user":
                author_id = str(stored.get("author_id") or "").strip()
                author_name = str(stored.get("author_name") or "").strip()
                if author_id and author_name:
                    payload["actor"] = {
                        "id": author_id,
                        "name": author_name,
                        "device_id": str(stored.get("author_device_id") or author_id),
                        "device_name": str(stored.get("author_device_name") or ""),
                    }
        ctx = AGUIContext.from_event(payload)
        for agui_event in to_agui_events(payload, ctx):
            await self._event_bus.publish(agui_event)
        return event_sequence + 1

    def _consume_background(self, task: asyncio.Task, turn_id: str) -> None:
        self._active_tasks.discard(task)
        self._turn_tasks.pop(turn_id, None)
        if not task.cancelled():
            task.exception()

    def _consume_stop_task(self, task: asyncio.Task) -> None:
        self._stop_tasks.discard(task)
        if not task.cancelled():
            task.exception()


class AssistantRegistry:
    """Registry of assistant configurations — "add an assistant = add config"."""

    def __init__(self) -> None:
        self._configs: dict[str, AssistantConfig] = {}

    def register(self, config: AssistantConfig) -> None:
        self._configs[config.name] = config

    def get(self, name: str) -> AssistantConfig | None:
        return self._configs.get(name)

    def require(self, name: str) -> AssistantConfig:
        config = self._configs.get(name)
        if config is None:
            raise KeyError(f"Assistant is not registered: {name}")
        return config

    def all(self) -> list[AssistantConfig]:
        return list(self._configs.values())

    def names(self) -> list[str]:
        return list(self._configs.keys())


assistant_registry = AssistantRegistry()
