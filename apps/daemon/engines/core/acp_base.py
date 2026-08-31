"""AcpEngineBase — base class for ACP-protocol engines using Python SDK."""

import asyncio
import json
import logging
import os
import time
import uuid
from inspect import isawaitable
from contextlib import suppress
from typing import Any, AsyncIterator

import acp
from acp import schema

from engines.core.base import (
    BaseLLMEngine,
    EngineModel,
    EngineTestResult,
    resolve_thinking_effort,
)
from engines.core.schema import EngineImage
from engines.core.events import (
    InternalEvent,
    acp_raw_event,
    agent_message_chunk,
    agent_thought_chunk,
    normalize_token_usage,
    tool_call_event,
    tool_call_update_event,
    usage_update_event,
    user_message_chunk,
)
from engines.core.interactions import (
    claude_ask_user_request,
    elicitation_request,
    interaction_from_tool_use,
    permission_request,
    permission_signature,
)
from engines.core.plans import NativePlanTracker, plan_event

logger = logging.getLogger(__name__)


#: 完整 ACP 事件词汇：所有引擎（ACP 原生或非 ACP 适配）对外统一产出的内部事件。
#: 非 ACP 引擎声明自己的 ``acp_events`` 子集；未知来源事件不合成。
ACP_EVENTS: frozenset[str] = frozenset({
    "agent_message_chunk",
    "agent_thought_chunk",
    "user_message_chunk",
    "tool_call",
    "tool_call_update",
    "plan",
    "plan_update",
    "plan_removed",
    "usage_update",
    "session_info_update",
    "available_commands_update",
    "config_option_update",
    "current_mode_update",
    "mcp_message",
    "elicitation_completed",
    "interaction_request",
    "interaction_response",
    "status",
    "session_started",
    "live_message",
    "engine_state",
    "compacted",
    "subagent",
    "error",
    "acp_raw",
})


class _StreamingClient:
    """Receive ACP notifications and apply the configured permission policy."""

    def __init__(self, permission_mode: str | None = None):
        self.updates: asyncio.Queue = asyncio.Queue()
        self.permission_mode = permission_mode
        # tool_call_id → Future[option_id | None], parked until the UI responds.
        self._approval_futures: dict[str, asyncio.Future[str | None]] = {}
        self._default_allow_options: dict[str, str | None] = {}
        self._elicitation_futures: dict[str, asyncio.Future[dict]] = {}
        self.pending_permissions: list[dict] = []

    @property
    def needs_approval(self) -> bool:
        """Human-in-the-loop mode: every tool call waits for an explicit decision."""
        return self.permission_mode == "ask"

    def resolve_approval(self, tool_call_id: str, approved: bool) -> bool:
        """Resolve a parked permission request; returns False if none is pending."""
        option_id = self._default_allow_options.get(tool_call_id) if approved else None
        return self.resolve_permission(tool_call_id, option_id)

    def resolve_permission(self, tool_call_id: str, option_id: str | None) -> bool:
        """Resolve a parked permission with the exact ACP option selected."""
        future = self._approval_futures.get(tool_call_id)
        if future is None or future.done():
            return False
        future.set_result(option_id)
        return True

    async def session_update(self, session_id, update, **kwargs):
        await self.updates.put(update)

    def resolve_elicitation(
        self,
        interaction_id: str,
        response: dict,
    ) -> bool:
        future = self._elicitation_futures.get(interaction_id)
        if future is None or future.done():
            return False
        future.set_result(response)
        return True

    async def create_elicitation(self, message, mode, **kwargs):
        """Surface ACP form elicitation and await the user's structured input."""
        mode = getattr(mode, "root", mode)
        requested_schema = getattr(mode, "requested_schema", None)
        if requested_schema is None:
            return schema.DeclineElicitationResponse(action="decline")
        dump = getattr(requested_schema, "model_dump", None)
        schema_data = (
            dump(by_alias=False, exclude_none=True)
            if callable(dump)
            else requested_schema
        )
        interaction_id = str(uuid.uuid4())
        future = asyncio.get_running_loop().create_future()
        self._elicitation_futures[interaction_id] = future
        await self.updates.put(elicitation_request(
            interaction_id=interaction_id,
            message=str(message),
            requested_schema=schema_data,
            session_id=getattr(mode, "session_id", None),
            tool_call_id=getattr(mode, "tool_call_id", None),
        ))
        try:
            response = await future
        finally:
            self._elicitation_futures.pop(interaction_id, None)
        action = response.get("action")
        if action == "accept":
            content = response.get("content")
            return schema.AcceptElicitationResponse(
                action="accept",
                content=content if isinstance(content, dict) else {},
            )
        if action == "decline":
            return schema.DeclineElicitationResponse(action="decline")
        return schema.CancelElicitationResponse(action="cancel")

    async def request_permission(self, session_id, tool_call, options, **kwargs):
        tool_call_id = getattr(tool_call, "tool_call_id", None) or getattr(tool_call, "id", None)
        if self.needs_approval and tool_call_id is not None:
            # Park the request until the client calls approve_tool(...).
            future = asyncio.get_running_loop().create_future()
            self._approval_futures[tool_call_id] = future
            allow_option = next(
                (option for option in options if option.kind == "allow_once"),
                None,
            )
            self._default_allow_options[tool_call_id] = getattr(
                allow_option, "option_id", None
            )
            self.pending_permissions.append({
                "tool_call_id": tool_call_id,
                "name": getattr(tool_call, "title", "") or "",
                "kind": getattr(tool_call, "kind", None),
                "input": getattr(tool_call, "raw_input", None) or {},
            })
            await self.updates.put(permission_request(
                interaction_id=tool_call_id,
                session_id=str(session_id),
                tool_call={
                    "tool_call_id": tool_call_id,
                    "title": getattr(tool_call, "title", "") or "",
                    "kind": getattr(tool_call, "kind", None),
                    "raw_input": getattr(tool_call, "raw_input", None) or {},
                },
                options=[{
                    "option_id": str(getattr(option, "option_id", "")),
                    "name": str(
                        getattr(option, "name", "")
                        or getattr(option, "kind", "")
                    ),
                    "kind": str(getattr(option, "kind", "")),
                } for option in options],
            ))
            selected_option_id = await future
            self.pending_permissions = [
                pending
                for pending in self.pending_permissions
                if pending.get("tool_call_id") != tool_call_id
            ]
            self._approval_futures.pop(tool_call_id, None)
            self._default_allow_options.pop(tool_call_id, None)
            if not selected_option_id:
                return schema.RequestPermissionResponse(
                    outcome=schema.DeniedOutcome(outcome="cancelled")
                )
            selected = next(
                (
                    option for option in options
                    if option.option_id == selected_option_id
                ),
                None,
            )
            if selected is None or str(selected.kind).startswith("reject"):
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

    async def complete_elicitation(self, elicitation_id: str, **kwargs):
        """Agent 通知 elicitation 已完成（独立于 session/update 通道）。

        进入 session update 队列，由 ``_map_notification`` 翻译为
        ``elicitation_completed`` 事件。
        """
        await self.updates.put(schema.CompleteElicitationNotification(
            elicitation_id=elicitation_id,
        ))

    async def create_terminal(self, session_id, command, **kwargs):
        raise acp.RequestError.method_not_found("terminal/create")

    async def kill_terminal(self, session_id, terminal_id, **kwargs):
        raise acp.RequestError.method_not_found("terminal/kill")

    async def release_terminal(self, session_id, terminal_id, **kwargs):
        raise acp.RequestError.method_not_found("terminal/release")

    async def terminal_output(self, session_id, terminal_id, **kwargs):
        raise acp.RequestError.method_not_found("terminal/output")

    async def wait_for_terminal_exit(self, session_id, terminal_id, **kwargs):
        raise acp.RequestError.method_not_found("terminal/wait_for_exit")

    async def ext_method(self, method: str, params: dict) -> dict:
        raise acp.RequestError.method_not_found(f"_{method}")

    async def ext_notification(self, method: str, params: dict) -> None:
        return None

    def on_connect(self, conn) -> None:
        return None


class AcpEngineBase(BaseLLMEngine):
    ACP_COMMAND_DISCOVERY_TIMEOUT = 0.5
    ACP_COMMAND_CACHE_TTL = 30.0
    _acp_command_cache: dict[tuple[str, str], tuple[float, list[dict[str, str]]]] = {}
    """ACP 协议基类 — 所有引擎统一继承。

    协议侧（spawn / stop / session / interaction / approval / 协调器）在本类实现：
    ACP 原生引擎（提供 ``get_command()``，如 Hermes）直接使用 ACP 客户端实现；
    非 ACP 引擎用自己的传输覆盖 ``spawn``，仍产出 ACP 词汇事件。自定义函数
    （安装 / 版本 / 配置 / 能力声明）来自 ``BaseLLMEngine``。
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
        # tool_call_id → 待审批的 interaction_request 事件（非 ACP 引擎的
        # request_permission 在 request_interaction 中登记，approve_tool*
        # 据此把决定写回挂起的 Future）。
        self._pending_approvals: dict[str, InternalEvent] = {}

    def get_command(self) -> list[str]:
        """Return the command to spawn the ACP agent process."""
        return self.COMMAND

    def get_permission_mode(self) -> str | None:
        return None

    async def inspect_capabilities(
        self,
        project_root: str | None = None,
    ) -> dict | None:
        result = await super().inspect_capabilities(project_root)
        if result is None or not self._is_acp_native or not project_root:
            return result
        commands = await self._inspect_acp_commands(str(project_root))
        existing_names = {item["name"] for item in result["input_items"]}
        result["input_items"] = result["input_items"] + [
            item
            for item in commands
            if item["name"] not in existing_names
        ]
        return result

    async def _inspect_acp_commands(self, cwd: str) -> list[dict[str, str]]:
        cache_key = (self.ENGINE_ID, str(os.path.realpath(cwd)))
        cached = self._acp_command_cache.get(cache_key)
        now = time.monotonic()
        if cached is not None and now - cached[0] < self.ACP_COMMAND_CACHE_TTL:
            return [dict(item) for item in cached[1]]

        commands: list[dict[str, str]] = []
        session_id: str | None = None
        handler = _StreamingClient(self.get_permission_mode())
        skill_env = self.project_skill_env(cwd)
        cmd = self.get_command()
        try:
            process_env = dict(os.environ)
            process_env.update(skill_env)
            async with acp.spawn_agent_process(
                handler,
                cmd[0],
                *cmd[1:],
                cwd=cwd,
                env=process_env,
            ) as (client, process):
                self._process = process
                self._running = True
                await client.initialize(
                    protocol_version=acp.PROTOCOL_VERSION,
                    client_capabilities=self._client_capabilities(),
                    client_info={"name": "WorkStep", "version": "0.1.0"},
                )
                session = await client.new_session(
                    cwd=cwd,
                    additional_directories=[],
                    mcp_servers=[],
                )
                session_id = session.session_id
                deadline = time.monotonic() + self.ACP_COMMAND_DISCOVERY_TIMEOUT
                while time.monotonic() < deadline:
                    remaining = deadline - time.monotonic()
                    try:
                        update = await asyncio.wait_for(
                            handler.updates.get(),
                            timeout=remaining,
                        )
                    except asyncio.TimeoutError:
                        break
                    if isinstance(update, schema.AvailableCommandsUpdate):
                        commands = [
                            self._acp_command_input_item(command)
                            for command in update.available_commands
                        ]
                        break
                if session_id:
                    with suppress(Exception):
                        await client.close_session(session_id=session_id)
        except Exception as exc:
            logger.info("ACP command discovery failed for %s: %s", self.ENGINE_ID, exc)
        finally:
            self._running = False
            self._process = None

        self._acp_command_cache[cache_key] = (now, commands)
        return [dict(item) for item in commands]

    @staticmethod
    def _acp_command_input_item(command) -> dict[str, str]:
        item = {
            "kind": "command",
            "name": command.name,
            "description": command.description,
            "insert_text": f"/{command.name} ",
            "action": "prompt",
        }
        command_input = getattr(command, "input", None)
        command_input = getattr(command_input, "root", command_input)
        hint = getattr(command_input, "hint", None)
        if hint:
            item["input_hint"] = hint
        return item

    @property
    def _is_acp_native(self) -> bool:
        """Whether this engine drives an ACP agent process (has a command).

        非 ACP 引擎继承 AcpEngineBase 但用自己的传输实现 ``spawn``，
        不声明会话 / 审批 / 直播消息能力，会话方法保持安全默认。
        """
        return bool(self.get_command())

    def _pending_approvals_dict(self) -> dict[str, InternalEvent]:
        """Lazily create the pending-approval registry (subclasses may skip
        ``super().__init__``)."""
        pending = getattr(self, "_pending_approvals", None)
        if pending is None:
            pending = {}
            self._pending_approvals = pending
        return pending

    @staticmethod
    def _client_capabilities():
        return schema.ClientCapabilities(
            elicitation=schema.ElicitationCapabilities(
                form=schema.ElicitationFormCapabilities(),
                url=schema.ElicitationUrlCapabilities(),
            ),
        )

    async def list_models(self, cwd: str) -> list[EngineModel]:
        """Read the ACP session's model configuration options."""
        skill_env = self.project_skill_env(cwd)
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
                    client_capabilities=self._client_capabilities(),
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
                    client_capabilities=self._client_capabilities(),
                    client_info={"name": "WorkStep", "version": "0.1.0"},
                )
                return await action(client)
            finally:
                self._running = False
                self._process = None

    # --- ACP-aligned session lifecycle (session/*) ---

    @property
    def supports_sessions(self) -> bool:
        """Whether this engine exposes ACP-style sessions (ACP native only)."""
        return self._is_acp_native

    @property
    def supports_tool_approval(self) -> bool:
        """Whether pending tool calls can be approved (ACP native only)."""
        return self._is_acp_native

    async def create_session(
        self,
        cwd: str,
        add_dirs: list[str] | None = None,
        mcp_servers: list | None = None,
    ) -> str | None:
        """session/new — create a fresh session, return its session id."""
        if not self._is_acp_native:
            return None

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
        if not self._is_acp_native:
            return False

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
        if not self._is_acp_native:
            return []
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
        if not self._is_acp_native:
            return False

        async def action(client):
            response = await client.resume_session(
                session_id=session_id,
                cwd=cwd,
                additional_directories=add_dirs or [],
                mcp_servers=mcp_servers or [],
            )
            return response is not None

        return await self._with_agent(cwd, action)

    async def fork_session(
        self,
        session_id: str,
        cwd: str,
        *,
        fork_point: str | None = None,
        model: str | None = None,
        provider_id: str | None = None,
    ) -> str | None:
        """Create an independent native session fork when the adapter supports it."""
        return None

    async def close_session(self, session_id: str, cwd: str | None = None) -> None:
        """session/close — close a session and release its resources."""
        if not self._is_acp_native:
            return None
        cwd = cwd or self._last_cwd or "."

        async def action(client):
            await client.close_session(session_id=session_id)

        await self._with_agent(cwd, action)

    async def cancel_session(self, session_id: str, cwd: str | None = None) -> None:
        """session/cancel — force-stop current reasoning / tool execution."""
        if not self._is_acp_native:
            return None
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
        if not self._is_acp_native:
            return None
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
        if not self._is_acp_native:
            return None
        logger.info(
            "ACP reset_options: not supported natively (start a new session instead)"
        )
        return None

    async def approve_tool(self, tool_use_id: str, approved: bool = True) -> None:
        """tool_approve — accept or reject a pending tool_call (request_permission)."""
        event = self._pending_approvals_dict().get(tool_use_id)
        if event is not None:
            # 非 ACP 引擎：审批请求经 request_interaction 挂起，
            # 按选项 kind 选择 allow/reject 语义后写回 Future。
            kind_prefix = "allow" if approved else "reject"
            option_id = next(
                (
                    str(option.get("option_id") or "")
                    for option in (event.data.get("options") or [])
                    if str(option.get("kind") or "").startswith(kind_prefix)
                ),
                None,
            )
            await self.approve_tool_option(tool_use_id, option_id)
            return None
        if not self._is_acp_native:
            return None
        handler = self._handler
        if handler is None:
            logger.warning("ACP approve_tool: no active session to approve")
            return None
        if not handler.resolve_approval(tool_use_id, approved):
            logger.warning("ACP approve_tool: no pending request for %s", tool_use_id)
        return None

    async def approve_tool_option(
        self,
        tool_use_id: str,
        option_id: str | None,
    ) -> None:
        event = self._pending_approvals_dict().get(tool_use_id)
        if event is not None:
            interaction_id = str(event.data.get("interaction_id") or "")
            pending = getattr(self, "_pending_interaction_responses", {})
            future = pending.get(interaction_id)
            if future is not None and not future.done():
                future.set_result({
                    "outcome": {"outcome": "selected", "option_id": option_id},
                })
                return None
            logger.warning(
                "approve_tool_option: no pending interaction for %s", tool_use_id
            )
            return None
        if not self._is_acp_native:
            return None
        handler = self._handler
        if handler is None:
            logger.warning("ACP approve_tool_option: no active session")
            return None
        if not handler.resolve_permission(tool_use_id, option_id):
            logger.warning("ACP approve_tool_option: no pending request for %s", tool_use_id)
        return None

    async def respond_interaction(
        self,
        request: dict[str, Any],
        response: dict[str, Any],
    ) -> bool:
        """Return a UI response to the adapter using ACP response semantics."""
        if request.get("method") == "elicitation/create":
            handler = getattr(self, "_handler", None)
            if handler is not None:
                interaction_id = str(request.get("interaction_id") or "")
                if handler.resolve_elicitation(interaction_id, response):
                    return True
        interaction_id = str(request.get("interaction_id") or "")
        pending = getattr(self, "_pending_interaction_responses", {})
        future = pending.get(interaction_id)
        if future is not None and not future.done():
            future.set_result(response)
            return True

        method = str(request.get("method") or "")
        if method == "session/request_permission":
            tool_call = request.get("tool_call") or {}
            tool_use_id = str(
                tool_call.get("tool_call_id")
                or tool_call.get("id")
                or request.get("interaction_id")
                or ""
            )
            outcome = response.get("outcome") or {}
            option_id = (
                str(outcome.get("option_id"))
                if outcome.get("outcome") == "selected" and outcome.get("option_id")
                else None
            )
            selected_option = next(
                (
                    option for option in (request.get("options") or [])
                    if str(option.get("option_id") or "") == option_id
                ),
                None,
            )
            if selected_option and str(selected_option.get("kind") or "").startswith(
                "reject"
            ):
                option_id = None
            await self.approve_tool_option(tool_use_id, option_id)
            return True

        if method == "elicitation/create":
            tool_use_id = str(
                request.get("tool_call_id")
                or request.get("interaction_id")
                or ""
            )
            if response.get("action") == "accept":
                content = response.get("content") or {}
            else:
                content = {"action": response.get("action") or "cancel"}
            await self.inject_response(
                tool_use_id,
                json.dumps(content, ensure_ascii=False),
            )
            return True
        return False

    async def spawn(
        self,
        prompt: str,
        cwd: str,
        model: str | None = None,
        add_dirs: list[str] | None = None,
        session_id: str | None = None,
        images: list[EngineImage] | None = None,
        live_message_queue: asyncio.Queue | None = None,
        config_overrides: dict | None = None,
        thinking_effort: str | None = None,
    ) -> AsyncIterator[InternalEvent]:
        provider_runtime = self.resolve_provider_runtime(
            provider_id=str((config_overrides or {}).get("provider_id") or ""),
            model=model,
        )
        model = provider_runtime.model
        skill_env = self.project_skill_env(cwd)
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
            process_env = (
                provider_runtime.child_env()
                if provider_runtime.provider_id
                else dict(os.environ)
            )
            process_env.update(skill_env)
            async with acp.spawn_agent_process(
                handler,
                cmd[0],
                *cmd[1:],
                cwd=cwd,
                env=process_env,
            ) as (client, process):
                self._process = process
                self._running = True

                init_resp = await client.initialize(
                    protocol_version=acp.PROTOCOL_VERSION,
                    client_capabilities=self._client_capabilities(),
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
                        logger.warning("Failed to load session %s: %s", session_id, exc)
                        yield InternalEvent(type="error", data={
                            "message": f"无法恢复 ACP 会话 {session_id}: {exc}",
                            "session_id": session_id,
                        })
                        return
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

                effort = resolve_thinking_effort(thinking_effort)
                if effort:
                    # 思考强度不是 ACP 协议固定字段：各 agent 通过 session
                    # config options 声明（如 Codex 的 reasoning_effort）。
                    # 按常见 configId 尽力设置，不支持时忽略。
                    try:
                        await client.set_config_option(
                            config_id="reasoning_effort",
                            session_id=active_session_id,
                            value=effort,
                        )
                    except Exception:
                        logger.warning(
                            "ACP agent does not accept reasoning_effort=%s",
                            effort,
                        )

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
                            # 插入队列已空：回复即收尾，不等待未来消息。
                            break
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

    #: 完整 ACP 事件词汇（capability 元数据）。ACP 原生引擎继承即声明全集；
    #: 非 ACP 引擎在自己的适配器中覆盖声明实际产出的事件集合（有原生来源才产出）。
    acp_events: set[str] = ACP_EVENTS

    # --- 连接测试（协议验证工具） ---

    async def test_connection(
        self,
        cwd: str,
        timeout_seconds: float = 30,
    ) -> EngineTestResult:
        """Run a harmless minimal conversation through this engine.

        Adapters with a cheaper native health check may override this method.
        """
        started = time.monotonic()
        text_parts: list[str] = []
        errors: list[str] = []

        async def collect_events():
            async for event in self.spawn(
                prompt=(
                    "Reply with WORKSTEP_ENGINE_OK only. "
                    "Do not use tools and do not modify files."
                ),
                cwd=cwd,
            ):
                if event.type == "agent_message_chunk":
                    content = event.data.get("content") or {}
                    text_parts.append(str(content.get("text", "")))
                elif event.type == "error":
                    errors.append(
                        str(
                            event.data.get("message")
                            or event.data.get("error")
                            or "引擎返回错误"
                        )
                    )

        try:
            await asyncio.wait_for(collect_events(), timeout=timeout_seconds)
        except asyncio.TimeoutError:
            with suppress(Exception):
                await self.stop()
            return EngineTestResult(
                success=False,
                message=f"测试超时（{timeout_seconds:g} 秒）",
                duration_ms=round((time.monotonic() - started) * 1000),
            )
        except Exception as exc:
            with suppress(Exception):
                await self.stop()
            return EngineTestResult(
                success=False,
                message=str(exc) or "引擎启动失败",
                duration_ms=round((time.monotonic() - started) * 1000),
            )

        duration_ms = round((time.monotonic() - started) * 1000)
        if errors:
            return EngineTestResult(False, errors[0], duration_ms)
        if not "".join(text_parts).strip():
            return EngineTestResult(False, "引擎未返回文本", duration_ms)
        return EngineTestResult(True, "连接和对话测试通过", duration_ms)

    # --- 协调器（ACP 风格入口：无工具时只读，启用内部工具时可调用） ---

    def _coordinator_prompt(
        self,
        prompt: str,
        *,
        workstep_tools: bool = False,
    ) -> str:
        """Apply the coordinator guard.

        The read-only guard applies only when the assistant layer did not
        enable WorkStep internal tools (loading is driven by the assistant
        config, not this seam). With tools enabled the seam keeps the
        propose-don't-execute discipline but allows ``workstep_call``.
        """
        if workstep_tools:
            return self.coordinator_tools_guard(prompt)
        return self.coordinator_guard(prompt)

    async def spawn_coordinator(
        self,
        prompt: str,
        cwd: str,
        model: str | None = None,
        session_id: str | None = None,
        images: list[EngineImage] | None = None,
        message_history: list | None = None,
        report_engine_state: bool = False,
        thinking_effort: str | None = None,
        workstep_tools: bool = False,
        config_overrides: dict | None = None,
    ) -> AsyncIterator[InternalEvent]:
        """Run a no-tools coordinator turn through this adapter seam."""
        guarded_prompt = self._coordinator_prompt(
            prompt,
            workstep_tools=workstep_tools,
        )
        if images and not self.capabilities.supports_vision:
            guarded_prompt = self.render_image_prompt(guarded_prompt, images)
        spawn_kwargs: dict[str, Any] = {}
        if workstep_tools and self.capabilities.supports_workstep_tools:
            spawn_kwargs["workstep_tools"] = True
        if self.supports_message_history:
            if message_history is not None:
                spawn_kwargs["message_history"] = message_history
            if report_engine_state:
                spawn_kwargs["report_engine_state"] = True
        if self.capabilities.supports_thinking_effort and thinking_effort:
            spawn_kwargs["thinking_effort"] = thinking_effort
        if config_overrides:
            spawn_kwargs["config_overrides"] = config_overrides
        async for event in self.spawn(
            prompt=guarded_prompt,
            cwd=cwd,
            model=model,
            session_id=session_id,
            images=images if self.capabilities.supports_vision else None,
            **spawn_kwargs,
        ):
            yield event

    @staticmethod
    def coordinator_guard(prompt: str) -> str:
        """Wrap a user prompt with the read-only coordinator instruction."""
        return (
            "You are a read-only task coordinator. Do not call tools, execute "
            "commands, or modify files. Return only the requested JSON.\n\n"
            f"{prompt}"
        )

    @staticmethod
    def coordinator_tools_guard(prompt: str) -> str:
        """Wrap a user prompt with the tool-enabled coordinator instruction."""
        return (
            "You are a task coordinator. You may call the WorkStep internal "
            "tools to inspect projects and tasks — natively via workstep_call "
            "when available, otherwise through the workstep CLI. Mutating "
            "operations require explicit user authorization. Never execute "
            "workflow actions directly — return them in the requested JSON "
            "instead.\n\n"
            f"{prompt}"
        )

    @staticmethod
    def render_image_prompt(
        prompt: str,
        images: list[EngineImage] | None,
    ) -> str:
        """Append attached images as markdown references to a text prompt.

        Vision-capable engines embed the references natively; engines without
        vision keep the paths visible to the model as a best-effort fallback.
        """
        if not images:
            return prompt
        lines = [prompt, "", "Attached image(s); analyze them if possible:"]
        for image in images:
            alt = image.description or "attached image"
            lines.append(f"![{alt}]({image.reference})")
        return "\n".join(lines)

    # --- Interaction（ACP 语义） ---

    def normalize_event(self, event: InternalEvent) -> InternalEvent | None:
        """Normalize provider-native interaction and plan events at the ACP seam."""
        interaction = self.normalize_interaction_event(event)
        if interaction is not event:
            return interaction
        tracker = getattr(self, "_native_plan_tracker", None)
        if tracker is None:
            tracker = NativePlanTracker()
            setattr(self, "_native_plan_tracker", tracker)
        if event.type == "subagent":
            # 子代理生命周期事件透传给前端；同时把状态并入 plan 快照，
            # 供后续 plan 工具事件（TaskCreate/TaskUpdate/TaskList）携带。
            tracker.observe(event)
            return event
        return tracker.observe(event) or event

    def normalize_interaction_event(self, event: InternalEvent) -> InternalEvent:
        """Map native ask-user tool aliases to ACP form elicitation."""
        if event.type != "tool_use":
            return event
        interaction = interaction_from_tool_use(
            str(event.data.get("id") or event.data.get("tool_use_id") or ""),
            str(event.data.get("name") or ""),
            event.data.get("input") if isinstance(event.data.get("input"), dict) else {},
        )
        return interaction or event

    async def request_interaction(self, event: InternalEvent, publish) -> dict[str, Any]:
        """Publish and await an interaction from an in-process engine tool.

        CLI/SDK adapters can expose their native pause. In-process engines use
        this broker so their tool coroutine blocks until ``respond_interaction``.
        """
        interaction_id = str(event.data.get("interaction_id") or "")
        if not interaction_id:
            raise ValueError("interaction_request 缺少 interaction_id")
        pending = getattr(self, "_pending_interaction_responses", None)
        if pending is None:
            pending = {}
            setattr(self, "_pending_interaction_responses", pending)
        if interaction_id in pending:
            raise RuntimeError(f"交互请求重复：{interaction_id}")
        future = asyncio.get_running_loop().create_future()
        pending[interaction_id] = future
        approval_key = ""
        if (
            event.type == "interaction_request"
            and event.data.get("method") == "session/request_permission"
        ):
            tool_call = event.data.get("tool_call") or {}
            approval_key = str(
                tool_call.get("tool_call_id")
                or tool_call.get("id")
                or interaction_id
            )
            self._pending_approvals_dict()[approval_key] = event
        try:
            published = publish(event)
            if isawaitable(published):
                await published
            return await future
        finally:
            pending.pop(interaction_id, None)
            if approval_key:
                self._pending_approvals_dict().pop(approval_key, None)

    async def handle_tool_permission(
        self,
        publish,
        *,
        tool_name: str,
        tool_input: dict[str, Any],
        tool_use_id: str,
        title: str = "",
        session_id: str = "",
    ) -> tuple[bool, dict[str, Any] | None]:
        """Bridge SDK permission callbacks to ACP interaction semantics."""
        if "".join(character for character in tool_name.lower() if character.isalnum()) in {
            "askuser", "askuserquestion", "requestuserinput", "userinput",
        }:
            event = claude_ask_user_request(tool_use_id, tool_input)
            response = await self.request_interaction(event, publish)
            if response.get("action") != "accept":
                return False, None
            content = response.get("content")
            answers: dict[str, Any] = {}
            if isinstance(content, dict):
                for index, question in enumerate(tool_input.get("questions") or []):
                    if not isinstance(question, dict):
                        continue
                    question_text = str(question.get("question") or f"question_{index}")
                    if f"question_{index}" in content:
                        answers[question_text] = content[f"question_{index}"]
            return True, {
                "questions": tool_input.get("questions") or [],
                "answers": answers,
            }

        signature = permission_signature(tool_name, tool_input)
        session_allow = getattr(self, "_permission_session_allow", None)
        if session_allow is None:
            session_allow = set()
            self._permission_session_allow = session_allow
        session_reject = getattr(self, "_permission_session_reject", None)
        if session_reject is None:
            session_reject = set()
            self._permission_session_reject = session_reject
        if signature and signature in session_allow:
            return True, tool_input
        if signature and signature in session_reject:
            return False, tool_input

        event = permission_request(
            interaction_id=tool_use_id,
            session_id=session_id,
            tool_call={
                "tool_call_id": tool_use_id,
                "title": title or tool_name,
                "name": tool_name,
                "raw_input": tool_input,
            },
            options=[
                {"option_id": "allow_once", "name": "允许一次", "kind": "allow_once"},
                {"option_id": "allow_for_session", "name": "允许本次运行", "kind": "allow_for_session"},
                {"option_id": "reject_once", "name": "拒绝", "kind": "reject_once"},
                {"option_id": "reject_for_session", "name": "拒绝本次运行", "kind": "reject_for_session"},
            ],
        )
        response = await self.request_interaction(event, publish)
        outcome = response.get("outcome") or {}
        option_id = str(outcome.get("option_id") or "")
        if option_id == "allow_for_session" and signature:
            session_allow.add(signature)
        elif option_id == "reject_for_session" and signature:
            session_reject.add(signature)
        return option_id in {"allow_once", "allow_for_session"}, tool_input

    async def send_live_stage_message(self, content: str) -> bool:
        """Send a plain user message into a running stage execution.

        Return True when the message was accepted by the engine, False when the
        adapter cannot deliver ordinary messages mid-run (permission responses
        go through inject_response instead). Adapters that implement this must
        also advertise ``supports_live_stage_message`` in their capabilities.
        """
        return False

    def _map_notification(self, update) -> InternalEvent | None:
        """Map one ACP session update to the internal (ACP-vocabulary) event.

        13 种 session update 全量映射；未知 update 透传 ``acp_raw`` 不再静默丢弃。
        """
        if isinstance(update, InternalEvent):
            return update
        if isinstance(update, schema.AgentMessageChunk):
            text = self._content_text(update.content)
            if text is not None:
                return agent_message_chunk(text)
        if isinstance(update, schema.AgentThoughtChunk):
            text = self._content_text(update.content)
            if text is not None:
                return agent_thought_chunk(text)
        if isinstance(update, schema.UserMessageChunk):
            text = self._content_text(update.content)
            if text is not None:
                return user_message_chunk(text)
        if isinstance(update, schema.ToolCallStart):
            data = {
                "tool_call_id": update.tool_call_id,
                "title": update.title or "tool",
            }
            if update.kind:
                data["kind"] = update.kind
            if update.raw_input is not None:
                data["raw_input"] = update.raw_input
            if self.get_permission_mode() == "ask":
                data["needs_approval"] = True
            return InternalEvent(type="tool_call", data=data)
        if isinstance(update, schema.ToolCallProgress):
            data = {"tool_call_id": update.tool_call_id}
            if update.status:
                data["status"] = update.status
            if update.title:
                data["title"] = update.title
            if update.kind:
                data["kind"] = update.kind
            if update.raw_input is not None:
                data["raw_input"] = update.raw_input
            if update.raw_output is not None:
                data["raw_output"] = update.raw_output
            return InternalEvent(type="tool_call_update", data=data)
        if isinstance(update, (schema.AgentPlanUpdate, schema.Plan)):
            return plan_event([
                {
                    "content": entry.content,
                    "priority": entry.priority,
                    "status": entry.status,
                }
                for entry in update.entries
            ])
        if isinstance(update, schema.AgentPlanContentUpdate):
            return self._map_plan_update(update)
        if isinstance(update, schema.AgentPlanRemovedUpdate):
            return InternalEvent(type="plan_removed", data={"id": update.id})
        if isinstance(update, schema.UsageUpdate):
            usage: dict[str, Any] = {
                "used": update.used,
                "size": update.size,
            }
            if update.cost is not None:
                usage["cost"] = {
                    "amount": update.cost.amount,
                    "currency": update.cost.currency,
                }
            event = usage_update_event(usage, used=update.used, size=update.size)
            event.data["context_window"] = update.size
            return event
        if isinstance(update, schema.SessionInfoUpdate):
            data: dict[str, Any] = {}
            if update.title is not None:
                data["title"] = update.title
            if update.updatedAt is not None:
                data["updated_at"] = update.updatedAt
            return InternalEvent(type="session_info_update", data=data)
        if isinstance(update, schema.AvailableCommandsUpdate):
            return InternalEvent(
                type="available_commands_update",
                data={"available_commands": [
                    self._json_value(command)
                    for command in (update.availableCommands or [])
                ]},
            )
        if isinstance(update, schema.ConfigOptionUpdate):
            return InternalEvent(
                type="config_option_update",
                data={"config_options": [
                    self._json_value(option)
                    for option in (update.configOptions or [])
                ]},
            )
        if isinstance(update, schema.CurrentModeUpdate):
            return InternalEvent(
                type="current_mode_update",
                data={"current_mode_id": update.currentModeId},
            )
        if isinstance(update, schema.MessageMcpNotification):
            data: dict[str, Any] = {
                "connection_id": update.connectionId,
                "method": update.method,
            }
            if update.params is not None:
                data["params"] = update.params
            return InternalEvent(type="mcp_message", data=data)
        if isinstance(update, schema.CompleteElicitationNotification):
            return InternalEvent(
                type="elicitation_completed",
                data={"elicitation_id": update.elicitationId},
            )
        # 未知 update：透传 acp_raw，不再静默丢弃。
        return acp_raw_event(update)

    @staticmethod
    def _content_text(content) -> str | None:
        if isinstance(content, schema.TextContentBlock):
            return content.text
        return None

    @staticmethod
    def _json_value(value):
        dump = getattr(value, "model_dump", None)
        if callable(dump):
            return dump(by_alias=False, exclude_none=True)
        if isinstance(value, (list, tuple)):
            return [AcpEngineBase._json_value(item) for item in value]
        if isinstance(value, dict):
            return {str(key): AcpEngineBase._json_value(item) for key, item in value.items()}
        return value

    @staticmethod
    def _map_plan_update(update) -> InternalEvent:
        plan = update.plan
        data: dict[str, Any] = {"id": getattr(plan, "id", "")}
        update_type = getattr(plan, "type", None)
        if update_type:
            data["type"] = update_type
        if update_type == "markdown" and getattr(plan, "content", None) is not None:
            data["content"] = plan.content
        elif update_type == "file" and getattr(plan, "uri", None) is not None:
            data["uri"] = plan.uri
        else:
            entries = getattr(plan, "entries", None)
            if entries is not None:
                data["entries"] = [
                    {
                        "content": entry.content,
                        "priority": entry.priority,
                        "status": entry.status,
                    }
                    for entry in entries
                ]
        return InternalEvent(type="plan_update", data=data)

    @staticmethod
    def _map_prompt_response_usage(response) -> InternalEvent | None:
        usage = getattr(response, "usage", None)
        if usage is None:
            return None
        data = {
            "input_tokens": usage.input_tokens,
            "output_tokens": usage.output_tokens,
            "total_tokens": usage.total_tokens,
            "cached_read_tokens": usage.cached_read_tokens,
            "cached_write_tokens": usage.cached_write_tokens,
        }
        if usage.thought_tokens is not None:
            data["thought_tokens"] = usage.thought_tokens
        return usage_update_event(data)

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
        """Whether ordinary messages can be injected mid-run (ACP native only)."""
        return self._is_acp_native

    def build_resume_params(self, session_id: str) -> dict:
        return {"session_id": session_id}
