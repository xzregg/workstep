"""Engine-backed task coordinator conversation module."""

import asyncio
import hashlib
import json
import logging
import re
import uuid
from dataclasses import dataclass
from pathlib import Path
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
from agent_assistants.event_journal import JournalRef, TurnEventJournal
from models import (
    ActionProposal,
    CoordinatorSession,
    CoordinatorTurn,
    Message,
    ReviewRun,
    StageSupplement,
    Task,
    TaskStep,
)
from models.base import db_proxy
from models.fields import utc_now
from services.config import CODEX_REASONING_EFFORTS, config_store
from services.messages import (
    allocate_message_sequences,
    current_actor_message_fields,
    new_message_id,
)
from services.task_runner import extract_usage_json
from services.remote_project import current_actor_event_fields
from services.tool_registry import workstep_cli_instruction
from services.workflow_definition import WorkflowDefinition
from streaming.bus import EventBus

logger = logging.getLogger(__name__)

COORDINATOR_CHANNEL = "coordinator"

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
        "任务协调 Agent：理解任务与工作流上下文，回答用户问题，"
        "可调用 WorkStep 内部工具（workstep_call）查询项目与任务，"
        "变更类操作需用户明确授权（confirm='yes'）；必要时提出不超过"
        "一个动作提案（supplement_stage / rerun_from_stage / "
        "review_decision），从不直接执行工作流动作。"
    ),
    engine_label="Coordinator engine",
    workstep_tools=True,
)
assistant_registry.register(COORDINATOR_CONFIG)
ALLOWED_ACTIONS = {"supplement_stage", "rerun_from_stage", "review_decision"}


class ArchiveExperienceStopped(RuntimeError):
    """Raised when the user stops an in-flight archive experience draft."""


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
        self._operation_locks: dict[tuple[str, str], asyncio.Lock] = {}
        self._active_tasks: set[asyncio.Task] = set()
        self._running_engines: dict[str, object] = {}
        self._cancelled_turns: set[str] = set()
        self._active_archive_experience_runs: set[str] = set()
        self._cancelled_archive_experience_runs: set[str] = set()
        self._completed_archive_experience_journals: dict[str, dict] = {}
        self._event_journal = TurnEventJournal()

    async def _run_db(self, project_id: str, operation):
        """Serialize project Peewee work outside the event loop."""
        return await self._project_manager.run_db(
            project_id, lambda _project: operation()
        )

    async def draft_archive_experience(
        self,
        project_id: str,
        task_id: str,
        message_id: str | None = None,
    ) -> str:
        """Generate a reviewable task-experience draft without persisting it."""
        progress_message_id = message_id or str(uuid.uuid4())
        loaded = await self._run_db(
            project_id,
            lambda: self._load_archive_evidence_sync(project_id, task_id),
        )
        engine_id = loaded["engine_id"]
        model = loaded["model"]
        fast_model = loaded["fast_model"]
        thinking_effort = loaded["thinking_effort"]
        provider_id = loaded["provider_id"]
        coordinator_root = loaded["coordinator_root"]
        steps = loaded["steps"]
        reviews = loaded["reviews"]
        messages = loaded["messages"]
        evidence = loaded["evidence"]

        schema = {
            "version": 1,
            "reply": "Markdown experience draft",
            "intent": "answer",
            "target_step_key": None,
            "artifact_requests": [],
            "proposal": None,
        }
        prompt = (
            "你正在为归档任务提炼可复用的错误经验，这不是任务总结。"
            "只记录有直接证据的错误、失误或踩坑；成功过程、任务概述、成果、客套话都不要写。"
            "最多 3 条，每条只写一行，格式为“- 错误：…；原因：…；纠正：…”。"
            "合计不超过 600 个汉字；没有错误证据时回复“- 未发现值得记录的错误经验。”。"
            "不要猜测，也不要执行任何操作。内容将先由用户审阅，当前绝不能写入 Memory。"
            f"返回符合以下结构的 JSON：{json.dumps(schema, ensure_ascii=False)}\n\n"
            f"任务全过程证据：\n{json.dumps(evidence, ensure_ascii=False, default=str)}"
        )
        run_key = self._archive_experience_run_key(
            project_id,
            task_id,
            progress_message_id,
        )
        journal_ref = self._event_journal.start(
            loaded["workstep_dir"],
            f"task-{task_id}",
            progress_message_id,
        )
        journal_finished = False
        self._active_archive_experience_runs.add(run_key)
        event_sequence = 0
        raw_content = ""
        streamed_reply = ""

        async def publish(event_type: str, data: dict) -> None:
            nonlocal event_sequence
            self._event_journal.record(
                journal_ref,
                {"type": event_type, "data": data},
            )
            await self._publish_archive_experience_event(
                project_id,
                task_id,
                progress_message_id,
                engine_id,
                model,
                event_type,
                data,
                event_sequence,
            )
            event_sequence += 1

        async def publish_engine_event(event: InternalEvent) -> None:
            nonlocal raw_content, streamed_reply
            if is_commentary(event):
                await publish(event.type, event.data)
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
                await publish(
                    "agent_message_chunk",
                    {**event.data, "content": {"text": delta}},
                )
            elif event.type in {
                "agent_thought_chunk",
                "tool_call",
                "tool_call_update",
                "plan",
                "plan_update",
                "plan_removed",
                "usage_update",
                "subagent",
                "compacted",
            }:
                await publish(event.type, event.data)

        await publish(
            "message_started",
            {"role": "assistant", "prompt": prompt},
        )
        await publish(
            "agent_thought_chunk",
            {
                "content": {
                    "text": (
                        f"已读取任务记录：{len(steps)} 个阶段、"
                        f"{len(reviews)} 次审核、{len(messages)} 条消息。"
                    )
                }
            },
        )
        await publish(
            "agent_thought_chunk",
            {"content": {"text": "已提交给协调助手，等待协调助手响应。"}},
        )
        try:
            if run_key in self._cancelled_archive_experience_runs:
                raise ArchiveExperienceStopped("Archive experience generation stopped")
            raw, _, _ = await self._invoke(
                engine_id,
                model,
                coordinator_root,
                prompt,
                None,
                on_event=publish_engine_event,
                turn_id=run_key,
                thinking_effort=thinking_effort,
                provider_id=provider_id,
            )
            if run_key in self._cancelled_archive_experience_runs:
                raise ArchiveExperienceStopped("Archive experience generation stopped")
            result, repair_events = await self._parse_or_repair(
                engine_id,
                fast_model,
                coordinator_root,
                raw,
                run_key,
            )
            for repair_event in repair_events:
                event_type = str(repair_event.get("type") or "")
                if event_type:
                    await publish(event_type, repair_event.get("data") or {})
            experience = str(result.get("reply") or "").strip()
            if not experience:
                raise RuntimeError("Coordinator returned an empty experience draft")
            if len(experience) > 800:
                raise RuntimeError("Coordinator experience draft exceeds 800 characters")
            await publish("message_snapshot", {"content": experience})
            await publish("message_completed", {"status": "succeeded"})
            self._event_journal.finish(journal_ref)
            journal_finished = True
            self._completed_archive_experience_journals[run_key] = {
                "event_log_path": journal_ref.relative_path,
                "snapshot": self._event_journal.snapshot(journal_ref),
                "prompt": prompt,
                "engine": engine_id,
                "model": model,
            }
            return experience
        except ArchiveExperienceStopped:
            await publish("message_completed", {"status": "stopped"})
            raise
        except Exception as exc:
            if run_key in self._cancelled_archive_experience_runs:
                await publish("message_completed", {"status": "stopped"})
                raise ArchiveExperienceStopped(
                    "Archive experience generation stopped"
                ) from exc
            await publish(
                "message_completed",
                {"status": "failed", "error": str(exc)},
            )
            raise
        finally:
            if not journal_finished:
                self._event_journal.finish(journal_ref)
            self._active_archive_experience_runs.discard(run_key)
            self._cancelled_archive_experience_runs.discard(run_key)

    def _load_archive_evidence_sync(self, project_id: str, task_id: str) -> dict:
        project = self._project_manager.get_project_by_id(project_id)
        task = Task.get_or_none(Task.id == task_id)
        if task is None:
            raise ValueError(f"Task not found: {task_id}")
        engine_id, model, fast_model, _ = self._resolve_engine_models(task)
        thinking_effort = self._resolve_thinking_effort(task)
        provider_id = self._resolve_provider_id(task)
        coordinator_root = self._coordinator_root(project, task)
        steps = [
            {
                "step_key": step.step_key,
                "status": step.status,
                "engine": step.engine,
                "error": step.error,
                "rework_feedback": step.rework_feedback,
                "review_feedback": step.review_feedback,
            }
            for step in TaskStep.select().where(TaskStep.task == task)
        ]
        reviews = [
            {
                "step_key": review.step_key,
                "attempt": review.attempt,
                "status": review.status,
                "decision": review.decision,
                "decision_comment": review.decision_comment,
                "error": review.error,
                "report": review.report_json,
            }
            for review in ReviewRun.select()
            .where(ReviewRun.task == task)
            .order_by(ReviewRun.started_at)
        ]
        messages = [
            {
                "step_key": message.step_key,
                "channel": message.channel,
                "role": message.role,
                "run_status": message.run_status,
                "content": (message.content or "")[:8000],
                "event_summary": message.event_summary_json,
            }
            for message in Message.select()
            .where(Message.task == task)
            .order_by(Message.sequence, Message.created_at)
            .limit(200)
        ]
        evidence = {
            "task": {
                "id": task.id,
                "title": task.title,
                "description": task.description,
                "status": task.status,
            },
            "steps": steps,
            "reviews": reviews,
            "messages": messages,
            "artifacts": [
                metadata[0]
                for metadata in self._artifact_index(project, task).values()
            ],
        }
        return {
            "engine_id": engine_id,
            "model": model,
            "fast_model": fast_model,
            "thinking_effort": thinking_effort,
            "provider_id": provider_id,
            "coordinator_root": coordinator_root,
            "steps": steps,
            "reviews": reviews,
            "messages": messages,
            "evidence": evidence,
            "workstep_dir": project.workstep_dir,
        }

    @staticmethod
    def _archive_experience_run_key(
        project_id: str,
        task_id: str,
        message_id: str,
    ) -> str:
        return f"archive-experience:{project_id}:{task_id}:{message_id}"

    def take_archive_experience_journal(
        self,
        project_id: str,
        task_id: str,
        message_id: str,
    ) -> dict | None:
        """Take the completed journal metadata for durable draft persistence."""
        return self._completed_archive_experience_journals.pop(
            self._archive_experience_run_key(project_id, task_id, message_id),
            None,
        )

    async def stop_archive_experience(
        self,
        project_id: str,
        task_id: str,
        message_id: str,
    ) -> bool:
        """Stop a visible archive experience draft without persisting anything."""
        run_key = self._archive_experience_run_key(project_id, task_id, message_id)
        if run_key not in self._active_archive_experience_runs:
            return False
        self._cancelled_archive_experience_runs.add(run_key)
        engine = self._running_engines.get(run_key)
        if engine is not None:
            try:
                await engine.stop()
            except Exception:
                logger.exception(
                    "Engine stop raised while stopping archive experience %s",
                    run_key,
                )
        return True

    async def _publish_archive_experience_event(
        self,
        project_id: str,
        task_id: str,
        message_id: str,
        engine: str,
        model: str | None,
        event_type: str,
        data: dict,
        event_sequence: int,
    ) -> None:
        payload = {
            "event_id": str(uuid.uuid4()),
            "project_id": project_id,
            "task_id": task_id,
            "channel": "archive_experience",
            "message_id": message_id,
            "engine": engine,
            "model": model,
            "event_sequence": event_sequence,
            "type": event_type,
            "data": data,
            "created_at": utc_now().isoformat(),
            **current_actor_event_fields(),
        }
        context = AGUIContext.from_event(payload)
        for agui_event in to_agui_events(payload, context):
            await self._event_bus.publish(agui_event)

    async def submit_message(
        self,
        project_id: str,
        task_id: str,
        content: str,
        idempotency_key: str,
    ) -> ChatAccepted:
        normalized = content.strip()
        if not normalized:
            raise ValueError("Message content cannot be empty")
        if not idempotency_key.strip():
            raise ValueError("Idempotency-Key is required")

        persisted = await self._run_db(
            project_id,
            lambda: self._persist_submission(
                project_id, task_id, normalized, idempotency_key
            ),
        )
        accepted, user_message, created = persisted
        if not created:
            return accepted
        await self._publish_message_event(
            task_id,
            user_message,
            "message_started",
            {"content": normalized, "status": "completed", "role": "user"},
            0,
        )
        background = asyncio.create_task(
            self._run_turn(project_id, task_id, accepted.turn_id),
            name=f"coordinator-turn:{accepted.turn_id}",
        )
        self._active_tasks.add(background)
        background.add_done_callback(self._consume_background)
        return accepted

    def _persist_submission(
        self,
        project_id: str,
        task_id: str,
        normalized: str,
        idempotency_key: str,
    ):
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
                current = Task.get_by_id(task.id)
                # 原子预留两个连续序号（用户消息 + 助手消息），
                # 并发提交时也不会撞 (task_id, sequence) 唯一索引。
                user_sequence = allocate_message_sequences(current.id, count=2)
                assistant_sequence = user_sequence + 1
                current.next_message_sequence = assistant_sequence + 1
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
                    **current_actor_message_fields(),
                )
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
    ) -> dict:
        if not idempotency_key.strip():
            raise ValueError("Idempotency-Key is required")
        lock = self._operation_locks.setdefault(
            (project_id, task_id),
            asyncio.Lock(),
        )
        async with lock:
            action = await self._run_db(
                project_id,
                lambda: self._begin_action_sync(
                    task_id, proposal_id, idempotency_key
                ),
            )
            if "completed" in action:
                return action["completed"]
            proposal_type = action["type"]
            payload = action["payload"]

            try:
                if proposal_type == "supplement_stage":
                    result = await self._run_db(
                        project_id,
                        lambda: self._execute_supplement(
                            project_id, task_id, proposal_id, payload
                        ),
                    )
                elif proposal_type == "review_decision":
                    result = await self._execute_review_decision(
                        project_id,
                        task_id,
                        action,
                        payload,
                    )
                elif proposal_type == "rerun_from_stage":
                    handle = await self._workflow_runtime.restart_from_stage(
                        project_id,
                        task_id,
                        action["target_step_key"] or "",
                        expected_run_id=action["expected_workflow_run_id"],
                    )
                    result = {"run_id": handle.id, "status": "started"}
                else:
                    raise RuntimeError(f"Unsupported action: {proposal_type}")
            except Exception as exc:
                await self._run_db(
                    project_id,
                    lambda: self._mark_action_failed_sync(proposal_id, str(exc)),
                )
                raise

            return await self._run_db(
                project_id,
                lambda: self._complete_action_sync(proposal_id, result),
            )

    async def cancel_action(
        self,
        project_id: str,
        task_id: str,
        proposal_id: str,
    ) -> dict:
        return await self._run_db(
            project_id,
            lambda: self._cancel_action_sync(task_id, proposal_id),
        )

    async def shutdown(self) -> None:
        tasks = tuple(self._active_tasks)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._cancelled_turns.clear()
        self._active_archive_experience_runs.clear()
        self._cancelled_archive_experience_runs.clear()
        self._completed_archive_experience_journals.clear()
        self._running_engines.clear()
        self._event_journal.close()

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
                                task_id,
                                assistant,
                                "agent_message_chunk",
                                {**event.data, "content": {"text": delta}},
                                live_event_sequence,
                            )
                            live_event_sequence += 1
                        elif event.type in {
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
                    self._event_journal.record(journal_ref, event)
                requested = [
                    artifact_id
                    for artifact_id in result.get("artifact_requests", [])
                    if artifact_id in artifacts
                ][:5]
                if requested:
                    artifact_block = self._read_artifacts(artifacts, requested)
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
                        self._event_journal.record(journal_ref, event)
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
                self._event_journal.finish(
                    journal_ref,
                    {"type": "status", "data": {"status": "succeeded"}},
                )
                journal_snapshot = self._event_journal.snapshot(journal_ref)
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
                        task_id,
                        assistant,
                        "usage",
                        usage_event.get("data", {}),
                        next_event_sequence,
                    )
                    next_event_sequence += 1
                if proposal is not None:
                    await self._publish_message_event(
                        task_id,
                        assistant,
                        "action_proposal",
                        proposal,
                        next_event_sequence,
                    )
                    next_event_sequence += 1
                await self._publish_message_event(
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
                self._event_journal.finish(
                    journal_ref,
                    {"type": "error", "data": {"message": str(exc)}},
                )
                journal_snapshot = self._event_journal.snapshot(journal_ref)
                assistant = await self._run_db(
                    project_id,
                    lambda: self._fail_turn_sync(
                        turn_id, str(exc), journal_snapshot
                    ),
                )
                await self._publish_message_event(
                    task_id,
                    assistant,
                    "message_snapshot",
                    {"content": str(exc)},
                    1,
                )
                await self._publish_message_event(
                    task_id,
                    assistant,
                    "message_completed",
                    {"status": "failed", "error": str(exc)},
                    2,
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
        coordinator_root = self._coordinator_root(project, task)
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
        prompt, artifacts = self._assemble_context(
            project, task, turn, root_dir=coordinator_root
        )
        user_message = Message.get_by_id(turn.user_message_id)
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
        proposal = self._create_proposal(task, turn, assistant, result)
        return assistant, self._proposal_to_dict(proposal) if proposal else None

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

    def _resolve_engine_models(
        self,
        task: Task,
    ) -> tuple[str, str | None, str | None, str | None]:
        requested_id = (
            task.coordinator_engine
            or config_store.get_coordinator_default_engine()
            or task.engine
            or "claude"
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

    @staticmethod
    def _coordinator_root(project, task: Task) -> str:
        """Resolve the coordinator agent's working root directory.

        Defaults to the task's workflow artifacts directory
        (``.workstep/artifacts/<workflow_id>/``) so the agent can read the
        task's produced files directly; falls back to ``task.cwd`` for
        workflow-less tasks.
        """
        if task.workflow_id:
            root = Path(project.workstep_dir) / "artifacts" / task.workflow_id
            root.mkdir(parents=True, exist_ok=True)
            return str(root)
        return task.cwd

    def _assemble_context(
        self,
        project,
        task: Task,
        turn: CoordinatorTurn,
        root_dir: str | None = None,
    ):
        workflow_data = project.steps
        if task.workflow_id:
            workflow = project.workflow_by_id(task.workflow_id)
            if workflow is not None:
                workflow_data = workflow["steps"]
        compiled = WorkflowDefinition.load(workflow_data).compile()
        review_configs: dict[str, dict | None] = {}
        if task.review_overrides_json:
            try:
                overrides = json.loads(task.review_overrides_json)
                overrides = overrides if isinstance(overrides, dict) else {}
            except (json.JSONDecodeError, TypeError):
                overrides = {}
        else:
            overrides = {}
        for compiled_step in compiled.steps:
            key = str(compiled_step.get("key", ""))
            base = compiled_step.get("review") or {}
            step_ov = overrides.get(key, {})
            if not base and not step_ov:
                review_configs[key] = None
                continue
            cfg = dict(base)
            if isinstance(step_ov, dict):
                cfg.update(step_ov)
            review_configs[key] = cfg
        steps = [
            {
                "step_key": step.step_key,
                "status": step.status,
                "engine": step.engine,
                "error": step.error,
                "review_mode": (
                    "auto"
                    if (review_configs.get(step.step_key) or {}).get("auto", False)
                    else "manual"
                )
                if review_configs.get(step.step_key) is not None
                else None,
            }
            for step in TaskStep.select().where(TaskStep.task == task)
        ]
        active_step_keys = [
            step["step_key"]
            for step in steps
            if step["status"]
            in {
                "running",
                "reviewing",
                "awaiting_review",
                "retrying",
                "rework",
                "rework_waiting",
            }
        ]
        reviews = [
            {
                "id": review.id,
                "step_key": review.step_key,
                "mode": review.mode,
                "status": review.status,
                "decision": review.decision,
                "step_run_id": review.step_run_id,
                "workflow_run_id": review.workflow_run_id,
            }
            for review in ReviewRun.select()
            .where(ReviewRun.task == task)
            .order_by(ReviewRun.started_at.desc())
            .limit(10)
        ]
        messages = [
            {"role": item.role, "content": item.content}
            for item in Message.select()
            .where(
                (Message.task == task)
                & (Message.channel == COORDINATOR_CHANNEL)
                & (Message.id != turn.assistant_message_id)
            )
            .order_by(Message.sequence.desc())
            .limit(20)
        ]
        messages.reverse()
        session = CoordinatorSession.get_or_none(CoordinatorSession.task == task)
        engine = create_engine(turn.engine) if turn.engine else None
        engine_manages_context = engine is not None and engine.supports_resume
        if engine_manages_context:
            # 引擎侧会话维护对话历史：prompt 只带当前用户消息，
            # 历史由引擎（resume / message_history）恢复，不再拼接。
            recent_messages = messages[-1:] if messages else []
            summary = None
        else:
            recent_messages = messages
            summary = session.summary if session else None
        artifacts = self._artifact_index(project, task)
        artifact_views = [metadata[0] for metadata in artifacts.values()]
        schema = {
            "version": 1,
            "reply": "natural language answer",
            "intent": "answer | clarify | propose_action",
            "target_step_key": None,
            "artifact_requests": [],
            "proposal": None,
        }
        context = {
            "coordinator_root_dir": root_dir or self._coordinator_root(project, task),
            "task": {
                "id": task.id,
                "title": task.title,
                "description": task.description,
                "status": task.status,
                "state_version": task.state_version,
                "active_workflow_run_id": task.active_workflow_run_id,
            },
            "coordinator_vision_model": (
                task.coordinator_vision_model
                or config_store.get_coordinator_default_vision_model()
                or None
            ),
            "workflow": compiled,
            "steps": steps,
            "active_step_keys": active_step_keys,
            "reviews": reviews,
            "artifacts": artifact_views,
            "recent_coordinator_messages": recent_messages,
            "coordinator_summary": summary,
        }
        instructions = (
            "Understand the task and answer the user. You may propose at most one "
            "action, but never execute it. Allowed proposal types are "
            "supplement_stage, rerun_from_stage, review_decision. For a proposal "
            "return {type, target_step_key, payload}. supplement payload requires "
            "content; review_decision requires review_run_id and decision; rerun "
            "requires a target step. If active_workflow_run_id is null, rerun starts "
            "a new first workflow run from that stage. Request artifacts only by "
            "artifact_id. If the user's message references an image and your model "
            "cannot accept image input, use coordinator_vision_model to analyze the "
            "image before replying. Return "
            f"JSON matching this shape: {json.dumps(schema, ensure_ascii=False)}"
        )
        if COORDINATOR_CONFIG.workstep_tools and (
            engine is None
            or not getattr(engine.capabilities, "supports_workstep_tools", False)
        ):
            # 无原生工具宿主能力的引擎（Codex CLI / Claude Code / Hermes 等）
            # 通过 workstep CLI 调用本地 daemon，而不是被限制为只读。
            instructions = f"{instructions}\n\n{workstep_cli_instruction()}"
        prompt = (
            f"{instructions}\n\n"
            f"Context:\n{json.dumps(context, ensure_ascii=False, default=str)}"
        )
        return prompt, artifacts

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
            return engine.spawn_coordinator(
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

    def _artifact_index(self, project, task: Task):
        root = (Path(project.workstep_dir) / "artifacts").resolve()
        result: dict[str, tuple[dict, Path]] = {}
        if not root.is_dir():
            return result
        for workflow_dir in root.iterdir():
            if not workflow_dir.is_dir():
                continue
            task_dir = workflow_dir / task.id
            if not task_dir.is_dir():
                continue
            for step_dir in task_dir.iterdir():
                if not step_dir.is_dir():
                    continue
                for path in step_dir.rglob("*"):
                    if not path.is_file() or path.is_symlink():
                        continue
                    resolved = path.resolve()
                    try:
                        relative = resolved.relative_to(step_dir.resolve())
                    except ValueError:
                        continue
                    digest = hashlib.sha256(
                        f"{workflow_dir.name}/{step_dir.name}/{relative}".encode()
                    ).hexdigest()[:20]
                    artifact_id = f"artifact-{digest}"
                    result[artifact_id] = (
                        {
                            "artifact_id": artifact_id,
                            "step_key": step_dir.name,
                            "workflow": workflow_dir.name,
                            "relative_path": str(relative),
                            "size": resolved.stat().st_size,
                        },
                        resolved,
                    )
        return result

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

    def _create_proposal(self, task, turn, assistant, result):
        proposal_data = result.get("proposal")
        if not isinstance(proposal_data, dict):
            return None
        proposal_type = proposal_data.get("type")
        if proposal_type not in ALLOWED_ACTIONS:
            return None
        target_step_key = (
            proposal_data.get("target_step_key")
            or result.get("target_step_key")
        )
        payload = proposal_data.get("payload")
        if not isinstance(payload, dict):
            payload = {}
        step_keys = {
            row.step_key for row in TaskStep.select().where(TaskStep.task == task)
        }
        if proposal_type != "review_decision" and target_step_key not in step_keys:
            return None
        expected_review_run_id = None
        expected_step_run_id = None
        expected_workflow_run_id = task.active_workflow_run_id
        if proposal_type == "supplement_stage":
            content = str(payload.get("content", "")).strip()
            if not content:
                return None
            payload = {"content": content}
        elif proposal_type == "review_decision":
            review_id = str(payload.get("review_run_id", ""))
            decision = str(payload.get("decision", "")).replace("-", "_")
            if decision not in {"approve", "reject", "force_approve"}:
                return None
            review = ReviewRun.get_or_none(
                (ReviewRun.id == review_id) & (ReviewRun.task == task)
            )
            if review is None or review.decision:
                return None
            target_step_key = review.step_key
            expected_review_run_id = review.id
            expected_step_run_id = review.step_run_id
            expected_workflow_run_id = review.workflow_run_id
            payload = {
                "review_run_id": review.id,
                "decision": decision,
                "comment": payload.get("comment"),
            }
        impact = {
            "target_step_key": target_step_key,
            "summary": self._impact_summary(proposal_type, target_step_key),
        }
        now = utc_now()
        return ActionProposal.create(
            id=str(uuid.uuid4()),
            task=task,
            source_turn=turn,
            source_message=assistant,
            type=proposal_type,
            target_step_key=target_step_key,
            payload_json=json.dumps(payload, ensure_ascii=False),
            impact_json=json.dumps(impact, ensure_ascii=False),
            expected_task_version=task.state_version,
            expected_workflow_run_id=expected_workflow_run_id,
            expected_step_run_id=expected_step_run_id,
            expected_review_run_id=expected_review_run_id,
            status="pending",
            created_at=now,
            updated_at=now,
        )

    def _execute_supplement(self, project_id, task_id, proposal_id, payload):
        with self._project_manager.activate_project_by_id(project_id):
            proposal = ActionProposal.get_by_id(proposal_id)
            task = Task.get_by_id(task_id)
            content = str(payload.get("content", "")).strip()
            if not content:
                raise RuntimeError("Supplement content cannot be empty")
            supplement = StageSupplement.create(
                id=str(uuid.uuid4()),
                task=task,
                step_key=proposal.target_step_key,
                content=content,
                source_proposal=proposal,
                created_sequence=proposal.source_message.sequence or 0,
                created_at=utc_now(),
            )
            task.state_version += 1
            task.updated_at = utc_now()
            task.save()
            return {"supplement_id": supplement.id, "status": "saved"}

    def _begin_action_sync(self, task_id, proposal_id, idempotency_key):
        proposal = ActionProposal.get_or_none(
            (ActionProposal.id == proposal_id)
            & (ActionProposal.task == task_id)
        )
        if proposal is None:
            raise ValueError("Action proposal not found")
        if proposal.status == "succeeded":
            if proposal.confirm_idempotency_key == idempotency_key:
                return {"completed": self._proposal_to_dict(proposal)}
            raise RuntimeError("Action proposal has already executed")
        if proposal.status == "failed" and proposal.type == "rerun_from_stage":
            proposal.status = "pending"
            proposal.error = None
        if proposal.status != "pending":
            raise RuntimeError(f"Action proposal is not pending: {proposal.status}")
        task = Task.get_by_id(task_id)
        if task.state_version != proposal.expected_task_version:
            proposal.status = "expired"
            proposal.error = "Task state changed after this proposal"
            proposal.updated_at = utc_now()
            proposal.save()
            raise RuntimeError(proposal.error)
        proposal.status = "executing"
        proposal.confirm_idempotency_key = idempotency_key
        proposal.confirmed_at = utc_now()
        proposal.updated_at = proposal.confirmed_at
        proposal.save()
        return {
            "type": proposal.type,
            "payload": json.loads(proposal.payload_json),
            "target_step_key": proposal.target_step_key,
            "expected_workflow_run_id": proposal.expected_workflow_run_id,
        }

    @staticmethod
    def _mark_action_failed_sync(proposal_id, error):
        failed = ActionProposal.get_by_id(proposal_id)
        failed.status = "failed"
        failed.error = error
        failed.updated_at = utc_now()
        failed.save()

    def _complete_action_sync(self, proposal_id, result):
        completed = ActionProposal.get_by_id(proposal_id)
        completed.status = "succeeded"
        completed.result_json = json.dumps(result, ensure_ascii=False)
        completed.executed_at = utc_now()
        completed.updated_at = completed.executed_at
        completed.error = None
        completed.save()
        return self._proposal_to_dict(completed)

    def _cancel_action_sync(self, task_id, proposal_id):
        proposal = ActionProposal.get_or_none(
            (ActionProposal.id == proposal_id)
            & (ActionProposal.task == task_id)
        )
        if proposal is None:
            raise ValueError("Action proposal not found")
        if proposal.status != "pending":
            raise RuntimeError(f"Action proposal is not pending: {proposal.status}")
        proposal.status = "cancelled"
        proposal.updated_at = utc_now()
        proposal.save()
        return self._proposal_to_dict(proposal)

    async def _execute_review_decision(
        self,
        project_id,
        task_id,
        proposal,
        payload,
    ):
        handle = await self._workflow_runtime.decide_review(
            project_id,
            task_id,
            proposal["target_step_key"] or "",
            payload["review_run_id"],
            payload["decision"],
            payload.get("comment"),
        )
        return {
            "decision": payload["decision"],
            "resumed": handle is not None,
            "run_id": handle.id if handle else None,
        }

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

    def _impact_summary(self, proposal_type, step_key):
        if proposal_type == "supplement_stage":
            return f"Save context for future attempts of stage '{step_key}'"
        if proposal_type == "review_decision":
            return f"Apply the review decision for stage '{step_key}'"
        return f"Restart stage '{step_key}' and its downstream stages"

    def _proposal_to_dict(self, proposal: ActionProposal) -> dict:
        return {
            "id": proposal.id,
            "type": proposal.type,
            "target_step_key": proposal.target_step_key,
            "payload": json.loads(proposal.payload_json),
            "impact": (
                json.loads(proposal.impact_json) if proposal.impact_json else None
            ),
            "status": proposal.status,
            "result": (
                json.loads(proposal.result_json) if proposal.result_json else None
            ),
            "error": proposal.error,
            "created_at": proposal.created_at,
            "updated_at": proposal.updated_at,
        }

    async def _publish_message_event(
        self,
        task_id: str,
        message: Message,
        event_type: str,
        data: dict,
        event_sequence: int,
    ) -> None:
        """发布出口：内部事件 → AG-UI 标准事件后推送。"""
        payload = {
            "event_id": str(uuid.uuid4()),
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
        """Stop the newest queued/running coordinator turn for a task."""
        def find_turn_id():
            turn = (
                CoordinatorTurn.select()
                .where(
                    (CoordinatorTurn.task == task_id)
                    & (CoordinatorTurn.status.in_(["queued", "running"]))
                )
                .order_by(CoordinatorTurn.created_at.desc())
                .first()
            )
            return turn.id if turn is not None else None

        turn_id = await self._run_db(project_id, find_turn_id)
        if turn_id is None:
            return False
        if turn_id in self._cancelled_turns:
            return True
        self._cancelled_turns.add(turn_id)
        engine = self._running_engines.get(turn_id)
        if engine is not None:
            try:
                await engine.stop()
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
        self._cancelled_turns.discard(turn_id)
        await self._publish_message_event(
            task_id,
            assistant,
            "message_snapshot",
            {"content": assistant.content or ""},
            1,
        )
        await self._publish_message_event(
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
