"""Intervention — mid-execution user interaction via WebSocket."""

import asyncio
import logging
from typing import Any

logger = logging.getLogger(__name__)


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

        logger.info(
            "Intervention requested: id=%s task=%s step=%s",
            intervention_id, task_id, step_key,
        )

        try:
            # Block until user responds (with timeout)
            response = await asyncio.wait_for(future, timeout=300)  # 5 min
            return response
        except asyncio.TimeoutError:
            logger.warning("Intervention timed out: %s", intervention_id)
            return {"error": "timeout", "message": "No response within 5 minutes"}
        finally:
            self._pending.pop(intervention_id, None)

    def deliver_response(self, intervention_id: str, data: dict[str, Any]) -> bool:
        """Called when user responds via WebSocket.

        Delivers the response to the waiting engine.
        Returns True if the intervention was found and delivered.
        """
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
        if future and not future.done():
            future.set_result({"error": "cancelled"})
            return True
        return False

    @property
    def pending_count(self) -> int:
        return len(self._pending)

    def list_pending(self) -> list[str]:
        return list(self._pending.keys())


# Global singleton
intervention_manager = InterventionManager()
