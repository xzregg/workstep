"""Automatic review message lifecycle for one task runner."""

import asyncio
import json
from pathlib import Path
from typing import Callable, NamedTuple

from agent_assistants.event_journal import JournalRef, TurnEventJournal
from models import Message, ReviewRun, StepRun, Task, TaskStep, WorkflowRun
from models.fields import utc_now
from services.config import config_store
from services.messages import create_task_message, extract_usage_json, new_message_id
from services.pipeline import Step
from services.review_gate import ReviewGate, ReviewOutcome
from services.step_live_messages import StepLiveMessages


def _format_issues(issues: list[dict] | None) -> str:
    return "".join(
        f"- {issue.get('description', '')}"
        + (f" → {issue.get('suggestion', '')}" if issue.get("suggestion") else "")
        + "\n"
        for issue in (issues or [])
    )


def resolve_review_config(task: Task, step: Step) -> tuple[dict, str]:
    """Apply task overrides and resolve the effective review mode."""
    if step.review is None:
        return {}, "skip"
    config = dict(step.review)
    if task.review_overrides_json:
        try:
            overrides = json.loads(task.review_overrides_json)
            step_override = (
                overrides.get(step.key, {})
                if isinstance(overrides, dict) else {}
            )
            if isinstance(step_override, dict):
                config.update(step_override)
        except (TypeError, json.JSONDecodeError):
            pass
    if config.get("mode") in ("skip", "auto", "manual"):
        mode = str(config["mode"])
    else:
        mode = "auto" if config.get("auto", False) else "manual"
    return config, mode


class ReviewEvaluation(NamedTuple):
    outcome: ReviewOutcome
    gate: ReviewGate
    cancelled: bool
    message_persisted: bool


class ReviewCheckpoint(NamedTuple):
    step_run: StepRun
    execution_output: str
    execution_prompt: str
    saved_review_prompt: str | None
    latest_review_status: str | None


class StepReviewMessages:
    def __init__(
        self, journal: TurnEventJournal, run_db, publish,
        live: StepLiveMessages, *, project_id: str | None = None,
    ):
        self._journal = journal
        self._run_db = run_db
        self._publish = publish
        self._live = live
        self._project_id = project_id

    async def _record_usage(self, task: Task, message_id: str,
                            outcome: ReviewOutcome, usage_json: str | None) -> None:
        if not outcome.review_run.engine:
            return
        from main import gateway_client

        await gateway_client.record_message_usage(
            project_id=self._project_id, task_id=task.id, message_id=message_id,
            run_id=str(outcome.review_run.step_run_id), model=outcome.review_run.model,
            occurred_at=outcome.review_run.ended_at or utc_now(),
            provider=outcome.provider, provider_id=outcome.provider_id,
            usage_json=usage_json, user_id=task.creator_id,
        )

    async def load_checkpoint(
        self, task: Task, step: Step, workflow_run: WorkflowRun,
    ) -> ReviewCheckpoint | None:
        """Load a durable execution checkpoint before resuming its review."""
        def read_checkpoint():
            task_step = TaskStep.get(
                (TaskStep.task == task) & (TaskStep.step_key == step.key)
            )
            if task_step.status != "reviewing":
                return None
            step_run = (
                StepRun.select()
                .where(
                    (StepRun.run == workflow_run)
                    & (StepRun.step_key == step.key)
                )
                .order_by(StepRun.attempt.desc())
                .first()
            )
            if step_run is None or step_run.status != "succeeded":
                return None
            execution_messages = list(
                Message.select().where(
                    (Message.task == task)
                    & (Message.step_run_id == step_run.id)
                    & (Message.channel == "execution")
                    & (Message.role == "assistant")
                ).order_by(Message.sequence)
            )
            latest_review = (
                ReviewRun.select()
                .where(ReviewRun.step_run == step_run)
                .order_by(ReviewRun.attempt.desc())
                .first()
            )
            execution_prompt = ""
            if execution_messages:
                try:
                    prompt_data = json.loads(execution_messages[0].prompt_json or "{}")
                    execution_prompt = str(prompt_data.get("input_prompt", prompt_data.get("prompt")) or "")
                except (TypeError, json.JSONDecodeError):
                    pass
            review_prompt = None
            if latest_review is not None:
                try:
                    prompt_data = json.loads(latest_review.prompt_json or "{}")
                    review_prompt = prompt_data.get("input_prompt", prompt_data.get("prompt"))
                except (TypeError, json.JSONDecodeError):
                    pass
            return ReviewCheckpoint(
                step_run,
                "".join(message.content or "" for message in execution_messages),
                execution_prompt,
                review_prompt,
                latest_review.status if latest_review is not None else None,
            )

        return await self._run_db(read_checkpoint)

    async def evaluate(
        self, *, task: Task, step: Step, step_run: StepRun,
        workflow_run: WorkflowRun, artifacts_dir: Path,
        execution_output: str, execution_prompt: str,
        review_config: dict, mode: str, run_key: str,
        saved_prompt: str | None = None,
        should_interrupt: Callable[[], bool] | None = None,
    ) -> ReviewEvaluation:
        """Run review with its live queue and durable review message."""
        message_id = None
        journal_ref = None
        assembled_prompt = saved_prompt
        segment = None
        review_queue = None
        event_handler = None
        live_handler = None
        if mode == "auto":
            if not assembled_prompt:
                assembled_prompt = await asyncio.to_thread(
                    ReviewGate._assemble_prompt,
                    task, step, artifacts_dir, execution_output,
                    str(review_config.get("prompt", "")),
                    execution_prompt, step_run.artifact_round,
                )
            message_id, journal_ref = await self.start(
                task, step, step_run, artifacts_dir,
                review_config, assembled_prompt,
            )
            segment, review_queue, event_handler, live_handler = (
                await self._live.prepare_review(
                    task, step, step_run, artifacts_dir, run_key,
                    message_id, journal_ref,
                )
            )

        gate = ReviewGate(
            lambda event: self._publish(task.id, step.key, event),
            self._run_db,
            event_handler,
            set_active_engine=lambda engine: self._live.set_engine(run_key, engine),
            live_message_queue=review_queue,
            on_live_message=live_handler,
        )
        outcome = await gate.evaluate(
            task=task, step=step, workflow_run=workflow_run,
            step_run=step_run, artifacts_dir=artifacts_dir,
            execution_output=execution_output,
            execution_prompt=execution_prompt,
            review_config=review_config, mode=mode,
            message_id=message_id,
            artifact_round=step_run.artifact_round,
            assembled_prompt=assembled_prompt if mode == "auto" else None,
        )
        if segment is not None:
            message_id = segment["message_id"]
            journal_ref = segment["journal_ref"]
            await self._live.finish_review(run_key)
        if should_interrupt is not None and should_interrupt():
            raise asyncio.CancelledError
        cancelled = self._live.is_cancelled(run_key)
        if cancelled:
            def mark_review_cancelled():
                review = ReviewRun.get_by_id(outcome.review_run.id)
                review.status = "failed"
                review.error = "手动停止"
                review.ended_at = review.ended_at or utc_now()
                review.save()

            await self._run_db(mark_review_cancelled)
        message_persisted = message_id is not None and journal_ref is not None
        if message_persisted:
            await self.finish(
                task, step.key, message_id, journal_ref,
                outcome, cancelled=cancelled,
            )
        return ReviewEvaluation(outcome, gate, cancelled, message_persisted)

    async def _snapshot(self, ref: JournalRef) -> dict:
        snapshot = await self._journal.asnapshot(ref)
        return {
            "events": snapshot["events"],
            "event_summary_json": json.dumps(snapshot["summary"], ensure_ascii=False),
            "event_count": snapshot["summary"]["event_count"],
            "last_event_seq": snapshot["summary"]["last_event_seq"],
        }

    async def start(
        self,
        task: Task,
        step: Step,
        step_run: StepRun,
        artifacts_dir: Path,
        review_config: dict,
        review_prompt: str,
    ) -> tuple[str, JournalRef]:
        """Persist and publish the review bubble before the reviewer starts."""
        message_id = new_message_id()
        now = utc_now()
        journal_ref = await self._journal.astart(
            artifacts_dir.parent,
            f"task-{task.id}",
            message_id,
        )
        engine = str(review_config.get("engine") or step.engine)
        default_model = await asyncio.to_thread(
            config_store.get_engine_default_model, engine
        )
        model = str(
            review_config.get("model")
            or step.model
            or default_model
            or ""
        )
        await self._run_db(
            lambda: create_task_message(
                id=message_id,
                task=task,
                channel="review",
                step_key=step.key,
                role="assistant",
                content="审核中",
                engine=engine,
                model=model,
                run_id=message_id,
                step_run_id=step_run.id,
                artifact_round=step_run.artifact_round,
                run_status="running",
                prompt_json=json.dumps({"prompt": None, "input_prompt": review_prompt}, ensure_ascii=False),
                event_log_path=journal_ref.relative_path,
                position=0,
                started_at=now,
                created_at=now,
            )
        )
        await self._publish(task.id, step.key, {
            "channel": "review",
            "message_id": message_id,
            "engine": engine,
            "model": model,
            "event_sequence": 0,
            "type": "message_started",
            "data": {
                "role": "assistant",
                "status": "running",
                "content": "审核中",
                "prompt": None,
                "artifact_round": step_run.artifact_round,
            },
            "created_at": now.isoformat(),
        })
        return message_id, journal_ref

    async def finish(
        self,
        task: Task,
        step_key: str,
        message_id: str,
        journal_ref: JournalRef,
        outcome,
        *,
        cancelled: bool = False,
    ) -> None:
        """Finalize the same review bubble with its report and event trace."""
        await self._journal.afinish(journal_ref)
        snapshot = await self._snapshot(journal_ref)
        summary = outcome.report.get("summary", "")
        issues = outcome.report.get("issues", [])
        items = _format_issues(issues)
        usage_json = extract_usage_json(list(outcome.events))
        if cancelled:
            content = "自动审核已手动停止"
        else:
            if outcome.status == "failed":
                content = f"**审核失败**\n{summary}\n{items}"
            else:
                verdict = "通过" if outcome.status == "passed" else "未通过"
                content = f"**审核结果：{verdict}**\n{summary}\n{items}"

        def finalize_review_message():
            message = Message.get_by_id(message_id)
            message.content = content
            message.engine = outcome.review_run.engine
            message.model = outcome.review_run.model
            message.run_status = "cancelled" if cancelled else (
                "failed" if outcome.status == "failed" else "completed"
            )
            message.prompt_json = outcome.review_run.prompt_json
            message.events_json = json.dumps(
                [{
                    "type": "review_context",
                    "data": {"review_run_id": outcome.review_run.id},
                }, *snapshot["events"]],
                ensure_ascii=False,
            )
            message.event_summary_json = snapshot["event_summary_json"]
            message.event_count = snapshot["event_count"]
            message.last_event_seq = snapshot["last_event_seq"]
            message.usage_json = usage_json
            message.started_at = message.started_at or outcome.review_run.started_at
            message.ended_at = outcome.review_run.ended_at
            message.save()
            return message.started_at

        message_started_at = await self._run_db(finalize_review_message)
        await self._record_usage(task, message_id, outcome, usage_json)
        common = {
            "channel": "review",
            "message_id": message_id,
            "engine": outcome.review_run.engine,
            "model": outcome.review_run.model,
            "created_at": message_started_at.isoformat(),
        }
        await self._publish(task.id, step_key, {
            **common,
            "type": "message_snapshot",
            "data": {"content": content},
        })
        await self._publish(task.id, step_key, {
            **common,
            "type": "message_completed",
            "data": {
                "status": "cancelled" if cancelled else (
                    "failed" if outcome.status == "failed" else "completed"
                ),
                "content": content,
                "ended_at": (
                    outcome.review_run.ended_at.isoformat()
                    if outcome.review_run.ended_at else None
                ),
            },
        })

    async def persist_result(
        self,
        task: Task,
        step_key: str,
        step_run: StepRun,
        artifacts_dir: Path,
        artifact_round: int | None,
        outcome,
    ) -> None:
        """Create the completed bubble for manual or fallback review."""
        message_id = new_message_id()
        now = utc_now()
        journal_ref = await self._journal.astart(
            artifacts_dir.parent, f"task-{task.id}", message_id,
        )
        for review_event in outcome.events:
            await self._journal.arecord(journal_ref, review_event)
        await self._journal.afinish(journal_ref)
        snapshot = await self._snapshot(journal_ref)
        summary = outcome.report.get("summary", "")
        items = _format_issues(outcome.report.get("issues", []))
        usage_json = extract_usage_json(list(outcome.events))
        if outcome.status == "awaiting_review":
            content = "等待你审核"
        else:
            verdict = "通过" if outcome.status == "passed" else "未通过"
            content = f"**审核结果：{verdict}**\n{summary}\n{items}"

        await self._run_db(lambda: create_task_message(
            id=message_id,
            task=task,
            channel="review",
            step_key=step_key,
            role="assistant",
            author_type=(
                "system" if outcome.status == "awaiting_review" else "assistant"
            ),
            content=content,
            engine=outcome.review_run.engine,
            model=outcome.review_run.model,
            run_id=message_id,
            step_run_id=step_run.id,
            artifact_round=artifact_round,
            run_status="completed",
            event_log_path=journal_ref.relative_path,
            prompt_json=outcome.review_run.prompt_json,
            events_json=json.dumps(
                [{
                    "type": "review_context",
                    "data": {"review_run_id": outcome.review_run.id},
                }, *snapshot["events"]],
                ensure_ascii=False,
            ),
            event_summary_json=snapshot["event_summary_json"],
            event_count=snapshot["event_count"],
            last_event_seq=snapshot["last_event_seq"],
            usage_json=usage_json,
            position=0,
            started_at=outcome.review_run.started_at,
            ended_at=outcome.review_run.ended_at,
            created_at=now,
        ))
        await self._record_usage(task, message_id, outcome, usage_json)
        common = {
            "channel": "review",
            "message_id": message_id,
            "engine": outcome.review_run.engine,
            "model": outcome.review_run.model,
            "created_at": now.isoformat(),
        }
        await self._publish(task.id, step_key, {
            **common,
            "event_sequence": 0,
            "type": "message_started",
            "data": {"content": content},
        })
        await self._publish(task.id, step_key, {
            **common,
            "event_sequence": 1,
            "type": "message_completed",
            "data": {"status": "completed", "content": content},
        })
