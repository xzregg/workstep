"""AcpEngineBase — base class for ACP-protocol engines using Python SDK."""

import asyncio
import logging
import os
from typing import AsyncIterator

import acp
from acp import schema

from engines.base import BaseLLMEngine, EngineModel
from engines.schema import EngineImage
from engines.events import InternalEvent, normalize_token_usage

logger = logging.getLogger(__name__)


class _StreamingClient:
    """Receive ACP notifications and apply the configured permission policy."""

    def __init__(self, permission_mode: str | None = None):
        self.updates: asyncio.Queue = asyncio.Queue()
        self.permission_mode = permission_mode
        # tool_call_id → Future[bool], parked by "ask" mode until approve_tool
        self._approval_futures: dict[str, asyncio.Future[bool]] = {}
        self.pending_permissions: list[dict] = []

    @property
    def needs_approval(self) -> bool:
        """Human-in-the-loop mode: every tool call waits for an explicit decision."""
        return self.permission_mode == "ask"

    def resolve_approval(self, tool_call_id: str, approved: bool) -> bool:
        """Resolve a parked permission request; returns False if none is pending."""
        future = self._approval_futures.get(tool_call_id)
        if future is None or future.done():
            return False
        future.set_result(approved)
        return True

    async def session_update(self, session_id, update, **kwargs):
        await self.updates.put(update)

    async def request_permission(self, session_id, tool_call, options, **kwargs):
        tool_call_id = getattr(tool_call, "tool_call_id", None) or getattr(tool_call, "id", None)
        if self.needs_approval and tool_call_id is not None:
            # Park the request until the client calls approve_tool(...).
            future = asyncio.get_running_loop().create_future()
            self._approval_futures[tool_call_id] = future
            self.pending_permissions.append({
                "tool_call_id": tool_call_id,
                "name": getattr(tool_call, "title", "") or "",
                "kind": getattr(tool_call, "kind", None),
                "input": getattr(tool_call, "raw_input", None) or {},
            })
            approved = await future
            self.pending_permissions = [
                pending
                for pending in self.pending_permissions
                if pending.get("tool_call_id") != tool_call_id
            ]
            if not approved:
                return schema.RequestPermissionResponse(
                    outcome=schema.DeniedOutcome(outcome="cancelled")
                )
            selected = next(
                (option for option in options if option.kind == "allow_once"),
                None,
            )
            if selected is None:
                return schema.RequestPermissionResponse(
                    outcome=schema.DeniedOutcome(outcome="cancelled")
                )
            return schema.RequestPermissionResponse(
                outcome=schema.AllowedOutcome(
                    outcome="selected",
                    option_id=selected.option_id,
                )
            )

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
    _live_message_wait_seconds: float = 1.5
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
        self._handler: _StreamingClient | None = None
        self._last_cwd: str | None = None

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
            env=os.environ,
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

    async def _with_agent(self, cwd: str, action):
        """Open a short-lived ACP connection, run ``action(client)``, close it."""
        cmd = self.get_command()
        if not cmd:
            raise RuntimeError(f"{self.ENGINE_ID}: no command configured")
        handler = _StreamingClient(self.get_permission_mode())
        async with acp.spawn_agent_process(
            handler,
            cmd[0],
            *cmd[1:],
            cwd=cwd,
            env=os.environ,
        ) as (client, process):
            self._process = process
            self._running = True
            try:
                await client.initialize(
                    protocol_version=acp.PROTOCOL_VERSION,
                    client_info={"name": "WorkStep", "version": "0.1.0"},
                )
                return await action(client)
            finally:
                self._running = False
                self._process = None

    # --- ACP-aligned session lifecycle (session/*) ---

    @property
    def supports_sessions(self) -> bool:
        return True

    @property
    def supports_tool_approval(self) -> bool:
        return True

    async def create_session(
        self,
        cwd: str,
        add_dirs: list[str] | None = None,
        mcp_servers: list | None = None,
    ) -> str | None:
        """session/new — create a fresh session, return its session id."""

        async def action(client):
            session = await client.new_session(
                cwd=cwd,
                additional_directories=add_dirs or [],
                mcp_servers=mcp_servers or [],
            )
            return session.session_id

        return await self._with_agent(cwd, action)

    async def load_session(
        self,
        session_id: str,
        cwd: str,
        add_dirs: list[str] | None = None,
        mcp_servers: list | None = None,
    ) -> bool:
        """session/load — restore a persisted session's context/memory/config."""

        async def action(client):
            response = await client.load_session(
                cwd=cwd,
                session_id=session_id,
                additional_directories=add_dirs or [],
                mcp_servers=mcp_servers or [],
            )
            return response is not None

        return await self._with_agent(cwd, action)

    async def list_sessions(self, cwd: str | None = None) -> list[str]:
        """session/list — list local archived session ids."""
        if not cwd:
            return []

        async def action(client):
            response = await client.list_sessions(cwd=cwd)
            return [item.session_id for item in (response.sessions or [])]

        return await self._with_agent(cwd, action)

    async def resume_session(
        self,
        session_id: str,
        cwd: str,
        add_dirs: list[str] | None = None,
        mcp_servers: list | None = None,
    ) -> bool:
        """session/resume — restore a session and replay its history."""

        async def action(client):
            response = await client.resume_session(
                session_id=session_id,
                cwd=cwd,
                additional_directories=add_dirs or [],
                mcp_servers=mcp_servers or [],
            )
            return response is not None

        return await self._with_agent(cwd, action)

    async def close_session(self, session_id: str, cwd: str | None = None) -> None:
        """session/close — close a session and release its resources."""
        cwd = cwd or self._last_cwd or "."

        async def action(client):
            await client.close_session(session_id=session_id)

        await self._with_agent(cwd, action)

    async def cancel_session(self, session_id: str, cwd: str | None = None) -> None:
        """session/cancel — force-stop current reasoning / tool execution."""
        cwd = cwd or self._last_cwd or "."

        async def action(client):
            await client.cancel(session_id=session_id)

        await self._with_agent(cwd, action)

    async def set_config_option(
        self,
        config_id: str,
        value: str | bool,
        session_id: str | None = None,
    ) -> None:
        """session/set_config_option — change model / cwd / max turns / permission mode."""
        if not session_id:
            logger.warning(
                "ACP set_config_option(%s) requires session_id; ignored", config_id
            )
            return None

        async def action(client):
            await client.set_config_option(
                config_id=config_id,
                session_id=session_id,
                value=value,
            )

        await self._with_agent(self._last_cwd or ".", action)

    async def reset_options(self, session_id: str | None = None) -> None:
        """session/reset-options — restore process-global defaults.

        ACP has no native reset primitive; agents start from process-global
        defaults with a fresh session (session/new), so this is a no-op.
        """
        logger.info(
            "ACP reset_options: not supported natively (start a new session instead)"
        )
        return None

    async def approve_tool(self, tool_use_id: str, approved: bool = True) -> None:
        """tool_approve — accept or reject a pending tool_call (request_permission)."""
        handler = self._handler
        if handler is None:
            logger.warning("ACP approve_tool: no active session to approve")
            return None
        if not handler.resolve_approval(tool_use_id, approved):
            logger.warning("ACP approve_tool: no pending request for %s", tool_use_id)
        return None

    async def spawn(
        self,
        prompt: str,
        cwd: str,
        model: str | None = None,
        add_dirs: list[str] | None = None,
        session_id: str | None = None,
        images: list[EngineImage] | None = None,
        live_message_queue: asyncio.Queue | None = None,
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
        self._handler = handler
        self._last_cwd = cwd
        try:
            async with acp.spawn_agent_process(
                handler,
                cmd[0],
                *cmd[1:],
                cwd=cwd,
                env=os.environ,
            ) as (client, process):
                self._process = process
                self._running = True

                init_resp = await client.initialize(
                    protocol_version=acp.PROTOCOL_VERSION,
                    client_info={"name": "WorkStep", "version": "0.1.0"},
                )
                logger.info("ACP initialized: %s", init_resp)

                if session_id:
                    try:
                        await client.load_session(
                            cwd=cwd,
                            session_id=session_id,
                            mcp_servers=[],
                            additional_directories=add_dirs or [],
                        )
                        active_session_id = session_id
                    except Exception as exc:
                        logger.warning(
                            "Failed to load session %s (%s); starting a new one",
                            session_id,
                            exc,
                        )
                        session = await client.new_session(
                            cwd=cwd,
                            additional_directories=add_dirs or [],
                            mcp_servers=[],
                        )
                        active_session_id = session.session_id
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

                if live_message_queue is not None:
                    while True:
                        live_items: list[tuple[str, str]] = []
                        while not live_message_queue.empty():
                            live_items.append(live_message_queue.get_nowait())
                        if not live_items:
                            # 轮间等待窗口：任务收尾时刚发出的插入消息不应静默丢失
                            try:
                                first = await asyncio.wait_for(
                                    live_message_queue.get(),
                                    timeout=self._live_message_wait_seconds,
                                )
                            except asyncio.TimeoutError:
                                break
                            live_items = [first]
                            while not live_message_queue.empty():
                                live_items.append(live_message_queue.get_nowait())
                        injected = "\n\n".join(
                            content for _, content in live_items
                        )
                        prompt_task = asyncio.create_task(
                            client.prompt(
                                session_id=active_session_id,
                                prompt=[acp.text_block(injected)],
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
                        await prompt_task
                        for message_id, _ in live_items:
                            yield InternalEvent(type="live_message", data={
                                "message_id": message_id,
                                "status": "delivered",
                                "detail": "",
                            })

                yield InternalEvent(type="status", data={"status": "done"})

        except Exception as e:
            logger.exception("ACP session error")
            yield InternalEvent(type="error", data={"message": str(e)})
        finally:
            self._running = False
            self._process = None
            self._handler = None

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
            data = {
                "id": update.tool_call_id,
                "name": update.title or "",
                "input": update.raw_input or {},
            }
            if self.get_permission_mode() == "ask":
                data["needs_approval"] = True
            return InternalEvent(type="tool_use", data=data)
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

    @property
    def supports_live_stage_message(self) -> bool:
        return True

    def build_resume_params(self, session_id: str) -> dict:
        return {"session_id": session_id}
