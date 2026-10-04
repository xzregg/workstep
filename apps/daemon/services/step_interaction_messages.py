"""Durable interaction requests and responses during step execution."""

import asyncio

from agent_assistants.event_journal import JournalRef, TurnEventJournal
from engines.core.acp_base import AcpEngineBase
from engines.core.events import InternalEvent
from models import Message
from services.intervention import intervention_manager


class StepInteractionMessages:
    def __init__(self, journal: TurnEventJournal, run_db, publish, snapshot):
        self._journal = journal
        self._run_db = run_db
        self._publish = publish
        self._snapshot = snapshot

    def _persist_projection(self, message_id: str, journal_ref: JournalRef) -> None:
        """Persist a journal checkpoint inside the project database worker."""
        message = Message.get_by_id(message_id)
        self._journal.sync(journal_ref, durable=True)
        projection = self._snapshot(journal_ref)
        message.content = projection["content"]
        message.events_json = projection["events_json"]
        message.event_summary_json = projection["event_summary_json"]
        message.event_count = projection["event_count"]
        message.last_event_seq = projection["last_event_seq"]
        message.save()

    async def begin(
        self, *, task_id: str, step_key: str, event: InternalEvent,
        message_id: str, journal_ref: JournalRef,
    ) -> asyncio.Task:
        """Persist the request before registering and announcing it."""
        try:
            await self._run_db(
                lambda: self._persist_projection(message_id, journal_ref)
            )
        except Message.DoesNotExist:
            pass
        waiter = asyncio.create_task(intervention_manager.request_response(
            event.data["interaction_id"], task_id, step_key, event.data,
        ))
        # The broker must register the request before the UI sees its event.
        await asyncio.sleep(0)
        return waiter

    async def finish(
        self, *, waiter: asyncio.Task, task_id: str, step_key: str,
        event: InternalEvent, engine: AcpEngineBase,
        message_id: str, journal_ref: JournalRef,
        events_collected: list[dict], resolved_model: str | None,
        engine_id: str,
    ) -> None:
        """Write the response before publishing it to the UI."""
        response = await waiter
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
        events_collected.append(response_event.to_dict())
        await self._journal.arecord(journal_ref, response_event.to_dict())
        try:
            await self._run_db(
                lambda: self._persist_projection(message_id, journal_ref)
            )
        except Message.DoesNotExist:
            pass
        await self._publish(task_id, step_key, {
            "channel": "execution",
            "message_id": message_id,
            "engine": engine_id,
            "model": resolved_model,
            "event_sequence": len(events_collected),
            "type": response_event.type,
            "data": {
                **response_event.data,
                "task_id": task_id,
                "step_key": step_key,
            },
        })
