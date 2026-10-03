"""Prepare and finalize durable step execution messages."""

import asyncio
import json
from pathlib import Path
from typing import NamedTuple

from agent_assistants.context_handoff import render_handoff_reference
from agent_assistants.event_journal import JournalRef, TurnEventJournal
from engines.core.acp_base import AcpEngineBase
from engines.core.events import InternalEvent
from models import Message, StepRun, Task
from models.fields import utc_now
from services.artifact_rounds import step_round_dir
from services.intervention import seal_unanswered_interactions
from services.messages import (
    attributed_actor_message_fields, create_task_message, extract_usage_json, new_message_id,
)
from services.pipeline import Step
from services.prompt import (
    assemble_followup_prompt,
    assemble_prompt,
    assemble_retry_prompt,
    render_step_prompt,
    step_worktrees_prompt_path,
)
from services.task_step_start import StartedStepState


class StartedExecution(NamedTuple):
    prompt: str
    message_id: str
    engine_session_id: str | None
    journal_ref: JournalRef


class CompletedExecution(NamedTuple):
    engine: str | None
    model: str | None
    status: str
    usage_json: str | None


class StepExecutionMessages:
    """Own execution prompt, message start, finish, and unavailable engine failure."""

    def __init__(
        self, journal: TurnEventJournal, run_db, publish,
        snapshot, async_snapshot,
        step_followups: dict[str, str], step_trigger_names: dict[str, str],
        initial_user_input_step_key: str | None,
        retry_message_ids: dict[str, str],
    ):
        self._journal = journal
        self._run_db = run_db
        self._publish = publish
        self._snapshot = snapshot
        self._async_snapshot = async_snapshot
        self._step_followups = step_followups
        self._step_trigger_names = step_trigger_names
        self._initial_user_input_step_key = initial_user_input_step_key
        self._retry_message_ids = retry_message_ids

    async def start(
        self, *, task: Task, step: Step, artifacts_dir: Path,
        user_input: str, input_snapshot: dict,
        state: StartedStepState, review_feedback: str,
        engine: AcpEngineBase | None, resolved_model: str | None,
    ) -> StartedExecution:
        step_key = step.key
        capture_input = callable(getattr(engine, "spawn_with_retry", None))
        review_results = list(dict.fromkeys(
            value
            for value in (
                review_feedback,
                state.manual_review_feedback,
                state.rework_feedback,
            )
            if value
        ))
        followup = self._step_followups.get(step_key, "").strip()
        trigger_name = self._step_trigger_names.get(step_key, "").strip()
        if (followup and state.task_step.session_id and engine is not None
                and engine.supports_resume):
            prompt = await asyncio.to_thread(
                assemble_followup_prompt,
                task, step, artifacts_dir, followup,
                state.artifact_round, trigger_name, input_snapshot,
            )
        elif (
            state.task_step.session_id
            and engine is not None
            and engine.supports_resume
            and (review_results or input_snapshot.get("execution_type") == "feedback")
        ):
            prompt = await asyncio.to_thread(
                assemble_retry_prompt,
                task, step, artifacts_dir, input_snapshot,
                state.artifact_round, state.previous_execution_prompt,
            )
        else:
            step_user_input = (
                followup or (
                    user_input
                    if self._initial_user_input_step_key in (None, step_key)
                    else ""
                )
            )
            prompt = await self._run_db(lambda: assemble_prompt(
                task, step, artifacts_dir, step_user_input,
                state.artifact_round, state.input_rounds,
                input_snapshot, trigger_name, capture_input,
            ))
        if state.pending_handoff:
            handoff_reference = await asyncio.to_thread(
                render_handoff_reference, state.pending_handoff,
                artifacts_dir.parent,
            )
            if handoff_reference:
                prompt = f"{handoff_reference}\n\n{prompt}"
        if review_results:
            worktrees_path = await asyncio.to_thread(
                step_worktrees_prompt_path, task, artifacts_dir
            )
            prompt += (
                "\n\n## Previous review feedback\n"
                + "\n\n".join(
                    render_step_prompt(value, task, step, worktrees_path, trigger_name)
                    for value in review_results
                )
            )
            prompt += (
                "\n\nRevise the affected work and preserve correct results. "
                "Write generated artifacts using the declared names, types, "
                "and current-round paths."
            )

        out_dir = (
            step_round_dir(
                artifacts_dir, task.workflow_id, task.id, step_key,
                state.artifact_round,
            )
            if state.artifact_round is not None
            else artifacts_dir / (task.workflow_id or "default") / task.id / step_key
        )
        retry_message_id = self._retry_message_ids.pop(step_key, None)
        msg_id = retry_message_id or new_message_id()
        message_started_at = utc_now()
        engine_session_id = (
            state.task_step.session_id
            if engine is not None and engine.supports_resume else None
        )
        if (
            engine is not None and engine.supports_resume
            and engine_session_id is None and step.engine == "pydantic_ai"
        ):
            engine_session_id = new_message_id() if retry_message_id else msg_id
        journal_ref = await self._journal.astart(
            artifacts_dir.parent, f"task-{task.id}", msg_id,
            (state.step_run.id if retry_message_id and state.step_run is not None
             else engine_session_id),
        )

        def create_message():
            out_dir.mkdir(parents=True, exist_ok=True)
            if retry_message_id:
                message = Message.get(
                    (Message.id == retry_message_id) & (Message.task == task)
                    & (Message.step_key == step_key) & (Message.channel == "execution")
                    & (Message.role == "assistant")
                )
                actor_fields = attributed_actor_message_fields(
                    task, channel="execution", step_key=step_key,
                )
                message.author_id = step.engine
                message.author_username = step.engine
                message.author_name = step.engine
                message.author_type = "assistant"
                for key in ("initiated_by_user_id", "initiated_by_username",
                            "author_device_id", "author_device_name"):
                    setattr(message, key, actor_fields.get(key))
                message.engine = step.engine
                message.model = resolved_model
                message.step_run_id = (
                    state.step_run.id if state.step_run is not None else None
                )
                message.artifact_round = state.artifact_round
                message.run_status = "running"
                message.content = ""
                message.events_json = None
                message.event_log_path = journal_ref.relative_path
                message.event_summary_json = None
                message.event_count = 0
                message.last_event_seq = 0
                message.prompt_json = json.dumps({"prompt": None if capture_input else prompt, "input_prompt": prompt}, ensure_ascii=False)
                message.usage_json = None
                message.started_at = message_started_at
                message.ended_at = None
                message.save()
                return message.created_at
            create_task_message(
                id=msg_id, task=task, channel="execution", step_key=step_key,
                role="assistant", engine=step.engine, model=resolved_model,
                run_id=msg_id,
                step_run_id=(
                    state.step_run.id if state.step_run is not None else None
                ),
                artifact_round=state.artifact_round, run_status="running",
                event_log_path=journal_ref.relative_path,
                prompt_json=json.dumps({"prompt": None if capture_input else prompt, "input_prompt": prompt}, ensure_ascii=False),
                position=1, started_at=message_started_at,
                created_at=message_started_at,
            )
            return message_started_at

        message_created_at = await self._run_db(create_message)
        await self._publish(task.id, step_key, {
            "channel": "execution", "message_id": msg_id,
            "engine": step.engine, "model": resolved_model,
            "event_sequence": 0, "type": "message_started",
            "data": {
                "prompt": None if capture_input else prompt, "artifact_round": state.artifact_round,
                "started_at": message_started_at.isoformat(),
                **({"retry": True} if retry_message_id else {}),
            },
            "created_at": message_created_at.isoformat(),
        })
        return StartedExecution(prompt, msg_id, engine_session_id, journal_ref)

    async def finish(
        self, *, message_id: str,
        journal_ref: JournalRef, events_collected: list[dict],
        succeeded: bool, cancelled: bool, ended_at,
    ) -> CompletedExecution:
        """Seal the execution trace in the project database worker."""
        def finalize_message():
            message = Message.get_by_id(message_id)
            self._journal.finish(journal_ref)
            projection = self._snapshot(journal_ref)
            message.events_json = seal_unanswered_interactions(
                projection["events_json"]
            )
            message.event_summary_json = projection["event_summary_json"]
            message.event_count = projection["event_count"]
            message.last_event_seq = projection["last_event_seq"]
            message.usage_json = extract_usage_json(events_collected)
            message.content = projection["content"]
            message.run_status = (
                "cancelled" if cancelled else "succeeded" if succeeded else "failed"
            )
            message.ended_at = ended_at or utc_now()
            message.save()
            return message.engine, message.model, message.run_status, message.usage_json

        return CompletedExecution(*await self._run_db(finalize_message))

    async def publish_completion(
        self, task_id: str, step_key: str, message_id: str,
        completion: CompletedExecution, event_sequence: int,
    ) -> None:
        """Publish only after the durable completion checkpoint exists."""
        await self._publish(task_id, step_key, {
            "channel": "execution", "message_id": message_id,
            "engine": completion.engine, "model": completion.model,
            "event_sequence": event_sequence,
            "type": "message_completed",
            "data": {"status": completion.status},
        })

    async def fail_unavailable(
        self, *, message_id: str, journal_ref: JournalRef,
        step_run: StepRun | None, error: str,
    ) -> None:
        """Finish the message and step attempt when no engine was created."""
        error_event = InternalEvent(
            type="error", data={"message": error}
        ).to_dict()
        await self._journal.afinish(journal_ref, error_event)
        projection = await self._async_snapshot(journal_ref)

        def persist_failure():
            message = Message.get_by_id(message_id)
            message.events_json = projection["events_json"]
            message.event_summary_json = projection["event_summary_json"]
            message.event_count = projection["event_count"]
            message.last_event_seq = projection["last_event_seq"]
            message.run_status = "failed"
            message.ended_at = utc_now()
            message.save()
            if step_run is not None:
                step_run.status = "failed"
                step_run.error = error
                step_run.ended_at = utc_now()
                step_run.save()

        await self._run_db(persist_failure)
