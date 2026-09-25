"""Reviewable task archive experience drafts and their live lifecycle."""

import json
import logging
import uuid

from agent_assistants.base import extract_streaming_reply
from agent_assistants.coordinator_context import (
    artifact_index,
    coordinator_root as project_coordinator_root,
)
from agent_assistants.event_journal import TurnEventJournal
from engines.core.agui import AGUIContext, to_agui_events
from engines.core.events import InternalEvent, is_commentary
from models import Message, ReviewRun, Task, TaskStep
from models.fields import utc_now
from services.remote_project import current_actor_event_fields
from streaming.bus import EventBus

logger = logging.getLogger(__name__)


class ArchiveExperienceStopped(RuntimeError):
    """Raised when the user stops an in-flight archive experience draft."""


class ArchiveExperienceDraftService:
    """Own draft generation, progress, stop state, and completed journal handoff."""

    def __init__(
        self, project_manager, event_bus: EventBus, journal: TurnEventJournal,
        resolve_settings, invoke, parse_or_repair, running_engines: dict,
    ):
        self._project_manager = project_manager
        self._event_bus = event_bus
        self._event_journal = journal
        self._resolve_settings = resolve_settings
        self._invoke = invoke
        self._parse_or_repair = parse_or_repair
        self._running_engines = running_engines
        self._active_archive_experience_runs: set[str] = set()
        self._cancelled_archive_experience_runs: set[str] = set()
        self._completed_archive_experience_journals: dict[str, dict] = {}

    async def _run_db(self, project_id: str, operation):
        return await self._project_manager.run_db(
            project_id, lambda _project: operation()
        )

    def clear(self) -> None:
        self._active_archive_experience_runs.clear()
        self._cancelled_archive_experience_runs.clear()
        self._completed_archive_experience_journals.clear()

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
            "Extract reusable error lessons for an archived task; this is not a task summary. "
            "Record only directly evidenced mistakes or pitfalls; omit successes, summaries, "
            "outcomes, and pleasantries. Use at most 3 one-line entries in the format "
            "\"- Error: ...; Cause: ...; Fix: ...\". Keep the total under 600 Chinese "
            "characters equivalent; if there is no error evidence, reply "
            "\"- No reusable error lessons found.\" Do not guess or execute anything. "
            "The content will be reviewed by the user and must not be written to Memory now. "
            f"Return JSON matching this shape: {json.dumps(schema, ensure_ascii=False)}\n\n"
            f"Task evidence:\n{json.dumps(evidence, ensure_ascii=False, default=str)}"
        )
        run_key = self._archive_experience_run_key(
            project_id,
            task_id,
            progress_message_id,
        )
        journal_ref = await self._event_journal.astart(
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
            await self._event_journal.arecord(
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
                        f"Read task record: {len(steps)} steps, "
                        f"{len(reviews)} reviews, {len(messages)} messages."
                    )
                }
            },
        )
        await publish(
            "agent_thought_chunk",
            {"content": {"text": "Submitted to the coordinator; waiting for a response."}},
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
            await self._event_journal.afinish(journal_ref)
            journal_finished = True
            self._completed_archive_experience_journals[run_key] = {
                "event_log_path": journal_ref.relative_path,
                "snapshot": await self._event_journal.asnapshot(journal_ref),
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
                await self._event_journal.afinish(journal_ref)
            self._active_archive_experience_runs.discard(run_key)
            self._cancelled_archive_experience_runs.discard(run_key)

    def _load_archive_evidence_sync(self, project_id: str, task_id: str) -> dict:
        project = self._project_manager.get_project_by_id(project_id)
        task = Task.get_or_none(Task.id == task_id)
        if task is None:
            raise ValueError(f"Task not found: {task_id}")
        settings = self._resolve_settings(task)
        engine_id = settings["engine_id"]
        model = settings["model"]
        fast_model = settings["fast_model"]
        thinking_effort = settings["thinking_effort"]
        provider_id = settings["provider_id"]
        coordinator_root = project_coordinator_root(project, task)
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
                for metadata in artifact_index(project, task).values()
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
