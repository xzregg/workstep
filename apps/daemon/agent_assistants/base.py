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
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Protocol

from engines.core.agui import AGUIContext, to_agui_events
from engines.core.events import InternalEvent
from engines.core.registry import create_engine
from models.fields import utc_now
from services.chat_permissions import (
    is_valid_permission_mode,
    map_permission_overrides,
    map_plan_mode_overrides,
    PLAN_MODE_INSTRUCTION,
)
from services.intervention import intervention_manager
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
    report_engine_state: bool = False,
    thinking_effort: str | None = None,
    permission_mode: str | None = None,
    plan_mode: bool | None = None,
) -> tuple[str, list[dict], str | None]:
    """Run one engine turn; stream events; return (text, events, session_id).

    Shared by every assistant. ``spawner`` defaults to ``engine.spawn``;
    task-style assistants may pass a custom spawner (e.g.
    ``spawn_coordinator``, closing over its own images). When
    ``running_engines`` is given, the engine instance is tracked under
    ``run_key`` so callers can stop it.
    """
    engine = create_engine(engine_id)
    if engine is None:
        raise RuntimeError(f"{error_prefix} is unavailable: {engine_id}")
    if plan_mode:
        prompt = f"{prompt}\n\n{PLAN_MODE_INSTRUCTION}"
    content: list[str] = []
    events: list[dict] = []
    resolved_session_id = session_id
    error: str | None = None
    try:
        if running_engines is not None and run_key is not None:
            running_engines[run_key] = engine
        spawn_kwargs: dict[str, object] = {}
        if engine.supports_message_history:
            if message_history is not None:
                spawn_kwargs["message_history"] = message_history
            if report_engine_state:
                spawn_kwargs["report_engine_state"] = True
        if (
            getattr(
                getattr(engine, "capabilities", None),
                "supports_thinking_effort",
                False,
            )
            and thinking_effort
        ):
            spawn_kwargs["thinking_effort"] = thinking_effort
        if permission_mode:
            overrides = map_permission_overrides(engine_id, permission_mode)
            if overrides:
                spawn_kwargs["config_overrides"] = overrides
        if plan_mode:
            overrides = map_plan_mode_overrides(engine_id)
            if overrides:
                spawn_kwargs["config_overrides"] = {
                    **(
                        spawn_kwargs.get("config_overrides") or {}
                    ),
                    **overrides,
                }
        if spawner is None:
            iterator = engine.spawn(
                prompt=prompt,
                cwd=cwd,
                model=model,
                session_id=session_id if engine.supports_resume else None,
                **spawn_kwargs,
            )
        else:
            iterator = spawner(engine)
        async for event in iterator:
            normalize_event = getattr(
                engine,
                "normalize_event",
                getattr(engine, "normalize_interaction_event", None),
            )
            if normalize_event is not None:
                event = normalize_event(event)
            if event is None:
                continue
            interaction_waiter: asyncio.Task | None = None
            if event.type == "interaction_request":
                interaction_id = str(
                    event.data.get("interaction_id") or uuid.uuid4()
                )
                event.data["interaction_id"] = interaction_id
                interaction_waiter = asyncio.create_task(
                    intervention_manager.request_response(
                        interaction_id,
                        run_key or engine_id,
                        "assistant",
                        event.data,
                    )
                )
                # Register before publishing to avoid a fast-response race.
                await asyncio.sleep(0)
            events.append(event.to_dict())
            if on_event is not None:
                await on_event(event)
            if event.type == "agent_message_chunk":
                content_block = event.data.get("content") or {}
                content.append(str(content_block.get("text", "")))
            elif event.type == "session_started":
                resolved_session_id = (
                    str(event.data.get("session_id") or "") or None
                )
            elif event.type == "usage_update" and event.data.get("session_id"):
                resolved_session_id = str(event.data["session_id"])
            elif event.type == "error" and error is None:
                error = str(event.data.get("message") or f"{error_prefix} failed")
            if interaction_waiter is not None:
                response = await interaction_waiter
                if response.get("error"):
                    response = (
                        {"outcome": {"outcome": "cancelled"}}
                        if event.data.get("method") == "session/request_permission"
                        else {"action": "cancel"}
                    )
                await engine.respond_interaction(event.data, response)
                response_event = InternalEvent(
                    type="interaction_response",
                    data={
                        "interaction_id": event.data["interaction_id"],
                        "method": event.data.get("method"),
                        "response": response,
                    },
                )
                events.append(response_event.to_dict())
                if on_event is not None:
                    await on_event(response_event)
    finally:
        if running_engines is not None and run_key is not None:
            running_engines.pop(run_key, None)
    if (
        resolved_session_id is None
        and assign_session_on_no_resume
        and not engine.supports_resume
    ):
        resolved_session_id = str(uuid.uuid4())
    if error:
        raise RuntimeError(error)
    return "".join(content).strip(), events, resolved_session_id


@dataclass
class AssistantSession:
    """One in-memory assistant conversation."""

    session_id: str
    project_id: str
    scope: str
    scope_key: str | None = None
    cwd: str = ""
    engine: str = ""
    model: str | None = None
    fast_model: str | None = None
    resolved_session_id: str | None = None
    messages: list[dict] = field(default_factory=list)
    steps: dict | None = None
    extra: dict = field(default_factory=dict)
    engine_state: Any = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    last_active: float = field(default_factory=time.monotonic)


@dataclass(frozen=True, slots=True)
class AcceptedTurn:
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


class PersistenceAdapter(Protocol):
    """Optional conversation persistence for a scoped assistant session."""

    def load(self, session: AssistantSession) -> None: ...

    def save(self, session: AssistantSession) -> None: ...

    def load_history(
        self,
        project_id: str,
        scope_key: str,
    ) -> tuple[str, str | None, str | None, str | None, list[dict]] | None:
        """Return (engine, model, fast_model, engine_session_id, messages)."""
        ...

    def delete(self, project_id: str, scope_key: str) -> bool: ...


class MemoryPersistence:
    """No-op persistence — conversations live only in memory."""

    def load(self, session: AssistantSession) -> None:
        return None

    def save(self, session: AssistantSession) -> None:
        return None

    def load_history(
        self,
        project_id: str,
        scope_key: str,
    ) -> None:
        return None

    def delete(self, project_id: str, scope_key: str) -> bool:
        return False


class JsonRowPersistence:
    """Persist a conversation as a JSON blob on a peewee model.

    The model is expected to expose: ``id``, ``project_id``, the scope field
    (e.g. ``workflow_id``), ``engine``, ``model``, ``fast_model``,
    ``engine_session_id``, ``messages_json``, ``cwd`` and UTC timestamps —
    ``models/gen_session.WorkflowGenSession`` is the reference shape.
    """

    def __init__(
        self,
        model,
        scope_field: str,
        make_id: Callable[[str, str], str],
    ):
        self._model = model
        self._scope_field = scope_field
        self._make_id = make_id

    def _row(self, project_id: str, scope_key: str):
        query = (self._model.project_id == project_id) & (
            getattr(self._model, self._scope_field) == scope_key
        )
        return self._model.get_or_none(query)

    def load(self, session: AssistantSession) -> None:
        if not session.scope_key:
            return
        row = self._row(session.project_id, session.scope_key)
        if row is None:
            return
        session.messages = _restore_messages(row.messages_json)
        session.resolved_session_id = row.engine_session_id
        if row.engine_state_json:
            try:
                session.engine_state = json.loads(row.engine_state_json)
            except json.JSONDecodeError:
                logger.exception("Failed to restore engine state")
        session.engine = row.engine or session.engine
        if row.model is not None:
            session.model = row.model
        if row.fast_model is not None:
            session.fast_model = row.fast_model
        if row.cwd:
            session.cwd = row.cwd

    @staticmethod
    def _dump_state(state: Any) -> str | None:
        if state is None:
            return None
        try:
            return json.dumps(state, ensure_ascii=False)
        except Exception:
            logger.exception("Failed to serialize engine state")
            return None

    def save(self, session: AssistantSession) -> None:
        if not session.scope_key:
            return
        try:
            now = utc_now()
            payload = json.dumps(session.messages, ensure_ascii=False)
            row = self._row(session.project_id, session.scope_key)
            if row is None:
                self._model.create(
                    id=self._make_id(session.project_id, session.scope_key),
                    project_id=session.project_id,
                    **{self._scope_field: session.scope_key},
                    engine=session.engine,
                    model=session.model,
                    fast_model=session.fast_model,
                    engine_session_id=session.resolved_session_id,
                    engine_state_json=self._dump_state(session.engine_state),
                    messages_json=payload,
                    cwd=session.cwd,
                    created_at=now,
                    updated_at=now,
                )
            else:
                    row.engine = session.engine
                    row.model = session.model
                    row.fast_model = session.fast_model
                    row.engine_session_id = session.resolved_session_id
                    row.engine_state_json = self._dump_state(session.engine_state)
                    row.messages_json = payload
                    row.cwd = session.cwd
                    row.updated_at = now
                    row.save()
        except Exception:
            logger.exception("Failed to persist assistant session")

    def load_history(
        self,
        project_id: str,
        scope_key: str,
    ) -> tuple[str, str | None, str | None, str | None, list[dict]] | None:
        row = self._row(project_id, scope_key)
        if row is None:
            return None
        return (
            row.engine,
            row.model,
            row.fast_model,
            row.engine_session_id,
            _restore_messages(row.messages_json),
        )

    def delete(self, project_id: str, scope_key: str) -> bool:
        query = (self._model.project_id == project_id) & (
            getattr(self._model, self._scope_field) == scope_key
        )
        return self._model.delete().where(query).execute() > 0


def _restore_messages(raw: str | None) -> list[dict]:
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return []
    if not isinstance(parsed, list):
        return []
    return [
        item
        for item in parsed
        if isinstance(item, dict) and item.get("role") in {"user", "assistant"}
    ]


_PERSISTED_EVENT_TYPES = frozenset({
    "status",
    "agent_thought_chunk",
    "tool_call",
    "tool_call_update",
    "interaction_request",
    "interaction_response",
    "plan",
    "plan_update",
    "plan_removed",
    "subagent",
    "compacted",
    "usage_update",
    "session_started",
    "error",
    "engine_state",
    "a2ui",
    "acp_raw",
    "elicitation_completed",
})


def _prune_events(events: list[dict]) -> list[dict]:
    """Keep replayable engine events; drop per-character text deltas."""
    return [
        event
        for event in events
        if isinstance(event, dict) and event.get("type") in _PERSISTED_EVENT_TYPES
    ]


def default_history_message(item: dict) -> dict:
    """Normalize one stored message for the history API."""
    events = []
    for event in item.get("events") or []:
        if not isinstance(event, dict):
            continue
        normalized = {
            "type": event.get("type"),
            "data": event.get("data") or {},
        }
        timestamp = event.get("timestamp") or event.get("created_at")
        if timestamp is not None:
            normalized["timestamp"] = timestamp
        events.append(normalized)
    return {
        "id": item.get("id") or str(uuid.uuid4()),
        "role": item.get("role", "assistant"),
        "content": item.get("content", ""),
        "status": (
            item.get("status")
            if item.get("status") in ("error", "stopped")
            else "succeeded"
        ),
        "engine": item.get("engine"),
        "model": item.get("model"),
        "created_at": item.get("created_at"),
        "ended_at": item.get("ended_at"),
        "prompt": item.get("prompt"),
        "events": events,
    }


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
        thinking_effort: str | None = None,
        permission_mode: str | None = None,
        plan_mode: bool | None = None,
        steps: dict | None = None,
        extra: dict | None = None,
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
        if normalized_effort not in ("", "minimal", "low", "medium", "high"):
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
            engine_id = engine
        model = model or default_model
        fast_model = fast_model or default_fast_model
        session = self._get_or_create_session(
            project_id,
            session_id,
            memory_key,
            scope_key,
            engine_id,
            model,
            fast_model,
            steps,
            engine_override=engine,
            model_override=model,
            fast_model_override=fast_model,
            extra=extra,
        )

        turn_id = str(uuid.uuid4())
        assistant_message_id = str(uuid.uuid4())
        session.messages.append(
            {
                "role": "user",
                "content": normalized,
                "id": turn_id,
                "created_at": utc_now().isoformat(),
            }
        )
        self._turn_keys[key] = turn_id
        self._turn_states[turn_id] = {
            "status": "queued",
            "assistant_message_id": assistant_message_id,
            "session_id": session.session_id,
            "thinking_effort": normalized_effort or None,
            "permission_mode": normalized_permission or None,
            "plan_mode": bool(plan_mode),
        }
        background = asyncio.create_task(
            self._run_turn(session, turn_id, assistant_message_id),
            name=f"assistant-{self._config.name}:{turn_id}",
        )
        self._active_tasks.add(background)
        self._turn_tasks[turn_id] = background
        background.add_done_callback(
            lambda task, active_turn_id=turn_id: self._consume_background(
                task, active_turn_id
            )
        )
        return AcceptedTurn(
            session_id=session.session_id,
            turn_id=turn_id,
            assistant_message_id=assistant_message_id,
            status="queued",
        )

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
                return False
            state["status"] = "stopping"
            engine = self._running_engines.get(turn_id)
            task.cancel()
            if engine is not None:
                cleanup = asyncio.create_task(
                    self._stop_engine(turn_id, task, engine),
                    name=f"assistant-stop-{self._config.name}:{turn_id}",
                )
                self._stop_tasks.add(cleanup)
                cleanup.add_done_callback(self._consume_stop_task)
            return True
        return False

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
            task.cancel()

    def history(self, project_id: str, scope_key: str) -> dict | None:
        """Return the persisted conversation for a scoped session (or None)."""
        try:
            engine, model, fast_model = self._resolve_engine_models()
        except ValueError:
            # 只读历史接口不因协调引擎未配置而失败：回退为尽力而为的元数据。
            engine, model, fast_model = "", None, None
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
            restored_engine_session_id,
            messages,
        ) = loaded
        engine = restored_engine or engine
        model = restored_model if restored_model is not None else model
        fast_model = restored_fast if restored_fast is not None else fast_model
        normalize = self._config.history_message or default_history_message
        return {
            "engine": engine,
            "model": model,
            "fast_model": fast_model,
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
            self._turn_states[turn_id].get("status")
            in {"queued", "running", "stopping"}
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

    async def shutdown(self) -> None:
        tasks = tuple(self._active_tasks | self._stop_tasks)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
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
        steps: dict | None = None,
        engine_override: str | None = None,
        model_override: str | None = None,
        fast_model_override: str | None = None,
        extra: dict | None = None,
    ) -> AssistantSession:
        self._prune_sessions()
        session = self._sessions.get(memory_key)
        if session is None:
            cwd = self._cwd(project_id)
            messages: list[dict] = []
            resolved: str | None = None
            restored_engine_state: Any = None
            restored_engine, restored_model, restored_fast = (
                engine_id,
                model,
                fast_model,
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
                )
                with self._project_ctx(project_id):
                    self._config.persistence.load(candidate)
                messages = candidate.messages
                resolved = candidate.resolved_session_id
                restored_engine_state = candidate.engine_state
                restored_engine = candidate.engine or engine_id
                restored_model = (
                    candidate.model if candidate.model is not None else model
                )
                restored_fast = (
                    candidate.fast_model if candidate.fast_model is not None else fast_model
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
                steps=steps,
                messages=messages,
                resolved_session_id=resolved,
                extra=dict(extra or {}),
                engine_state=restored_engine_state,
            )
            self._sessions[memory_key] = session
        else:
            if session.engine != (engine_override or engine_id):
                session.resolved_session_id = None
            session.engine = engine_override or engine_id
            session.model = (
                model_override if model_override is not None else model
            )
            session.fast_model = (
                fast_model_override
                if fast_model_override is not None
                else fast_model
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
        engine_id = "claude"
        engine = create_engine(engine_id)
        if engine is None:
            raise ValueError(f"{self._config.engine_label} is unavailable: {engine_id}")
        return engine_id, None, None

    def _project_ctx(self, project_id: str):
        """Activate the project DB context for persistence calls."""
        from contextlib import nullcontext

        if self._project_manager is None:
            return nullcontext()
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
            user_message = (
                session.messages[-1]["content"] if session.messages else ""
            )
            head = (
                self._config.system_prompt
                if not session.resolved_session_id
                else ""
            )
            return f"{head}\n\n{user_message}"
        # 无引擎侧会话的引擎（不支持 resume）：保留最近对话记录拼接。
        turns = session.messages[-self._config.max_history_turns * 2:]
        history = "\n\n".join(
            f"{'用户' if item['role'] == 'user' else '助手'}：{item['content']}"
            for item in turns
        )
        return (
            f"{self._config.system_prompt}"
            f"\n\n历史对话：\n{history}\n\n请继续。"
        )

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
            started_at = utc_now().isoformat()
            streamed_reply = ""
            try:
                session.cwd = self._cwd(session.project_id)
                prompt = self._build_prompt(session)
                seq = await self._publish(
                    session,
                    assistant_message_id,
                    "message_started",
                    {"prompt": prompt},
                    seq,
                )
                seq_holder = [seq]
                extract_text = (
                    self._config.extract_streaming_text
                    or (lambda raw: raw)
                )

                def make_live_callback():
                    raw_content = ""

                    async def publish_live_event(event: InternalEvent) -> None:
                        nonlocal raw_content, streamed_reply
                        if event.type == "agent_message_chunk":
                            content_block = event.data.get("content") or {}
                            raw_content += str(content_block.get("text", ""))
                            partial_reply = extract_text(raw_content)
                            if not partial_reply.startswith(streamed_reply):
                                return
                            delta = partial_reply[len(streamed_reply):]
                            if not delta:
                                return
                            streamed_reply = partial_reply
                            await self._publish(
                                session,
                                assistant_message_id,
                                "agent_message_chunk",
                                {"content": {"text": delta}},
                                seq_holder[0],
                            )
                            seq_holder[0] += 1
                        elif event.type == "agent_thought_chunk":
                            await self._publish(
                                session,
                                assistant_message_id,
                                "agent_thought_chunk",
                                {"content": {"text": str(
                                    (event.data.get("content") or {}).get("text", "")
                                )}},
                                seq_holder[0],
                            )
                            seq_holder[0] += 1
                        elif event.type in {
                            "interaction_request",
                            "interaction_response",
                            "plan",
                            "plan_update",
                            "plan_removed",
                            "tool_call",
                            "tool_call_update",
                            "subagent",
                            "session_started",
                        }:
                            await self._publish(
                                session,
                                assistant_message_id,
                                event.type,
                                dict(event.data),
                                seq_holder[0],
                            )
                            seq_holder[0] += 1
                        elif event.type == "usage_update":
                            await self._publish(
                                session,
                                assistant_message_id,
                                "usage_update",
                                dict(event.data),
                                seq_holder[0],
                            )
                            seq_holder[0] += 1

                    return publish_live_event

                raw, _events, resolved = await self._invoke(
                    session.engine,
                    session.model,
                    session.cwd,
                    prompt,
                    session.resolved_session_id,
                    make_live_callback(),
                    message_history=session.engine_state,
                )
                if self._turn_states[turn_id]["status"] == "stopping":
                    raise asyncio.CancelledError
                session.resolved_session_id = resolved
                for engine_event in _events:
                    if engine_event.get("type") == "engine_state":
                        state = (engine_event.get("data") or {}).get("state")
                        if state is not None:
                            session.engine_state = state
                        break

                reply, structured, repair_events = await self._parse_response(
                    session, raw
                )
                for extra_event in repair_events:
                    await self._publish(
                        session,
                        assistant_message_id,
                        extra_event.get("type", "status"),
                        extra_event.get("data", {}),
                        seq_holder[0],
                    )
                    seq_holder[0] += 1
                if structured:
                    seq_holder[0] = await self._publish_structured(
                        session,
                        assistant_message_id,
                        reply,
                        structured,
                        seq_holder[0],
                    )
                seq_holder[0] = await self._publish(
                    session,
                    assistant_message_id,
                    "message_snapshot",
                    {"content": reply},
                    seq_holder[0],
                )
                seq_holder[0] = await self._publish(
                    session,
                    assistant_message_id,
                    "message_completed",
                    {"status": "succeeded", "content": reply},
                    seq_holder[0],
                )
                session.messages.append(
                    {
                        "role": "assistant",
                        "content": reply,
                        "id": assistant_message_id,
                        "engine": session.engine,
                        "model": session.model,
                        "created_at": utc_now().isoformat(),
                        "prompt": prompt,
                        "events": _prune_events(_events)
                        + [
                            event
                            for event in repair_events
                            if isinstance(event, dict)
                            and event.get("type")
                            in _PERSISTED_EVENT_TYPES
                        ],
                    }
                )
                self._turn_states[turn_id]["status"] = "completed"
            except asyncio.CancelledError:
                ended_at = utc_now().isoformat()
                session.messages.append(
                    {
                        "role": "assistant",
                        "content": streamed_reply,
                        "id": assistant_message_id,
                        "engine": session.engine,
                        "model": session.model,
                        "status": "stopped",
                        "created_at": started_at,
                        "ended_at": ended_at,
                        "prompt": prompt,
                        "events": _prune_events(_events),
                    }
                )
                try:
                    await self._publish(
                        session,
                        assistant_message_id,
                        "message_completed",
                        {
                            "status": "stopped",
                            "content": streamed_reply,
                            "ended_at": ended_at,
                        },
                        seq_holder[0] if "seq_holder" in locals() else seq,
                    )
                except Exception:
                    pass
                self._turn_states[turn_id]["status"] = "stopped"
            except Exception as exc:
                logger.exception(
                    "Assistant turn %s (%s) failed",
                    turn_id,
                    self._config.name,
                )
                session.messages.append(
                    {
                        "role": "assistant",
                        "content": f"（生成失败：{exc}）",
                        "id": assistant_message_id,
                        "engine": session.engine,
                        "model": session.model,
                        "status": "error",
                        "created_at": utc_now().isoformat(),
                        "prompt": prompt,
                        "events": _prune_events(_events),
                    }
                )
                try:
                    seq = await self._publish(
                        session,
                        assistant_message_id,
                        "error",
                        {"message": str(exc)},
                        seq,
                    )
                    await self._publish(
                        session,
                        assistant_message_id,
                        "message_completed",
                        {"status": "error", "content": str(exc)},
                        seq,
                    )
                except Exception:
                    pass
                self._turn_states[turn_id]["status"] = "error"
            finally:
                session.last_active = time.monotonic()
                if self._config.persistence is not None:
                    with self._project_ctx(session.project_id):
                        self._config.persistence.save(session)

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
    ) -> int:
        publisher = self._config.publish_structured
        if publisher is not None:
            return await self._await_maybe(
                publisher(session, assistant_message_id, reply, structured, seq)
            )
        return seq

    async def _invoke(
        self,
        engine_id: str,
        model: str | None,
        cwd: str,
        prompt: str,
        session_id: str | None,
        on_event: Callable[[InternalEvent], Awaitable[None]] | None = None,
        message_history: list | None = None,
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
        return await invoke_engine(
            engine_id,
            model,
            cwd,
            prompt,
            session_id,
            on_event,
            error_prefix=self._config.engine_label,
            message_history=message_history,
            report_engine_state=True,
            run_key=run_key,
            running_engines=self._running_engines,
            thinking_effort=thinking_effort,
            permission_mode=permission_mode,
            plan_mode=plan_mode,
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
            "session_id": session.session_id,
            "channel": self._config.channel,
            "message_id": assistant_message_id,
            "engine": session.engine,
            "model": session.model,
            "event_sequence": event_sequence,
            "type": event_type,
            "data": data,
            "created_at": utc_now().isoformat(),
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
