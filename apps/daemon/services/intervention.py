"""Intervention — mid-execution user interaction via WebSocket."""

import asyncio
import json
import logging
import time
from typing import Any

logger = logging.getLogger(__name__)


def seal_unanswered_interactions(events_json: str | None) -> str | None:
    """Append cancelled responses for unanswered interaction requests.

    Runs end without resolving every interaction when the daemon restarts, a
    step is stopped manually, or the engine errors out. Sealing keeps every
    ``interaction_request`` paired with a terminal ``interaction_response``
    so the frontend never rebuilds a stale permission card from history.
    Input without unanswered requests (or invalid input) is returned as-is.
    """
    if not events_json:
        return events_json
    try:
        events = json.loads(events_json)
    except (TypeError, ValueError):
        return events_json
    if not isinstance(events, list):
        return events_json
    answered = {
        str(event["data"].get("interaction_id"))
        for event in events
        if event.get("type") == "interaction_response"
        and isinstance(event.get("data"), dict)
    }
    appended: list[dict[str, Any]] = []
    for event in events:
        if event.get("type") != "interaction_request":
            continue
        data = event.get("data")
        if not isinstance(data, dict):
            continue
        interaction_id = str(data.get("interaction_id") or "")
        if interaction_id and interaction_id not in answered:
            answered.add(interaction_id)
            appended.append({
                "type": "interaction_response",
                "data": {
                    "interaction_id": interaction_id,
                    "method": data.get("method"),
                    "response": {"outcome": {"outcome": "cancelled"}},
                },
                "timestamp": int(time.time() * 1000),
            })
    if not appended:
        return events_json
    return json.dumps([*events, *appended], ensure_ascii=False)


class InterventionManager:
    """Manages pending intervention requests from running engines.

    Flow:
    1. Engine yields an intervention event (permission request, question)
    2. InterventionManager stores it and notifies the event bus
    3. Frontend shows the question to the user
    4. User responds via WebSocket
    5. InterventionManager delivers the response to the waiting engine
    """

    def __init__(self):
        # intervention_id → asyncio.Future waiting for user response
        self._pending: dict[str, asyncio.Future] = {}
        # intervention_id → task_id, used to scope public share responses.
        self._tasks: dict[str, str] = {}
        # intervention_id → step_key, used to unblock a stopped step only.
        self._steps: dict[str, str] = {}

    async def request_response(
        self,
        intervention_id: str,
        task_id: str,
        step_key: str,
        question: dict[str, Any],
    ) -> dict[str, Any]:
        """Called by engine when it needs user input.

        Blocks until the user responds via deliver_response().
        Returns the user's response data.
        """
        future = asyncio.get_event_loop().create_future()
        self._pending[intervention_id] = future
        self._tasks[intervention_id] = task_id
        self._steps[intervention_id] = step_key

        logger.info(
            "Intervention requested: id=%s task=%s step=%s",
            intervention_id, task_id, step_key,
        )

        try:
            # Block until the user responds. No safety timeout: a pending
            # permission/question request waits indefinitely — users skip
            # permissions via engine config instead, and cancel() is the
            # only way to unblock it without a user response.
            return await future
        finally:
            self._pending.pop(intervention_id, None)
            self._tasks.pop(intervention_id, None)
            self._steps.pop(intervention_id, None)

    def deliver_response(
        self,
        intervention_id: str,
        data: dict[str, Any],
        task_id: str | None = None,
    ) -> bool:
        """Called when user responds via WebSocket.

        Delivers the response to the waiting engine.
        Returns True if the intervention was found and delivered.
        """
        if task_id is not None and self._tasks.get(intervention_id) != task_id:
            logger.warning(
                "Intervention %s does not belong to task %s",
                intervention_id,
                task_id,
            )
            return False
        future = self._pending.get(intervention_id)
        if not future:
            logger.warning("No pending intervention: %s", intervention_id)
            return False
        if future.done():
            logger.warning("Intervention already resolved: %s", intervention_id)
            return False

        future.set_result(data)
        logger.info("Intervention delivered: %s", intervention_id)
        return True

    def cancel(self, intervention_id: str) -> bool:
        """Cancel a pending intervention."""
        future = self._pending.pop(intervention_id, None)
        self._tasks.pop(intervention_id, None)
        self._steps.pop(intervention_id, None)
        if future and not future.done():
            future.set_result({"error": "cancelled"})
            return True
        return False

    def cancel_for_task_step(self, task_id: str, step_key: str) -> int:
        """Cancel every pending interaction owned by one running step."""
        matching = [
            intervention_id
            for intervention_id in list(self._pending)
            if self._tasks.get(intervention_id) == task_id
            and self._steps.get(intervention_id) == step_key
        ]
        return sum(self.cancel(intervention_id) for intervention_id in matching)

    def cancel_for_task(self, task_id: str) -> int:
        """Cancel every pending interaction owned by one task."""
        matching = [
            intervention_id
            for intervention_id in list(self._pending)
            if self._tasks.get(intervention_id) == task_id
        ]
        return sum(self.cancel(intervention_id) for intervention_id in matching)

    @property
    def pending_count(self) -> int:
        return len(self._pending)

    def list_pending(self) -> list[str]:
        return list(self._pending.keys())


# Global singleton
intervention_manager = InterventionManager()
