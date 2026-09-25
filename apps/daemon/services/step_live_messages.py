"""Running step engines, injected messages and review message segments."""

import asyncio
import json
import logging
import uuid
from pathlib import Path

from agent_assistants.event_journal import JournalRef, TurnEventJournal
from models import Message, StepRun, StepSupplement, Task
from models.fields import utc_now
from services.intervention import intervention_manager
from services.messages import create_task_message, new_message_id
from services.pipeline import Step

logger = logging.getLogger(__name__)
ENGINE_STOP_TIMEOUT_SECONDS = 10.0


async def _stop_engine_safely(engine: object, run_key: str) -> None:
    """Bound engine shutdown so a broken adapter cannot trap the workflow."""
    try:
        await asyncio.wait_for(
            engine.stop(), timeout=ENGINE_STOP_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError:
        logger.error("Engine stop timed out for %s", run_key)
    except Exception:
        logger.exception("Engine stop raised for %s", run_key)


class StepLiveMessages:
    """Own active engine and message queue state for one task runner."""

    def __init__(self, journal: TurnEventJournal, run_db, publish, ajournal_snapshot):
        self._journal = journal
        self._run_db = run_db
        self._publish = publish
        self._ajournal_snapshot = ajournal_snapshot
        self._running_engines: dict[str, object] = {}
        self._queues: dict[str, asyncio.Queue] = {}
        self._channels: dict[str, str] = {}
        self._prompts: dict[str, str] = {}
        self._cancelled: set[str] = set()

    def has_running_engine(self, run_key: str) -> bool:
        return run_key in self._running_engines

    def is_cancelled(self, run_key: str) -> bool:
        return run_key in self._cancelled

    def discard_cancelled(self, run_key: str) -> None:
        self._cancelled.discard(run_key)

    def is_review_channel(self, run_key: str) -> bool:
        return self._channels.get(run_key) == "review"

    def set_engine(self, run_key: str, engine: object) -> None:
        self._running_engines[run_key] = engine

    def clear_engine(self, run_key: str) -> None:
        self._running_engines.pop(run_key, None)

    def start_execution(self, run_key: str, engine: object) -> asyncio.Queue | None:
        self._cancelled.discard(run_key)
        self._running_engines[run_key] = engine
        capabilities = getattr(engine, "capabilities", None)
        if capabilities is None or not capabilities.supports_live_step_message:
            return None
        queue: asyncio.Queue = asyncio.Queue()
        self._queues[run_key] = queue
        return queue

    def pop_prompt(self, message_id: str, fallback: str) -> str:
        return self._prompts.pop(message_id, fallback)

    @staticmethod
    def _fail_live_message(message_id: str) -> None:
        try:
            message = Message.get_by_id(message_id)
        except Message.DoesNotExist:
            return
        message.run_status = "failed"
        message.ended_at = utc_now()
        message.save()

    async def _drain(self, queue: asyncio.Queue | None) -> None:
        if queue is None:
            return
        while not queue.empty():
            message_id, _ = queue.get_nowait()
            self._prompts.pop(message_id, None)
            await self._run_db(
                lambda mid=message_id: self._fail_live_message(mid)
            )

    async def prepare_review(
        self,
        task: Task,
        step: Step,
        step_run: StepRun,
        artifacts_dir: Path,
        run_key: str,
        message_id: str,
        journal_ref: JournalRef,
    ):
        await self._drain(self._queues.pop(run_key, None))
        self._running_engines.pop(run_key, None)
        queue: asyncio.Queue = asyncio.Queue()
        self._queues[run_key] = queue
        self._channels[run_key] = "review"
        segment = {"message_id": message_id, "journal_ref": journal_ref}

        async def record_event(event: dict) -> None:
            await self._journal.arecord(segment["journal_ref"], event)
            await self._journal.async_flush(segment["journal_ref"])

        async def handle_live_message(data: dict) -> str | None:
            inserted_id = data.get("message_id")
            if not inserted_id:
                return None
            delivered = data.get("status") == "delivered"

            def finish_user_message():
                user_message = Message.get_by_id(inserted_id)
                user_message.run_status = "succeeded" if delivered else "failed"
                user_message.ended_at = utc_now()
                user_message.save()
                return user_message.content

            stored_content = await self._run_db(finish_user_message)
            inserted_prompt = self.pop_prompt(inserted_id, stored_content)
            if not delivered:
                return None

            seal_time = utc_now()
            await self._journal.afinish(segment["journal_ref"])
            snapshot = await self._ajournal_snapshot(segment["journal_ref"])

            def seal_review_message():
                old_message = Message.get_by_id(segment["message_id"])
                old_message.content = snapshot["content"]
                old_message.events_json = snapshot["events_json"]
                old_message.event_summary_json = snapshot["event_summary_json"]
                old_message.event_count = snapshot["event_count"]
                old_message.last_event_seq = snapshot["last_event_seq"]
                old_message.run_status = "succeeded"
                old_message.ended_at = seal_time
                old_message.save()
                return old_message.engine, old_message.model

            engine, model = await self._run_db(seal_review_message)
            await self._publish(task.id, step.key, {
                "channel": "review", "message_id": segment["message_id"],
                "engine": engine, "model": model,
                "type": "message_completed", "data": {"status": "succeeded"},
            })
            next_id = new_message_id()
            next_journal = await self._journal.astart(
                artifacts_dir.parent, f"task-{task.id}", next_id,
            )
            await self._run_db(lambda: create_task_message(
                id=next_id, task=task, channel="review", step_key=step.key,
                role="assistant", content="审核中", engine=engine, model=model,
                run_id=next_id, step_run_id=step_run.id,
                artifact_round=step_run.artifact_round, run_status="running",
                prompt_json=json.dumps({"prompt": inserted_prompt}, ensure_ascii=False),
                event_log_path=next_journal.relative_path,
                position=0, started_at=seal_time, created_at=seal_time,
            ))
            segment.update(message_id=next_id, journal_ref=next_journal)
            await self._publish(task.id, step.key, {
                "channel": "review", "message_id": next_id,
                "engine": engine, "model": model,
                "type": "message_started",
                "data": {"role": "assistant", "status": "running", "content": "审核中",
                         "prompt": inserted_prompt},
                "created_at": seal_time.isoformat(),
            })
            return next_id

        return segment, queue, record_event, handle_live_message

    async def finish_review(self, run_key: str) -> None:
        queue = self._queues.pop(run_key, None)
        self._channels.pop(run_key, None)
        self._running_engines.pop(run_key, None)
        await self._drain(queue)

    async def finish_execution(self, run_key: str) -> bool:
        self._running_engines.pop(run_key, None)
        queue = self._queues.pop(run_key, None)
        self._channels.pop(run_key, None)
        await self._drain(queue)
        cancelled = run_key in self._cancelled
        self._cancelled.discard(run_key)
        return cancelled

    async def cancel_step(self, task_id: str, step_key: str) -> bool:
        """Cancel one engine and its pending interaction, idempotently."""
        run_key = f"{task_id}:{step_key}"
        if run_key in self._cancelled:
            return True
        cancelled_interactions = intervention_manager.cancel_for_task_step(
            task_id, step_key
        )
        engine = self._running_engines.get(run_key)
        if not engine:
            return cancelled_interactions > 0
        self._cancelled.add(run_key)
        await _stop_engine_safely(engine, run_key)
        return True

    async def send_live_message(
        self,
        task_id: str,
        step_key: str,
        content: str,
        as_guidance: bool = False,
    ) -> dict:
        """Persist and queue a user message for the running execution/review."""
        normalized = content.strip()
        if not normalized:
            raise ValueError("消息内容不能为空")
        run_key = f"{task_id}:{step_key}"
        engine = self._running_engines.get(run_key)
        if engine is None:
            raise ValueError(f"步骤未在运行: {step_key}")
        capabilities = getattr(engine, "capabilities", None)
        if capabilities is None or not capabilities.supports_live_step_message:
            raise ValueError("该引擎不支持执行中消息注入")
        queue = self._queues.get(run_key)
        if queue is None:
            raise ValueError("步骤消息队列不可用")
        channel = self._channels.get(run_key, "execution")
        now = utc_now()
        message_id = new_message_id()

        def persist_live_message():
            try:
                task = Task.get_by_id(task_id)
            except Task.DoesNotExist:
                raise ValueError(f"任务不存在: {task_id}")
            message = create_task_message(
                id=message_id, task=task, channel=channel, step_key=step_key,
                role="user", content=normalized, run_id=message_id,
                run_status="running", position=0, started_at=now,
                created_at=now,
            )
            trigger_name = message.author_name or task.creator_name or ""
            injected_content = (
                f"## Triggered by\n{trigger_name}\n\n## User message\n{normalized}"
                if trigger_name else normalized
            )
            if as_guidance:
                StepSupplement.create(
                    id=str(uuid.uuid4()), task=task, step_key=step_key,
                    content=normalized, source_proposal=None,
                    origin="live_guidance",
                    created_sequence=(
                        task.next_message_sequence - 1
                        if task.next_message_sequence > 0 else 0
                    ),
                    created_at=now,
                )
                task.state_version += 1
                task.save()
            return message.sequence, injected_content

        sequence, injected_content = await self._run_db(persist_live_message)
        self._prompts[message_id] = injected_content
        await self._publish(task_id, step_key, {
            "channel": channel,
            "message_id": message_id,
            "type": "message_started",
            "data": {
                "content": normalized,
                "status": "queued",
                "role": "user",
                "as_guidance": as_guidance,
            },
        })
        queue.put_nowait((message_id, injected_content))
        return {
            "message_id": message_id,
            "step_key": step_key,
            "channel": channel,
            "status": "queued",
            "sequence": sequence,
            "created_at": now.isoformat(),
        }

    async def cancel_task(self, task_id: str) -> bool:
        cancelled_interactions = intervention_manager.cancel_for_task(task_id)
        prefix = f"{task_id}:"
        run_keys = [
            run_key for run_key in self._running_engines
            if run_key.startswith(prefix)
        ]
        if not run_keys:
            return cancelled_interactions > 0
        for run_key in run_keys:
            self._cancelled.add(run_key)
        await asyncio.gather(*(
            _stop_engine_safely(self._running_engines[run_key], run_key)
            for run_key in run_keys
        ))
        return True

    async def stop_for_shutdown(self) -> None:
        running_engines = list(self._running_engines.items())
        for run_key, _engine in running_engines:
            task_id, _separator, _step_key = run_key.partition(":")
            intervention_manager.cancel_for_task(task_id)
        await asyncio.gather(*(
            _stop_engine_safely(engine, run_key)
            for run_key, engine in running_engines
        ))
        self._running_engines.clear()
