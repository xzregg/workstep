"""AcpEngineBase — base class for ACP-protocol engines using Python SDK."""

import asyncio
import logging
from typing import AsyncIterator

import acp

from engines.base import BaseLLMEngine
from engines.events import InternalEvent

logger = logging.getLogger(__name__)


class AcpEngineBase(BaseLLMEngine):
    """Base class for engines that communicate via ACP protocol.

    Subclasses define the command to spawn the ACP agent process.
    The base class handles the ACP session lifecycle and event translation.
    """

    # Subclasses must override these
    COMMAND: list[str] = []
    ENGINE_ID: str = ""

    def __init__(self):
        self._process = None
        self._running = False

    def get_command(self) -> list[str]:
        """Return the command to spawn the ACP agent process."""
        return self.COMMAND

    async def spawn(
        self,
        prompt: str,
        cwd: str,
        model: str | None = None,
        add_dirs: list[str] | None = None,
        session_id: str | None = None,
    ) -> AsyncIterator[InternalEvent]:
        cmd = self.get_command()
        if not cmd:
            yield InternalEvent(type="error", data={"message": f"{self.ENGINE_ID}: no command configured"})
            return

        logger.info("ACP spawn: %s (cwd=%s)", " ".join(cmd), cwd)
        yield InternalEvent(type="status", data={"status": "initializing"})

        try:
            # Use ACP SDK to spawn and connect
            transport = await acp.spawn_stdio_connection(
                command=cmd[0],
                args=cmd[1:] if len(cmd) > 1 else [],
                cwd=cwd,
            )
        except Exception as e:
            yield InternalEvent(type="error", data={"message": f"ACP spawn failed: {e}"})
            return

        try:
            client = acp.Client(transport)

            # Initialize
            init_resp = await client.initialize(acp.InitializeRequest(
                protocol_version=acp.PROTOCOL_VERSION,
                client_info={"name": "WorkStep", "version": "0.1.0"},
            ))
            logger.info("ACP initialized: %s", init_resp)

            # Create or resume session
            if session_id:
                await client.load_session(acp.LoadSessionRequest(session_id=session_id))
            else:
                await client.new_session(acp.NewSessionRequest())

            # Set model if specified
            if model:
                try:
                    await client.set_session_config_option(
                        acp.SetSessionConfigOptionSelectRequest(
                            option_id="model",
                            value=model,
                        )
                    )
                except Exception:
                    logger.warning("Failed to set model %s", model)

            yield InternalEvent(type="status", data={"status": "running"})

            # Send prompt and stream responses
            async for notification in client.prompt(acp.PromptRequest(
                content=[acp.TextBlock(text=prompt)],
            )):
                event = self._map_notification(notification)
                if event:
                    yield event

            yield InternalEvent(type="status", data={"status": "done"})

        except Exception as e:
            logger.exception("ACP session error")
            yield InternalEvent(type="error", data={"message": str(e)})
        finally:
            self._running = False

    def _map_notification(self, notification: acp.SessionNotification) -> InternalEvent | None:
        """Map ACP session notification to InternalEvent."""
        for update in notification.updates:
            if isinstance(update, acp.AgentMessageChunk):
                if isinstance(update.content, acp.TextBlock):
                    return InternalEvent(type="text_delta", data={"delta": update.content.text})

            if isinstance(update, acp.AgentThoughtChunk):
                if isinstance(update.content, acp.TextBlock):
                    return InternalEvent(type="thinking_delta", data={"delta": update.content.text})

            if isinstance(update, acp.ToolCallUpdate):
                if update.status in ("completed", "failed"):
                    return InternalEvent(type="tool_result", data={
                        "tool_use_id": update.id,
                        "content": str(update.raw_output or ""),
                        "is_error": update.status == "failed",
                    })
                else:
                    return InternalEvent(type="tool_use", data={
                        "id": update.id,
                        "name": update.title or "",
                        "input": {},
                    })

            if isinstance(update, acp.PlanUpdate):
                return None  # Plans not rendered in P1

        return None

    async def stop(self) -> None:
        if self._process:
            self._process.terminate()
            self._running = False

    async def inject_response(self, tool_use_id: str, content: str) -> None:
        logger.info("ACP inject_response: tool_use_id=%s", tool_use_id)

    @property
    def supports_resume(self) -> bool:
        return True

    @property
    def supports_interactive(self) -> bool:
        return True

    def build_resume_params(self, session_id: str) -> dict:
        return {"session_id": session_id}
