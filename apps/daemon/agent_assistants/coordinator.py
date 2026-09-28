"""Engine-backed task coordinator conversation module."""

import asyncio
import json
import logging
import re
import uuid
from dataclasses import dataclass
from typing import Awaitable, Callable

from engines.core.agui import AGUIContext, to_agui_events
from engines.core.events import InternalEvent, is_commentary
from engines.core.registry import (
    COORDINATOR_FALLBACK_ORDER,
    create_engine,
    get_available_engines,
)
from engines.core.schema import EngineImage
from agent_assistants.base import (
    AssistantConfig,
    SCOPE_TASK,
    assistant_registry,
    extract_uploaded_images,
    extract_streaming_reply,  # re-exported for back-compat
    invoke_engine,
)
from agent_assistants.archive_experience import (
    ArchiveExperienceDraftService,
    ArchiveExperienceStopped,
)
from agent_assistants.coordinator_actions import CoordinatorActionService
from agent_assistants.event_journal import JournalRef, TurnEventJournal
from agent_assistants.coordinator_context import (
    COORDINATOR_CHANNEL,
    artifact_index,
    assemble_context,
    coordinator_root as project_coordinator_root,
)
from models import (
    ActionProposal,
    CoordinatorSession,
    CoordinatorTurn,
    Message,
    PendingMessageInsert,
    Task,
    TaskStep,
)
from models.base import db_proxy
from models.fields import utc_now
from services.config import (
    CODEX_REASONING_EFFORTS,
    DEFAULT_EXECUTION_ENGINE,
    config_store,
)
from services.messages import (
    allocate_message_sequences,
    current_actor_message_fields,
    new_message_id,
)
from services.pending_message_inserts import (
    delete_pending_insert_batch,
    pending_insert_actor,
    pending_insert_batch,
)
from services.remote_access import replayed_actor_context
from services.remote_access import require_user_actor
from services.intervention import intervention_manager
from services.messages import extract_usage_json
from services.remote_project import current_actor_event_fields
from streaming.bus import EventBus

logger = logging.getLogger(__name__)

COORDINATOR_RECONCILE_SECONDS = 15.0
COORDINATOR_STOP_TIMEOUT_SECONDS = 10.0

# Registered in the shared assistant registry: the task coordinator is one
# assistant, described declaratively (its task-specific conversation logic
# lives in CoordinatorModule below). It loads the WorkStep internal tools:
# the agent may inspect projects/tasks via the daemon, but never executes
# anything itself (read-only guard + confirm-gated mutating tools).
COORDINATOR_CONFIG = AssistantConfig(
    name="task_coordinator",
    channel=COORDINATOR_CHANNEL,
    scope=SCOPE_TASK,
    system_prompt=(
        "You are the WorkStep task coordinator. Use task and workflow context to "
        "answer questions. When you need to inspect or operate on WorkStep workflows, "
        "inspect the workstep-cli skill and use its documented native tools or CLI "
        "transport. Keep using available WorkStep tools for other operations. "
        "Mutating actions require explicit user authorization (confirm='yes'). "
        "At most one action proposal (supplement_step / rerun_from_step / "
        "review_decision / create_workflow_action) may be proposed. For workflow "
        "Action creation in task chat, return a proposal for user review; do not "
        "call the CLI write operation before proposal confirmation. Never execute workflow actions directly."
    ),
    engine_label="Coordinator engine",
    workstep_tools=True,
)
assistant_registry.register(COORDINATOR_CONFIG)

@dataclass(frozen=True, slots=True)
class ChatAccepted:
    turn_id: str
    user_message_id: str
    assistant_message_id: str
    status: str

    def to_dict(self) -> dict:
        return {
            "turn_id": self.turn_id,
            "user_message_id": self.user_message_id,
            "assistant_message_id": self.assistant_message_id,
            "status": self.status,
        }


class CoordinatorModule:
    """Coordinate task conversations behind a small persistent interface."""

    def __init__(self, event_bus: EventBus, project_manager, workflow_runtime):
        self._event_bus = event_bus
        self._project_manager = project_manager
        self._workflow_runtime = workflow_runtime
        self._turn_locks: dict[tuple[str, str], asyncio.Lock] = {}
        self._actions = CoordinatorActionService(project_manager, workflow_runtime)
        self._active_tasks: set[asyncio.Task] = set()
        self._scheduled_turns: set[str] = set()
        self._turn_tasks: dict[str, asyncio.Task] = {}
        self._running_engines: dict[str, object] = {}
        self._cancelled_turns: set[str] = set()
        self._event_journal = TurnEventJournal()
        self._archive_drafts = ArchiveExperienceDraftService(
            project_manager, event_bus, self._event_journal,
            self._archive_settings, self._invoke, self._parse_or_repair,
            self._running_engines,
        )
        self._reconcile_task: asyncio.Task | None = None

    async def start(self) -> int:
        """Recover persisted coordinator work and start orphan reconciliation."""
        recovered = await self.reconcile_orphaned_state()
        if self._reconcile_task is None or self._reconcile_task.done():
            self._reconcile_task = asyncio.create_task(
                self._reconcile_loop(),
                name="coordinator-orphan-reconciler",
            )
        return recovered

    async def _reconcile_loop(self) -> None:
        while True:
            try:
                await asyncio.sleep(COORDINATOR_RECONCILE_SECONDS)
                await self.reconcile_orphaned_state()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Failed to reconcile coordinator state")

    async def reconcile_orphaned_state(self) -> int:
        """Requeue orphaned turns and fail abandoned executing proposals."""
        recovered = 0
        scheduled = set(self._scheduled_turns)
        running = set(self._running_engines)
        executing_actions = set(self._actions.executing_actions)
        for project in self._project_manager.iter_projects():
            turn_ids, failed_actions = await self._run_db(
                project.id,
                lambda project=project: self._prepare_orphaned_state_sync(
                    project,
                    scheduled,
                    running,
                    executing_actions,
                ),
            )
            for task_id, turn_id in turn_ids:
                self._schedule_turn(project.id, task_id, turn_id)
            recovered += len(turn_ids) + failed_actions
        return recovered

    def _prepare_orphaned_state_sync(
        self,
        project,
        scheduled: set[str],
        running: set[str],
        executing_actions: set[str],
    ) -> tuple[list[tuple[str, str]], int]:
        turn_ids: list[tuple[str, str]] = []
        now = utc_now()
        for turn in CoordinatorTurn.select().where(
            CoordinatorTurn.status.in_(["queued", "running"])
        ):
            if turn.id in scheduled or turn.id in running:
                continue
            if turn.status == "running":
                with db_proxy.atomic():
                    assistant = Message.get_by_id(turn.assistant_message_id)
                    journal_ref = self._event_journal.reopen(
                        project.workstep_dir,
                        assistant.event_log_path,
                    )
                    self._event_journal.record(
                        journal_ref,
                        {
                            "type": "status",
                            "data": {"status": "recovered"},
                        },
                        force=True,
                    )
                    turn.status = "queued"
                    turn.error = None
                    turn.started_at = None
                    turn.ended_at = None
                    turn.save()
                    assistant.run_status = "queued"
                    assistant.started_at = None
                    assistant.ended_at = None
                    assistant.save()
            turn_ids.append((turn.task_id, turn.id))

        failed_actions = 0
        for proposal in ActionProposal.select().where(
            ActionProposal.status == "executing"
        ):
            if proposal.id in executing_actions:
                continue
            proposal.status = "failed"
            proposal.error = "协调助手操作中断，请重新发起"
            proposal.updated_at = now
            proposal.save()
            failed_actions += 1
        return turn_ids, failed_actions

    def _schedule_turn(self, project_id: str, task_id: str, turn_id: str) -> None:
        if turn_id in self._scheduled_turns:
            return
        self._scheduled_turns.add(turn_id)
        background = asyncio.create_task(
            self._run_turn(project_id, task_id, turn_id),
            name=f"coordinator-turn:{turn_id}",
        )
        self._turn_tasks[turn_id] = background
        self._active_tasks.add(background)

        def consume(task: asyncio.Task) -> None:
            self._turn_tasks.pop(turn_id, None)
            self._scheduled_turns.discard(turn_id)
            self._cancelled_turns.discard(turn_id)
            self._consume_background(task)

        background.add_done_callback(consume)

    async def _run_db(self, project_id: str, operation):
        """Serialize project Peewee work outside the event loop."""
        return await self._project_manager.run_db(
            project_id, lambda _project: operation()
        )

    async def draft_archive_experience(
        self, project_id: str, task_id: str, message_id: str | None = None,
    ) -> str:
        return await self._archive_drafts.draft_archive_experience(
            project_id, task_id, message_id,
        )

    def take_archive_experience_journal(
        self, project_id: str, task_id: str, message_id: str,
    ) -> dict | None:
        return self._archive_drafts.take_archive_experience_journal(
            project_id, task_id, message_id,
        )

    async def stop_archive_experience(
        self, project_id: str, task_id: str, message_id: str,
    ) -> bool:
        return await self._archive_drafts.stop_archive_experience(
            project_id, task_id, message_id,
        )

    async def submit_message(
        self,
        project_id: str,
        task_id: str,
        content: str,
        idempotency_key: str,
        *,
        author_name: str = "",
        pending_insert_ids: list[str] | None = None,
        reset_session: bool = False,
        replay_pending: bool = False,
    ) -> ChatAccepted:
        normalized = content.strip()
        if not normalized:
            raise ValueError("Message content cannot be empty")
        if not idempotency_key.strip():
            raise ValueError("Idempotency-Key is required")

        persisted = await self._run_db(
            project_id,
            lambda: self._persist_submission(
                project_id,
                task_id,
                normalized,
                idempotency_key,
                author_name=author_name,
                pending_insert_ids=pending_insert_ids,
                reset_session=reset_session,
                replay_pending=replay_pending,
            ),
        )
        accepted, user_message, created = persisted
        if not created:
            return accepted
        await self._publish_message_event(
            project_id,
            task_id,
            user_message,
            "message_started",
            {"content": normalized, "status": "completed", "role": "user"},
            0,
        )
        self._schedule_turn(project_id, task_id, accepted.turn_id)
        return accepted

    def _persist_submission(
        self,
        project_id: str,
        task_id: str,
        normalized: str,
        idempotency_key: str,
        *,
        author_name: str = "",
        pending_insert_ids: list[str] | None = None,
        reset_session: bool = False,
        replay_pending: bool = False,
    ):
        if not replay_pending:
            require_user_actor()
        with self._project_manager.activate_project_by_id(project_id) as project:
            existing = CoordinatorTurn.get_or_none(
                (CoordinatorTurn.task == task_id)
                & (CoordinatorTurn.idempotency_key == idempotency_key)
            )
            if existing is not None:
                return (
                    ChatAccepted(
                        turn_id=existing.id,
                        user_message_id=existing.user_message_id,
                        assistant_message_id=existing.assistant_message_id,
                        status=existing.status,
                    ),
                    None,
                    False,
                )

            task = Task.get_or_none(Task.id == task_id)
            if task is None:
                raise ValueError(f"Task not found: {task_id}")
            engine, model, _, _ = self._resolve_engine_models(task)
            context_step_key = self._single_active_step(task)
            now = utc_now()
            turn_id = str(uuid.uuid4())
            user_message_id = new_message_id()
            assistant_message_id = new_message_id()
            journal_ref = self._event_journal.start(
                project.workstep_dir,
                f"task-{task.id}",
                assistant_message_id,
            )

            with db_proxy.atomic():
                if reset_session:
                    active_turn = CoordinatorTurn.get_or_none(
                        (CoordinatorTurn.task == task_id)
                        & (CoordinatorTurn.status.in_(["queued", "running"]))
                    )
                    if active_turn is not None:
                        raise ValueError("Cannot reset a running coordinator session")
                    session = CoordinatorSession.get_or_none(
                        CoordinatorSession.task == task_id
                    )
                    if session is not None:
                        session.session_id = None
                        session.engine_state_json = None
                        session.status = "reset"
                        session.version += 1
                        session.updated_at = now
                        session.save()
                current = Task.get_by_id(task.id)
                # 原子预留两个连续序号（用户消息 + 助手消息），
                # 并发提交时也不会撞 (task_id, sequence) 唯一索引。
                user_sequence = allocate_message_sequences(current.id, count=2)
                assistant_sequence = user_sequence + 1
                current.next_message_sequence = assistant_sequence + 1
                actor_fields = current_actor_message_fields()
                if author_name.strip():
                    if author_name.strip() != actor_fields.get("author_name"):
                        actor_fields = {"author_name": author_name.strip()}
                user_message = Message.create(
                    id=user_message_id,
                    task=current,
                    step_key=context_step_key or COORDINATOR_CHANNEL,
                    context_step_key=context_step_key,
                    channel=COORDINATOR_CHANNEL,
                    sequence=user_sequence,
                    role="user",
                    content=normalized,
                    run_id=turn_id,
                    run_status="completed",
                    position=0,
                    started_at=now,
                    ended_at=now,
                    created_at=now,
                    **actor_fields,
                )
                assistant_fields = {
                    "author_id": engine,
                    "author_username": engine,
                    "author_name": engine,
                    "author_type": "assistant",
                    "initiated_by_user_id": actor_fields.get("author_id"),
                    "initiated_by_username": actor_fields.get("author_username"),
                    "author_device_id": actor_fields.get("author_device_id"),
                    "author_device_name": actor_fields.get("author_device_name"),
                }
                assistant_message = Message.create(
                    id=assistant_message_id,
                    task=current,
                    step_key=context_step_key or COORDINATOR_CHANNEL,
                    context_step_key=context_step_key,
                    channel=COORDINATOR_CHANNEL,
                    sequence=assistant_sequence,
                    reply_to_message_id=user_message_id,
                    role="assistant",
                    content="",
                    engine=engine,
                    model=model,
                    run_id=turn_id,
                    run_status="queued",
                    event_log_path=journal_ref.relative_path,
                    position=1,
                    created_at=now,
                    **assistant_fields,
                )
                CoordinatorTurn.create(
                    id=turn_id,
                    task=current,
                    user_message=user_message_id,
                    assistant_message=assistant_message_id,
                    idempotency_key=idempotency_key,
                    status="queued",
                    engine=engine,
                    model=model,
                    created_at=now,
                )
                # A manually sent insert starts a new assistant turn. Keep the
                # other inserts visible on that turn instead of stranding them
                # on the previous assistant message.
                if pending_insert_ids:
                    selected = PendingMessageInsert.get_or_none(
                        PendingMessageInsert.id == pending_insert_ids[0]
                    )
                    if selected is not None:
                        source = Message.get_or_none(
                            (Message.id == selected.target_message_id)
                            & (Message.task == current)
                        )
                        if source is not None:
                            (PendingMessageInsert.update(
                                target_message_id=assistant_message_id,
                            ).where(
                                (PendingMessageInsert.target_message_id == source.id)
                                & (PendingMessageInsert.id.not_in(pending_insert_ids))
                            ).execute())
                delete_pending_insert_batch(pending_insert_ids or [])

            return (
                ChatAccepted(
                    turn_id=turn_id,
                    user_message_id=user_message_id,
                    assistant_message_id=assistant_message_id,
                    status="queued",
                ),
                user_message,
                True,
            )

    async def get_config(self, project_id: str, task_id: str) -> dict:
        return await self._run_db(
            project_id, lambda: self._get_config_sync(project_id, task_id)
        )

    def _get_config_sync(self, project_id: str, task_id: str) -> dict:
        with self._project_manager.activate_project_by_id(project_id):
            task = Task.get_or_none(Task.id == task_id)
            if task is None:
                raise ValueError(f"Task not found: {task_id}")
            (
                resolved_engine,
                resolved_model,
                resolved_fast_model,
                resolved_vision_model,
            ) = (
                self._resolve_engine_models(task)
            )
            thinking_effort = self._resolve_thinking_effort(task)
            available = [
                item
                for item in get_available_engines()
                if item.get("installed")
                and (
                    item.get("supports_coordinator")
                    or item.get("id") == "pydantic_ai"
                )
            ]
            return {
                "configured": {
                    "engine": task.coordinator_engine,
                    "model": task.coordinator_model,
                    "fast_model": task.coordinator_fast_model,
                    "vision_model": task.coordinator_vision_model,
                    "thinking_effort": task.coordinator_thinking_effort or "",
                    "provider_id": task.coordinator_provider_id or "",
                },
                "resolved": {
                    "engine": resolved_engine,
                    "model": resolved_model,
                    "fast_model": resolved_fast_model,
                    "vision_model": resolved_vision_model,
                    "thinking_effort": thinking_effort,
                    "provider_id": self._resolve_provider_id(task),
                },
                "available_engines": available,
            }

    async def update_config(
        self,
        project_id: str,
        task_id: str,
        engine_id: str | None,
        model: str | None,
        fast_model: str | None,
        vision_model: str | None,
        thinking_effort: str | None = None,
        provider_id: str | None = None,
    ) -> dict:
        return await self._run_db(
            project_id,
            lambda: self._update_config_sync(
                project_id,
                task_id,
                engine_id,
                model,
                fast_model,
                vision_model,
                thinking_effort,
                provider_id,
            ),
        )

    def _update_config_sync(
        self,
        project_id: str,
        task_id: str,
        engine_id: str | None,
        model: str | None,
        fast_model: str | None,
        vision_model: str | None,
        thinking_effort: str | None = None,
        provider_id: str | None = None,
    ) -> dict:
        with self._project_manager.activate_project_by_id(project_id):
            task = Task.get_or_none(Task.id == task_id)
            if task is None:
                raise ValueError(f"Task not found: {task_id}")
            normalized_engine = engine_id.strip() if engine_id else None
            normalized_model = model.strip() if model else None
            normalized_fast_model = fast_model.strip() if fast_model else None
            normalized_vision_model = vision_model.strip() if vision_model else None
            normalized_effort = thinking_effort.strip() if thinking_effort else ""
            normalized_provider = (provider_id or "").strip() or None
            if normalized_provider:
                provider = config_store.get_provider(normalized_provider)
                if provider is None:
                    raise ValueError("供应商不存在")
                if not provider.get("enabled", True):
                    raise ValueError("所选供应商已停用")
            if normalized_effort and normalized_effort not in CODEX_REASONING_EFFORTS:
                raise ValueError(
                    f"Unsupported thinking effort: {normalized_effort}"
                )
            if normalized_engine is not None:
                engine = create_engine(normalized_engine)
                if engine is None or not (
                    engine.capabilities.supports_coordinator
                    or normalized_engine == "pydantic_ai"
                ):
                    raise ValueError(
                        f"Coordinator engine is unavailable: {normalized_engine}"
                    )
                if (
                    normalized_engine != "pydantic_ai"
                    and not config_store.is_engine_verified(normalized_engine)
                ):
                    raise ValueError(
                        f"Coordinator engine is not verified: {normalized_engine}"
                    )
            elif (
                normalized_model is not None
                or normalized_fast_model is not None
                or normalized_vision_model is not None
            ):
                raise ValueError("A coordinator model requires an engine")
            if normalized_provider:
                current_engine = normalized_engine or self._resolve_engine_models(task)[0]
                candidate = create_engine(current_engine or "")
                if candidate is None or not candidate.supports_provider(provider):
                    raise ValueError("供应商协议与协调引擎不兼容")

            previous = {
                "engine": task.coordinator_engine,
                "model": task.coordinator_model,
                "fast_model": task.coordinator_fast_model,
                "vision_model": task.coordinator_vision_model,
                "provider_id": task.coordinator_provider_id,
            }
            task.coordinator_engine = normalized_engine
            task.coordinator_model = normalized_model
            task.coordinator_fast_model = normalized_fast_model
            task.coordinator_vision_model = normalized_vision_model
            task.coordinator_thinking_effort = normalized_effort or None
            task.coordinator_provider_id = normalized_provider
            task.updated_at = utc_now()
            task.save()
            session = CoordinatorSession.get_or_none(
                CoordinatorSession.task == task
            )
            config_changed = (
                normalized_engine is not None
                and previous["engine"] != normalized_engine
            ) or (
                normalized_provider is not None
                and previous["provider_id"] != normalized_provider
            )
            if session is not None and config_changed:
                session.status = "reset"
                session.session_id = None
                session.version += 1
                session.updated_at = utc_now()
                session.save()
            elif session is not None and previous["model"] != normalized_model:
                session.model = normalized_model
                session.updated_at = utc_now()
                session.save()
            (
                resolved_engine,
                resolved_model,
                resolved_fast_model,
                resolved_vision_model,
            ) = (
                self._resolve_engine_models(task)
            )
            return {
                "configured": {
                    "engine": task.coordinator_engine,
                    "model": task.coordinator_model,
                    "fast_model": task.coordinator_fast_model,
                    "vision_model": task.coordinator_vision_model,
                    "thinking_effort": task.coordinator_thinking_effort or "",
                    "provider_id": task.coordinator_provider_id or "",
                },
                "resolved": {
                    "engine": resolved_engine,
                    "model": resolved_model,
                    "fast_model": resolved_fast_model,
                    "vision_model": resolved_vision_model,
                    "thinking_effort": self._resolve_thinking_effort(task),
                    "provider_id": self._resolve_provider_id(task),
                },
            }

    async def confirm_action(
        self,
        project_id: str,
        task_id: str,
        proposal_id: str,
        idempotency_key: str,
        overwrite: bool = False,
    ) -> dict:
        return await self._actions.confirm_action(
            project_id, task_id, proposal_id, idempotency_key, overwrite,
        )

    async def cancel_action(
        self, project_id: str, task_id: str, proposal_id: str,
    ) -> dict:
        return await self._actions.cancel_action(project_id, task_id, proposal_id)

    async def shutdown(self) -> None:
        if self._reconcile_task is not None:
            self._reconcile_task.cancel()
            await asyncio.gather(self._reconcile_task, return_exceptions=True)
            self._reconcile_task = None
        tasks = tuple(self._active_tasks)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._cancelled_turns.clear()
        self._scheduled_turns.clear()
        self._turn_tasks.clear()
        self._actions.executing_actions.clear()
        self._archive_drafts.clear()
        self._running_engines.clear()
        await self._event_journal.aclose()

    async def _run_turn(self, project_id: str, task_id: str, turn_id: str) -> None:
        lock = self._turn_locks.setdefault((project_id, task_id), asyncio.Lock())
        async with lock:
            if turn_id in self._cancelled_turns:
                await self._mark_turn_stopped(project_id, task_id, turn_id)
                return
            prepared = await self._run_db(
                project_id,
                lambda: self._prepare_turn_sync(project_id, task_id, turn_id),
            )
            turn = prepared["turn"]
            assistant = prepared["assistant"]
            coordinator_root = prepared["coordinator_root"]
            session_id_before = prepared["session_id"]
            engine_state = prepared["engine_state"]
            fast_model = prepared["fast_model"]
            provider_id = prepared["provider_id"]
            thinking_effort = prepared["thinking_effort"]
            prompt = prepared["prompt"]
            artifacts = prepared["artifacts"]
            images = prepared["images"]
            turn_model = prepared["turn_model"]
            journal_ref = prepared["journal_ref"]

            try:
                await self._publish_message_event(
                    project_id,
                    task_id,
                    assistant,
                    "message_started",
                    {"prompt": prompt},
                    0,
                )
                live_event_sequence = 1

                def make_live_callback(journaled_events: list[dict]):
                    raw_content = ""
                    streamed_reply = ""

                    async def publish_live_event(event: InternalEvent) -> None:
                        nonlocal raw_content, streamed_reply, live_event_sequence
                        event_dict = event.to_dict()
                        journaled_events.append(event_dict)
                        self._event_journal.record(
                            journal_ref,
                            event_dict,
                            force=event.type in {"interaction_request", "session_started"},
                        )
                        if is_commentary(event):
                            await self._publish_message_event(
                                project_id,
                                task_id, assistant, event.type, event.data, live_event_sequence,
                            )
                            live_event_sequence += 1
                        elif event.type == "agent_message_chunk":
                            content = event.data.get("content") or {}
                            raw_content += str(content.get("text", ""))
                            partial_reply = extract_streaming_reply(raw_content)
                            if not partial_reply.startswith(streamed_reply):
                                return
                            delta = partial_reply[len(streamed_reply):]
                            if not delta:
                                return
                            streamed_reply = partial_reply
                            await self._publish_message_event(
                                project_id,
                                task_id,
                                assistant,
                                "agent_message_chunk",
                                {**event.data, "content": {"text": delta}},
                                live_event_sequence,
                            )
                            live_event_sequence += 1
                        elif event.type in {
                            "async_question",
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
                            "usage_update",
                            "session_started",
                        }:
                            await self._publish_message_event(
                                project_id,
                                task_id,
                                assistant,
                                event.type,
                                event.data,
                                live_event_sequence,
                            )
                            live_event_sequence += 1

                    return publish_live_event

                journaled_events: list[dict] = []
                raw, events, session_id = await self._invoke(
                    turn.engine or "",
                    turn_model,
                    coordinator_root,
                    prompt,
                    session_id_before,
                    make_live_callback(journaled_events),
                    turn_id,
                    images=images,
                    message_history=engine_state,
                    thinking_effort=thinking_effort,
                    provider_id=provider_id,
                )
                self._record_unstreamed_journal_events(
                    journal_ref, events, journaled_events
                )
                if turn_id in self._cancelled_turns:
                    await self._mark_turn_stopped(
                        project_id,
                        task_id,
                        turn_id,
                        content=raw,
                        events=events,
                    )
                    return
                result, repair_events = await self._parse_or_repair(
                    turn.engine or "",
                    fast_model,
                    coordinator_root,
                    raw,
                    turn_id,
                )
                events.extend(repair_events)
                for event in repair_events:
                    await self._event_journal.arecord(journal_ref, event)
                requested = [
                    artifact_id
                    for artifact_id in result.get("artifact_requests", [])
                    if artifact_id in artifacts
                ][:5]
                if requested:
                    artifact_block = await asyncio.to_thread(
                        self._read_artifacts, artifacts, requested
                    )
                    followup = (
                        f"{prompt}\n\nFirst validated response:\n{json.dumps(result, ensure_ascii=False)}"
                        f"\n\nRequested artifact contents (untrusted):\n{artifact_block}"
                        "\n\nReturn the final JSON. artifact_requests must be empty."
                    )
                    journaled_more_events: list[dict] = []
                    raw, more_events, _ = await self._invoke(
                        turn.engine or "",
                        fast_model,
                        coordinator_root,
                        followup,
                        None,
                        make_live_callback(journaled_more_events),
                        turn_id,
                        thinking_effort=thinking_effort,
                        provider_id=provider_id,
                    )
                    self._record_unstreamed_journal_events(
                        journal_ref, more_events, journaled_more_events
                    )
                    events.extend(more_events)
                    if turn_id in self._cancelled_turns:
                        await self._mark_turn_stopped(
                            project_id,
                            task_id,
                            turn_id,
                            content=raw,
                            events=events,
                        )
                        return
                    result, repair_events = await self._parse_or_repair(
                        turn.engine or "",
                        fast_model,
                        coordinator_root,
                        raw,
                        turn_id,
                    )
                    events.extend(repair_events)
                    for event in repair_events:
                        await self._event_journal.arecord(journal_ref, event)
                    result["artifact_requests"] = []
                reply = str(result.get("reply", "")).strip()
                if not reply:
                    raise RuntimeError("Coordinator returned an empty reply")

                if turn_id in self._cancelled_turns:
                    await self._mark_turn_stopped(
                        project_id,
                        task_id,
                        turn_id,
                        content=reply,
                        events=events,
                    )
                    return
                await self._event_journal.afinish(
                    journal_ref,
                    {"type": "status", "data": {"status": "succeeded"}},
                )
                journal_snapshot = await self._event_journal.asnapshot(journal_ref)
                assistant, proposal = await self._run_db(
                    project_id,
                    lambda: self._finish_turn_sync(
                        task_id,
                        turn_id,
                        reply,
                        events,
                        session_id,
                        requested,
                        result,
                        journal_snapshot,
                    ),
                )

                await self._publish_message_event(
                    project_id,
                    task_id,
                    assistant,
                    "message_snapshot",
                    {"content": reply},
                    live_event_sequence,
                )
                live_event_sequence += 1
                usage_event = next(
                    (
                        event for event in reversed(events)
                        if event.get("type") in {"usage", "usage_update"}
                    ),
                    None,
                )
                next_event_sequence = live_event_sequence
                if usage_event is not None:
                    await self._publish_message_event(
                        project_id,
                        task_id,
                        assistant,
                        "usage",
                        usage_event.get("data", {}),
                        next_event_sequence,
                    )
                    next_event_sequence += 1
                if proposal is not None:
                    await self._publish_message_event(
                        project_id,
                        task_id,
                        assistant,
                        "action_proposal",
                        proposal,
                        next_event_sequence,
                    )
                    next_event_sequence += 1
                await self._publish_message_event(
                    project_id,
                    task_id,
                    assistant,
                    "message_completed",
                    {"status": "succeeded"},
                    next_event_sequence,
                )
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                if turn_id in self._cancelled_turns:
                    await self._mark_turn_stopped(project_id, task_id, turn_id)
                    return
                logger.exception("Coordinator turn %s failed", turn_id)
                await self._event_journal.afinish(
                    journal_ref,
                    {"type": "error", "data": {"message": str(exc)}},
                )
                journal_snapshot = await self._event_journal.asnapshot(journal_ref)
                assistant = await self._run_db(
                    project_id,
                    lambda: self._fail_turn_sync(
                        turn_id, str(exc), journal_snapshot
                    ),
                )
                await self._publish_message_event(
                    project_id,
                    task_id,
                    assistant,
                    "message_snapshot",
                    {"content": str(exc)},
                    1,
                )
                await self._publish_message_event(
                    project_id,
                    task_id,
                    assistant,
                    "message_completed",
                    {"status": "failed", "error": str(exc)},
                    2,
                )
            await self._consume_pending_inserts(
                project_id,
                task_id,
                turn.assistant_message_id,
            )

    async def _consume_pending_inserts(
        self,
        project_id: str,
        task_id: str,
        target_message_id: str,
    ) -> None:
        def load_batch():
            ids, content, username = pending_insert_batch(target_message_id)
            return ids, content, username, pending_insert_actor(target_message_id)

        ids, content, username, actor = await self._run_db(project_id, load_batch)
        if not ids or not content:
            return
        with replayed_actor_context(actor):
            await self.submit_message(
                project_id,
                task_id,
                content,
                f"pending-inserts:{target_message_id}",
                author_name=username,
                pending_insert_ids=ids,
                replay_pending=True,
            )

    def _record_unstreamed_journal_events(
        self,
        journal_ref: JournalRef,
        returned_events: list[dict],
        journaled_events: list[dict],
    ) -> None:
        unmatched = list(journaled_events)
        for event in returned_events:
            if event in unmatched:
                unmatched.remove(event)
            else:
                self._event_journal.record(journal_ref, event)

    def _prepare_turn_sync(self, project_id, task_id, turn_id):
        project = self._project_manager.get_project_by_id(project_id)
        turn = CoordinatorTurn.get_by_id(turn_id)
        task = Task.get_by_id(task_id)
        assistant = Message.get_by_id(turn.assistant_message_id)
        coordinator_root = project_coordinator_root(project, task)
        turn.status = "running"
        turn.started_at = utc_now()
        turn.save()
        assistant.run_status = "running"
        assistant.started_at = turn.started_at
        assistant.save()
        session = self._prepare_session(task, turn.engine or "", turn.model)
        engine_state = None
        if session.engine_state_json:
            try:
                engine_state = json.loads(session.engine_state_json)
            except json.JSONDecodeError:
                engine_state = None
        _, _, fast_model, vision_model = self._resolve_engine_models(task)
        provider_id = self._resolve_provider_id(task)
        thinking_effort = self._resolve_thinking_effort(task)
        user_message = Message.get_by_id(turn.user_message_id)
        engine = create_engine(turn.engine) if turn.engine else None
        if session.session_id and engine is not None and engine.supports_resume:
            # The engine already has the bootstrap instructions and context.
            prompt = user_message.content or ""
            artifacts = artifact_index(project, task)
        else:
            prompt, artifacts = assemble_context(
                project, task, turn, root_dir=coordinator_root
            )
        images = extract_uploaded_images(
            project, task.cwd, user_message.content or ""
        )
        turn_model = (vision_model or turn.model) if images else turn.model
        assistant.prompt_json = json.dumps({"prompt": prompt}, ensure_ascii=False)
        assistant.save(only=[Message.prompt_json])
        journal_ref = self._event_journal.reopen(
            project.workstep_dir,
            assistant.event_log_path,
        )
        return {
            "turn": turn,
            "assistant": assistant,
            "coordinator_root": coordinator_root,
            "session_id": session.session_id,
            "engine_state": engine_state,
            "fast_model": fast_model,
            "provider_id": provider_id,
            "thinking_effort": thinking_effort,
            "prompt": prompt,
            "artifacts": artifacts,
            "images": images,
            "turn_model": turn_model,
            "journal_ref": journal_ref,
        }

    def _finish_turn_sync(
        self,
        task_id,
        turn_id,
        reply,
        events,
        session_id,
        requested,
        result,
        journal_snapshot,
    ):
        turn = CoordinatorTurn.get_by_id(turn_id)
        assistant = Message.get_by_id(turn.assistant_message_id)
        task = Task.get_by_id(task_id)
        assistant.content = reply
        summary_events = journal_snapshot["events"]
        assistant.events_json = (
            json.dumps(summary_events, ensure_ascii=False)
            if summary_events else None
        )
        assistant.event_summary_json = json.dumps(
            journal_snapshot["summary"], ensure_ascii=False
        )
        assistant.event_count = journal_snapshot["summary"]["event_count"]
        assistant.last_event_seq = journal_snapshot["summary"]["last_event_seq"]
        assistant.usage_json = extract_usage_json(events)
        assistant.run_status = "succeeded"
        assistant.ended_at = utc_now()
        assistant.save()
        turn.status = "succeeded"
        turn.session_id = session_id
        turn.requested_artifact_ids_json = json.dumps(requested)
        turn.ended_at = assistant.ended_at
        turn.save()
        session = CoordinatorSession.get_by_id(task_id)
        session.session_id = session_id
        session.status = "active"
        session.last_error = None
        for engine_event in events:
            if engine_event.get("type") == "engine_state":
                state = (engine_event.get("data") or {}).get("state")
                if state is not None:
                    session.engine_state_json = json.dumps(state, ensure_ascii=False)
                break
        session.updated_at = assistant.ended_at
        session.save()
        self._refresh_summary(task, session)
        proposal = self._actions.create_proposal(task, turn, assistant, result)
        return assistant, self._actions.proposal_to_dict(proposal) if proposal else None

    @staticmethod
    def _fail_turn_sync(turn_id, error, journal_snapshot):
        turn = CoordinatorTurn.get_by_id(turn_id)
        assistant = Message.get_by_id(turn.assistant_message_id)
        turn.status = "failed"
        turn.error = error
        turn.ended_at = utc_now()
        turn.save()
        assistant.run_status = "failed"
        assistant.content = error
        summary_events = journal_snapshot["events"]
        assistant.events_json = (
            json.dumps(summary_events, ensure_ascii=False)
            if summary_events else None
        )
        assistant.event_summary_json = json.dumps(
            journal_snapshot["summary"], ensure_ascii=False
        )
        assistant.event_count = journal_snapshot["summary"]["event_count"]
        assistant.last_event_seq = journal_snapshot["summary"]["last_event_seq"]
        assistant.ended_at = turn.ended_at
        assistant.save()
        return assistant

    def _archive_settings(self, task: Task) -> dict:
        engine_id, model, fast_model, _ = self._resolve_engine_models(task)
        return {
            "engine_id": engine_id,
            "model": model,
            "fast_model": fast_model,
            "thinking_effort": self._resolve_thinking_effort(task),
            "provider_id": self._resolve_provider_id(task),
        }

    def _resolve_engine_models(
        self,
        task: Task,
    ) -> tuple[str, str | None, str | None, str | None]:
        requested_id = (
            task.coordinator_engine
            or config_store.get_coordinator_default_engine()
            or config_store.get_execution_default_engine()
            or DEFAULT_EXECUTION_ENGINE
        )
        # 显式选择内置引擎并配置了供应商：能力由供应商动态配置决定，
        # 不再要求引擎全局已配置，避免被协调回退吞掉。
        provider_override = (
            self._resolve_provider_id(task)
            if requested_id == "pydantic_ai"
            else ""
        )
        engine_id = requested_id
        engine = create_engine(engine_id)
        if engine is None or (
            not engine.capabilities.supports_coordinator
            and not provider_override.strip()
        ):
            # 默认引擎未配置/不可用时，回退到第一个可用的协调引擎
            engine_id, engine = self._fallback_coordinator_engine(requested_id)
            if engine is None:
                raise ValueError(
                    f"Coordinator engine is unavailable: {requested_id}"
                )
        use_global_models = engine_id == requested_id
        model = (
            task.coordinator_model
            or (
                config_store.get_coordinator_default_model()
                if use_global_models
                else ""
            )
            or config_store.get_engine_default_model(engine_id)
            or None
        )
        get_default_fast_model = getattr(
            config_store,
            "get_coordinator_default_fast_model",
            lambda: "",
        )
        fast_model = (
            task.coordinator_fast_model
            or (get_default_fast_model() if use_global_models else "")
            or model
        )
        get_default_vision_model = getattr(
            config_store,
            "get_coordinator_default_vision_model",
            lambda: "",
        )
        vision_model = (
            task.coordinator_vision_model
            or (get_default_vision_model() if use_global_models else "")
            or None
        )
        return engine_id, model, fast_model, vision_model

    @staticmethod
    def _resolve_provider_id(task: Task) -> str:
        """Resolve a task override, or let an explicitly selected engine use its default."""
        if task.coordinator_provider_id:
            return task.coordinator_provider_id
        if task.coordinator_engine:
            return ""
        get_defaults = getattr(config_store, "get_assistant_defaults", None)
        if get_defaults is None:
            return ""
        return get_defaults("task_coordinator").get("provider_id", "") or ""

    @staticmethod
    def _resolve_thinking_effort(task: Task) -> str:
        return (
            task.coordinator_thinking_effort
            or config_store.get_coordinator_default_thinking_effort()
            or ""
        )

    @staticmethod
    def _fallback_coordinator_engine(
        requested_id: str,
    ) -> tuple[str, object | None]:
        """Return the first usable coordinator engine, or (requested_id, None)."""
        candidates = [requested_id] + [
            key for key in COORDINATOR_FALLBACK_ORDER if key != requested_id
        ]
        for candidate in candidates:
            engine = create_engine(candidate)
            if engine is not None and engine.capabilities.supports_coordinator:
                return candidate, engine
        return requested_id, None

    def _prepare_session(
        self,
        task: Task,
        engine: str,
        model: str | None,
    ) -> CoordinatorSession:
        session = CoordinatorSession.get_or_none(CoordinatorSession.task == task)
        now = utc_now()
        if session is None:
            return CoordinatorSession.create(
                task=task,
                engine=engine,
                model=model,
                status="active",
                created_at=now,
                updated_at=now,
            )
        if session.engine != engine:
            session.engine = engine
            session.model = model
            session.session_id = None
            session.engine_state_json = None
            session.status = "reset"
            session.version += 1
            session.updated_at = now
            session.save()
        elif session.model != model:
            session.model = model
            session.updated_at = now
            session.save()
        return session

    def _refresh_summary(
        self,
        task: Task,
        session: CoordinatorSession,
    ) -> None:
        messages = list(
            Message.select()
            .where(
                (Message.task == task)
                & (Message.channel == COORDINATOR_CHANNEL)
                & (Message.run_status.in_(["completed", "succeeded"]))
            )
            .order_by(Message.sequence)
        )
        if len(messages) <= 20:
            return
        summarized = messages[:-20]
        through = summarized[-1].sequence
        if through is None or through == session.summary_through_sequence:
            return
        lines = [
            f"{message.role}: {message.content.strip()}"
            for message in summarized
            if message.content.strip()
        ]
        session.summary = "\n".join(lines)[-12000:]
        session.summary_through_sequence = through
        session.updated_at = utc_now()
        session.save()

    async def _invoke(
        self,
        engine_id: str,
        model: str | None,
        cwd: str,
        prompt: str,
        session_id: str | None,
        on_event: Callable[[InternalEvent], Awaitable[None]] | None = None,
        turn_id: str | None = None,
        images: list[EngineImage] | None = None,
        message_history: list | None = None,
        thinking_effort: str | None = None,
        provider_id: str | None = None,
    ) -> tuple[str, list[dict], str | None]:
        model_supports_multimodal = getattr(
            config_store,
            "model_supports_multimodal",
            None,
        )
        direct_images = bool(
            images
            and (
                model_supports_multimodal(
                    engine_id,
                    model or "",
                    provider_id or "",
                )
                if callable(model_supports_multimodal)
                else True
            )
        )

        def spawn(engine, *, workstep_tools=False, config_overrides=None):
            spawn_kwargs = {}
            if workstep_tools:
                spawn_kwargs["workstep_tools"] = True
            if config_overrides:
                spawn_kwargs["config_overrides"] = config_overrides
            spawn_prompt = (
                prompt
                if direct_images or not images
                else engine.render_image_prompt(prompt, images)
            )
            spawn_coordinator = getattr(
                engine,
                "spawn_coordinator_with_retry",
                engine.spawn_coordinator,
            )
            return spawn_coordinator(
                prompt=spawn_prompt,
                cwd=cwd,
                model=model,
                session_id=session_id if engine.supports_resume else None,
                images=images if direct_images else None,
                message_history=message_history,
                report_engine_state=True,
                thinking_effort=thinking_effort,
                **spawn_kwargs,
            )

        get_defaults = getattr(config_store, "get_assistant_defaults", None)
        assistant_defaults = (
            get_defaults("task_coordinator") if callable(get_defaults) else {}
        )
        provider_id = provider_id or assistant_defaults.get("provider_id", "")
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
            spawner=spawn,
            error_prefix="Coordinator engine",
            run_key=turn_id,
            running_engines=self._running_engines,
            assign_session_on_no_resume=True,
            workstep_tools=COORDINATOR_CONFIG.workstep_tools,
            config_overrides=config_overrides,
        )

    def _parse_result(self, raw: str) -> dict:
        candidates = [raw]
        fenced = re.search(r"```(?:json)?\s*(\{.*\})\s*```", raw, re.DOTALL)
        if fenced:
            candidates.insert(0, fenced.group(1))
        decoder = json.JSONDecoder()
        for candidate in candidates:
            starts = [0, *(match.start() for match in re.finditer(r"\{", candidate))]
            for start in dict.fromkeys(starts):
                try:
                    parsed, _ = decoder.raw_decode(candidate, start)
                except json.JSONDecodeError:
                    continue
                if not isinstance(parsed, dict):
                    continue
                if not isinstance(parsed.get("reply"), str):
                    continue
                requests = parsed.get("artifact_requests", [])
                parsed["artifact_requests"] = requests if isinstance(requests, list) else []
                return parsed
        raise RuntimeError("Coordinator returned invalid JSON")

    async def _parse_or_repair(
        self,
        engine_id: str,
        model: str | None,
        cwd: str,
        raw: str,
        turn_id: str | None = None,
    ) -> tuple[dict, list[dict]]:
        try:
            return self._parse_result(raw), []
        except RuntimeError:
            repair_prompt = (
                "Repair the following response into valid coordinator JSON. "
                "Do not add an action that was not present. Return JSON only.\n\n"
                f"{raw}"
            )
            repaired, events, _ = await self._invoke(
                engine_id,
                model,
                cwd,
                repair_prompt,
                None,
                turn_id=turn_id,
            )
            return self._parse_result(repaired), events

    def _read_artifacts(self, artifacts, requested: list[str]) -> str:
        blocks = []
        total = 0
        for artifact_id in requested:
            metadata, path = artifacts[artifact_id]
            size = path.stat().st_size
            if size > 64 * 1024 or total + size > 192 * 1024:
                continue
            try:
                content = path.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue
            total += len(content.encode("utf-8"))
            blocks.append(
                f"<artifact id={json.dumps(artifact_id)} "
                f"path={json.dumps(metadata['relative_path'])}>\n"
                f"{content}\n</artifact>"
            )
        return "\n\n".join(blocks)

    def _single_active_step(self, task: Task) -> str | None:
        keys = [
            row.step_key
            for row in TaskStep.select().where(
                (TaskStep.task == task)
                & (
                    TaskStep.status.in_(
                        [
                            "running",
                            "reviewing",
                            "awaiting_review",
                            "retrying",
                            "rework",
                            "rework_waiting",
                        ]
                    )
                )
            )
        ]
        return keys[0] if len(keys) == 1 else None



    async def _publish_message_event(
        self,
        project_id: str,
        task_id: str,
        message: Message,
        event_type: str,
        data: dict,
        event_sequence: int,
    ) -> None:
        """发布出口：内部事件 → AG-UI 标准事件后推送。"""
        payload = {
            "event_id": str(uuid.uuid4()),
            "project_id": project_id,
            "task_id": task_id,
            "channel": message.channel,
            "message_id": message.id,
            "engine": message.engine,
            "model": message.model,
            "step_key": message.context_step_key,
            "event_sequence": event_sequence,
            "type": event_type,
            "data": data,
            "created_at": utc_now().isoformat(),
            **current_actor_event_fields(),
        }
        ctx = AGUIContext.from_event(payload)
        for agui_event in to_agui_events(payload, ctx):
            await self._event_bus.publish(agui_event)

    async def stop_current(self, project_id: str, task_id: str) -> bool:
        """Stop the running turn, falling back to the newest queued turn."""
        def find_turn_id():
            turn = (
                CoordinatorTurn.select()
                .where(
                    (CoordinatorTurn.task == task_id)
                    & (CoordinatorTurn.status == "running")
                )
                .order_by(CoordinatorTurn.created_at.desc())
                .first()
            )
            if turn is None:
                turn = (
                    CoordinatorTurn.select()
                    .where(
                        (CoordinatorTurn.task == task_id)
                        & (CoordinatorTurn.status == "queued")
                    )
                    .order_by(CoordinatorTurn.created_at.desc())
                    .first()
                )
            return turn.id if turn is not None else None

        turn_id = await self._run_db(project_id, find_turn_id)
        if turn_id is None:
            return False
        self._cancelled_turns.add(turn_id)
        intervention_manager.cancel_for_task_step(turn_id, "assistant")
        engine = self._running_engines.get(turn_id)
        task = self._turn_tasks.get(turn_id)
        if task is not None and not task.done():
            task.cancel()
        await self._mark_turn_stopped(project_id, task_id, turn_id)
        assistant_message_id = await self._run_db(
            project_id,
            lambda: CoordinatorTurn.get_by_id(turn_id).assistant_message_id,
        )
        await self._consume_pending_inserts(
            project_id, task_id, assistant_message_id,
        )
        if engine is not None:
            try:
                await asyncio.wait_for(
                    engine.stop(),
                    timeout=COORDINATOR_STOP_TIMEOUT_SECONDS,
                )
            except asyncio.TimeoutError:
                logger.error(
                    "Engine stop timed out for coordinator turn %s",
                    turn_id,
                )
            except Exception:
                logger.exception(
                    "Engine stop raised while stopping coordinator turn %s",
                    turn_id,
                )
        return True

    async def _mark_turn_stopped(
        self,
        project_id: str,
        task_id: str,
        turn_id: str,
        content: str = "",
        events: list[dict] | None = None,
    ) -> None:
        """Persist a stopped turn and notify listeners."""
        def persist_stopped():
            turn = CoordinatorTurn.get_by_id(turn_id)
            if turn.status in {"stopped", "succeeded", "failed"}:
                return None
            assistant = Message.get_by_id(turn.assistant_message_id)
            project = self._project_manager.get_project_by_id(project_id)
            journal_ref = self._event_journal.reopen(
                project.workstep_dir,
                assistant.event_log_path,
            )
            self._event_journal.finish(
                journal_ref,
                {"type": "status", "data": {"status": "stopped"}},
            )
            journal_snapshot = self._event_journal.snapshot(journal_ref)
            now = utc_now()
            turn.status = "stopped"
            turn.ended_at = now
            turn.save()
            assistant.run_status = "stopped"
            if content:
                assistant.content = content
            summary_events = journal_snapshot["events"]
            assistant.events_json = (
                json.dumps(summary_events, ensure_ascii=False)
                if summary_events else None
            )
            assistant.event_summary_json = json.dumps(
                journal_snapshot["summary"], ensure_ascii=False
            )
            assistant.event_count = journal_snapshot["summary"]["event_count"]
            assistant.last_event_seq = journal_snapshot["summary"]["last_event_seq"]
            assistant.ended_at = now
            assistant.save()
            session = CoordinatorSession.get_or_none(CoordinatorSession.task == task_id)
            if session is not None:
                session.last_error = None
                session.updated_at = now
                session.save()
            return assistant

        assistant = await self._run_db(project_id, persist_stopped)
        if turn_id not in self._scheduled_turns:
            self._cancelled_turns.discard(turn_id)
        if assistant is None:
            return
        await self._publish_message_event(
            project_id,
            task_id,
            assistant,
            "message_snapshot",
            {"content": assistant.content or ""},
            1,
        )
        await self._publish_message_event(
            project_id,
            task_id,
            assistant,
            "message_completed",
            {"status": "stopped"},
            2,
        )

    def _consume_background(self, task: asyncio.Task) -> None:
        self._active_tasks.discard(task)
        if not task.cancelled():
            task.exception()
