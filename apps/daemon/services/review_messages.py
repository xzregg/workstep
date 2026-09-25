"""Automatic review message lifecycle for one task runner."""

import asyncio
import json
from pathlib import Path

from agent_assistants.event_journal import JournalRef, TurnEventJournal
from models import Message, StepRun, Task
from models.fields import utc_now
from services.config import config_store
from services.messages import create_task_message, extract_usage_json, new_message_id
from services.pipeline import Step


def _format_issues(issues: list[dict] | None) -> str:
    return "".join(
        f"- {issue.get('description', '')}"
        + (f" → {issue.get('suggestion', '')}" if issue.get("suggestion") else "")
        + "\n"
        for issue in (issues or [])
    )


class AutomaticReviewMessages:
    def __init__(self, journal: TurnEventJournal, run_db, publish):
        self._journal = journal
        self._run_db = run_db
        self._publish = publish

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
                prompt_json=json.dumps({"prompt": review_prompt}, ensure_ascii=False),
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
                "prompt": review_prompt,
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
            message.usage_json = extract_usage_json(list(outcome.events))
            message.started_at = message.started_at or outcome.review_run.started_at
            message.ended_at = outcome.review_run.ended_at
            message.save()
            return message.started_at

        message_started_at = await self._run_db(finalize_review_message)
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
            usage_json=extract_usage_json(list(outcome.events)),
            position=0,
            started_at=outcome.review_run.started_at,
            ended_at=outcome.review_run.ended_at,
            created_at=now,
        ))
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
