"""AcpEngineBase — base class for ACP-protocol engines using Python SDK."""

import asyncio
import logging
from typing import AsyncIterator

import acp
from acp import schema

from engines.base import BaseLLMEngine, EngineModel
from engines.events import InternalEvent, normalize_token_usage

logger = logging.getLogger(__name__)


class _StreamingClient:
    """Receive ACP notifications and apply the configured permission policy."""

    def __init__(self, permission_mode: str | None = None):
        self.updates: asyncio.Queue = asyncio.Queue()
        self.permission_mode = permission_mode

    async def session_update(self, session_id, update, **kwargs):
        await self.updates.put(update)

    async def request_permission(self, session_id, tool_call, options, **kwargs):
        tool_kind = getattr(tool_call, "kind", None)
        should_allow = (
            self.permission_mode is None
            or self.permission_mode in {"auto", "bypassPermissions"}
            or (
                self.permission_mode == "acceptEdits"
                and tool_kind == "edit"
            )
            or (
                self.permission_mode == "plan"
                and tool_kind in {"read", "search", "think", "fetch"}
            )
        )
        preferred_kinds = (
            ("allow_always", "allow_once")
            if self.permission_mode == "bypassPermissions"
            else ("allow_once", "allow_always")
        ) if should_allow else ("reject_once", "reject_always")
        selected = next(
            (
                option
                for preferred_kind in preferred_kinds
                for option in options
                if option.kind == preferred_kind
            ),
            None,
        )
        if selected is None or not should_allow:
            return schema.RequestPermissionResponse(
                outcome=schema.DeniedOutcome(outcome="cancelled")
            )
        return schema.RequestPermissionResponse(
            outcome=schema.AllowedOutcome(
                outcome="selected",
                option_id=selected.option_id,
            )
        )

    async def write_text_file(self, session_id, path, content, **kwargs):
        raise acp.RequestError.method_not_found("fs/write_text_file")

    async def read_text_file(self, session_id, path, line=None, limit=None, **kwargs):
        raise acp.RequestError.method_not_found("fs/read_text_file")


class AcpEngineBase(BaseLLMEngine):
    """Base class for engines that communicate via ACP protocol.

    Subclasses define the command to spawn the ACP agent process.
    The base class handles the ACP session lifecycle and event translation.
    """

    # Subclasses must override these
    COMMAND: list[str] = []
    ENGINE_ID: str = ""
    REQUIRES_PERMISSION_MODE = False

    def __init__(self):
        self._process = None
        self._running = False

    def get_command(self) -> list[str]:
        """Return the command to spawn the ACP agent process."""
        return self.COMMAND

    def get_permission_mode(self) -> str | None:
        return None

    async def list_models(self, cwd: str) -> list[EngineModel]:
        """Read the ACP session's model configuration options."""
        cmd = self.get_command()
        if not cmd:
            return []

        handler = _StreamingClient()
        async with acp.spawn_agent_process(
            handler,
            cmd[0],
            *cmd[1:],
            cwd=cwd,
        ) as (client, process):
            self._process = process
            self._running = True
            try:
                await client.initialize(
                    protocol_version=acp.PROTOCOL_VERSION,
                    client_info={"name": "WorkStep", "version": "0.1.0"},
                )
                session = await client.new_session(
                    cwd=cwd,
                    additional_directories=[],
                    mcp_servers=[],
                )
                model_option = next(
                    (
                        option
                        for option in (session.config_options or [])
                        if getattr(option, "id", None) == "model"
                    ),
                    None,
                )
                if model_option is None:
                    return []

                models: list[EngineModel] = []
                for option in model_option.options:
                    nested = getattr(option, "options", None)
                    choices = nested if nested is not None else [option]
                    for choice in choices:
                        models.append(
                            EngineModel(
                                id=choice.value,
                                label=choice.name,
                                description=choice.description,
                            )
                        )
                return models
            finally:
                self._running = False
                self._process = None

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

        permission_mode = self.get_permission_mode()
        if self.REQUIRES_PERMISSION_MODE and not permission_mode:
            yield InternalEvent(type="error", data={
                "message": "Claude Code 权限模式尚未确认，请先在设置中选择权限模式",
            })
            return

        logger.info("ACP spawn: %s (cwd=%s)", " ".join(cmd), cwd)
        yield InternalEvent(type="status", data={"status": "initializing"})

        handler = _StreamingClient(permission_mode)
        try:
            async with acp.spawn_agent_process(
                handler,
                cmd[0],
                *cmd[1:],
                cwd=cwd,
            ) as (client, process):
                self._process = process
                self._running = True

                init_resp = await client.initialize(
                    protocol_version=acp.PROTOCOL_VERSION,
                    client_info={"name": "WorkStep", "version": "0.1.0"},
                )
                logger.info("ACP initialized: %s", init_resp)

                if session_id:
                    await client.load_session(
                        cwd=cwd,
                        session_id=session_id,
                        mcp_servers=[],
                        additional_directories=add_dirs or [],
                    )
                    active_session_id = session_id
                else:
                    session = await client.new_session(
                        cwd=cwd,
                        additional_directories=add_dirs or [],
                        mcp_servers=[],
                    )
                    active_session_id = session.session_id

                yield InternalEvent(
                    type="session_started",
                    data={"session_id": active_session_id},
                )

                if model:
                    try:
                        await client.set_config_option(
                            config_id="model",
                            session_id=active_session_id,
                            value=model,
                        )
                    except Exception:
                        logger.warning("Failed to set model %s", model)

                yield InternalEvent(type="status", data={"status": "running"})
                prompt_task = asyncio.create_task(
                    client.prompt(
                        session_id=active_session_id,
                        prompt=[acp.text_block(prompt)],
                    )
                )
                while not prompt_task.done() or not handler.updates.empty():
                    try:
                        update = await asyncio.wait_for(
                            handler.updates.get(),
                            timeout=0.1,
                        )
                    except asyncio.TimeoutError:
                        continue
                    event = self._map_notification(update)
                    if event:
                        yield event

                prompt_response = await prompt_task
                usage_event = self._map_prompt_response_usage(prompt_response)
                if usage_event:
                    yield usage_event
                yield InternalEvent(type="status", data={"status": "done"})

        except Exception as e:
            logger.exception("ACP session error")
            yield InternalEvent(type="error", data={"message": str(e)})
        finally:
            self._running = False
            self._process = None

    def _map_notification(self, update) -> InternalEvent | None:
        """Map one ACP session update to the internal event vocabulary."""
        if isinstance(update, schema.AgentMessageChunk):
            if isinstance(update.content, schema.TextContentBlock):
                return InternalEvent(
                    type="text_delta",
                    data={"delta": update.content.text},
                )
        if isinstance(update, schema.AgentThoughtChunk):
            if isinstance(update.content, schema.TextContentBlock):
                return InternalEvent(
                    type="thinking_delta",
                    data={"delta": update.content.text},
                )
        if isinstance(update, schema.ToolCallStart):
            return InternalEvent(
                type="tool_use",
                data={
                    "id": update.tool_call_id,
                    "name": update.title or "",
                    "input": update.raw_input or {},
                },
            )
        if isinstance(update, schema.ToolCallProgress):
            if update.status in ("completed", "failed"):
                return InternalEvent(
                    type="tool_result",
                    data={
                        "tool_use_id": update.tool_call_id,
                        "content": str(update.raw_output or ""),
                        "is_error": update.status == "failed",
                    },
                )
        if isinstance(update, schema.UsageUpdate):
            data = {
                "usage_kind": "context_window",
                "used": update.used,
                "size": update.size,
            }
            if update.cost is not None:
                data["cost"] = {
                    "amount": update.cost.amount,
                    "currency": update.cost.currency,
                }
            return InternalEvent(
                type="usage",
                data=data,
            )
        return None

    @staticmethod
    def _map_prompt_response_usage(response) -> InternalEvent | None:
        usage = getattr(response, "usage", None)
        if usage is None:
            return None
        data = normalize_token_usage({
            "input_tokens": usage.input_tokens,
            "output_tokens": usage.output_tokens,
            "total_tokens": usage.total_tokens,
            "cached_read_tokens": usage.cached_read_tokens,
            "cached_write_tokens": usage.cached_write_tokens,
        })
        if usage.thought_tokens is not None:
            data["thought_tokens"] = usage.thought_tokens
        return InternalEvent(type="usage", data=data)

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
