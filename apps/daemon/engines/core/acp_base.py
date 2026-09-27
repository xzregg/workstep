"""AcpEngineBase — base class for ACP-protocol engines using Python SDK."""

import asyncio
import base64
import json
import logging
import os
import time
from inspect import isawaitable
from contextlib import suppress
from typing import Any, AsyncIterator

import acp
from acp import schema
from settings import settings

from engines.core.acp_event_mapper import ACPEventMapper
from engines.core.acp_sessions import ACPSessionProtocol
from engines.core.acp_streaming_client import ACPStreamingClient as _StreamingClient
from engines.core.base import (
    BaseLLMEngine,
    EngineModel,
    EngineTestResult,
    resolve_thinking_effort,
)
from engines.core.schema import EngineImage
from engines.core.events import (
    InternalEvent,
    compacted_event,
    normalize_token_usage,
    tool_call_event,
    tool_call_update_event,
)
from engines.core.interactions import (
    claude_ask_user_request,
    interaction_from_tool_use,
    permission_request,
    permission_signature,
)
from engines.core.plans import NativePlanTracker

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


class AcpEngineBase(ACPSessionProtocol, ACPEventMapper, BaseLLMEngine):
    EXECUTION_MAX_ATTEMPTS = 2
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
        self._initialize_response = None

    def get_command(self) -> list[str]:
        """Return the command to spawn the ACP agent process."""
        return self.COMMAND

    def get_permission_mode(self) -> str | None:
        return None

    async def set_permission_mode(self, mode: str) -> None:
        await super().set_permission_mode(mode)
        if self._handler is not None:
            self._handler.permission_mode = mode or self.get_permission_mode()

    def runtime_permission_decision(self) -> bool | None:
        """Resolve modes that WorkStep can enforce at its approval bridge."""
        mode = self.runtime_permission_mode()
        if mode in {"auto", "workspace-write", "danger-full-access"}:
            return True
        if mode == "read-only":
            return False
        return None

    async def _stream_with_retry(
        self,
        spawn_method,
        **kwargs,
    ) -> AsyncIterator[InternalEvent]:
        """Run one engine stream, retrying its first terminal failure once.

        The retry resumes the session announced by the failed attempt when the
        adapter supports resume.  Events emitted before the failure remain
        visible to preserve streaming; the first terminal error itself is
        replaced by a ``retrying`` status.  A second error is passed through.
        """
        retry_session_id = kwargs.get("session_id")
        for attempt_index in range(self.EXECUTION_MAX_ATTEMPTS):
            attempt_kwargs = dict(kwargs)
            if self.supports_resume:
                attempt_kwargs["session_id"] = retry_session_id
            failed_event: InternalEvent | None = None
            try:
                iterator = spawn_method(**attempt_kwargs)
                async for event in iterator:
                    if event.type == "session_started":
                        announced_session_id = str(
                            event.data.get("session_id") or ""
                        ).strip()
                        if announced_session_id:
                            retry_session_id = announced_session_id
                    if (
                        event.type == "error"
                        and attempt_index + 1 < self.EXECUTION_MAX_ATTEMPTS
                    ):
                        failed_event = event
                        with suppress(Exception):
                            await iterator.aclose()
                        break
                    yield event
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                if attempt_index + 1 >= self.EXECUTION_MAX_ATTEMPTS:
                    raise
                failure_message = str(exc) or exc.__class__.__name__
            else:
                if failed_event is None:
                    return
                failure_message = str(
                    failed_event.data.get("message")
                    or failed_event.data.get("error")
                    or "引擎执行失败"
                )

            yield InternalEvent(
                type="status",
                data={
                    "status": "retrying",
                    "attempt": attempt_index + 2,
                    "max_attempts": self.EXECUTION_MAX_ATTEMPTS,
                    "message": failure_message,
                },
            )

    async def spawn_with_retry(self, **kwargs) -> AsyncIterator[InternalEvent]:
        """Run the normal execution entry point with one failure retry."""
        if str(kwargs.get("prompt") or "").strip() == "/compact":
            from engines.core.input_items import NO_MANUAL_COMPACTION

            if self.ENGINE_ID in NO_MANUAL_COMPACTION:
                yield InternalEvent(type="error", data={
                    "message": f"{self.ENGINE_ID} 当前不支持手动压缩会话",
                })
                return
            if not kwargs.get("session_id"):
                yield InternalEvent(type="error", data={
                    "message": "没有可压缩的引擎会话",
                })
                return
            # Compaction changes the current session. Never retry it blindly.
            confirmed = False
            failed = False
            async for event in self.spawn(**kwargs):
                confirmed |= event.type == "compacted"
                failed |= event.type == "error"
                yield event
            if not confirmed and not failed:
                yield InternalEvent(type="error", data={
                    "message": "引擎未返回压缩完成事件，无法确认上下文已压缩",
                })
            return
        async for event in self._stream_with_retry(self.spawn, **kwargs):
            yield event

    async def spawn_coordinator_with_retry(
        self,
        **kwargs,
    ) -> AsyncIterator[InternalEvent]:
        """Run the coordinator entry point with one failure retry."""
        async for event in self._stream_with_retry(
            self.spawn_coordinator,
            **kwargs,
        ):
            yield event

    async def inspect_capabilities(
        self,
        project_root: str | None = None,
    ) -> dict | None:
        result = await super().inspect_capabilities(project_root)
        if result is None or not self._is_acp_native or not project_root:
            return result
        # ACP slash commands are authoritative only when advertised by the
        # agent. The shared placeholder must not shadow its native /compact.
        result["input_items"] = [
            item for item in result["input_items"]
            if item["name"] != "compact"
        ]
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
        skill_env = await asyncio.to_thread(self.project_skill_env, cwd)
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
                self._initialize_response = await client.initialize(
                    protocol_version=acp.PROTOCOL_VERSION,
                    client_capabilities=self._client_capabilities(),
                    client_info={"name": "WorkStep", "version": settings.version},
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

    @property
    def supports_session_fork(self) -> bool:
        """Native ACP agents negotiate fork support during initialization."""
        return self._is_acp_native

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
            plan=schema.PlanCapabilities(),
            session=schema.ClientSessionCapabilities(
                configOptions=schema.SessionConfigOptionsCapabilities(
                    boolean=schema.BooleanConfigOptionCapabilities(),
                ),
            ),
        )

    @staticmethod
    def _agent_capability(response, name: str, nested: str | None = None):
        """Read a negotiated agent capability; ``None`` means unsupported.

        Test doubles and older agents may return no initialize response.  In
        that case capability support is unknown and callers retain the legacy
        request behavior for backwards compatibility.
        """
        if response is None:
            return True
        capabilities = getattr(response, "agent_capabilities", None)
        if capabilities is None:
            return None
        value = getattr(capabilities, name, None)
        if nested is not None:
            value = getattr(value, nested, None) if value is not None else None
        return value

    @staticmethod
    def _acp_prompt_blocks(prompt: str, images: list[EngineImage] | None = None):
        """Build ACP prompt blocks without dropping image attachments."""
        blocks: list[Any] = [acp.text_block(prompt)]
        for image in images or []:
            data_url = image.to_data_url()
            if not data_url.startswith("data:") or ";base64," not in data_url:
                raise ValueError("ACP 图片必须是本地文件或 base64 data URL")
            header, encoded = data_url.split(",", 1)
            mime_type = header[5:].split(";", 1)[0] or "application/octet-stream"
            # Validate before handing malformed media to an ACP agent.
            base64.b64decode(encoded, validate=True)
            blocks.append(schema.ImageContentBlock(
                type="image",
                data=encoded,
                mimeType=mime_type,
                uri=image.reference or None,
            ))
        return blocks

    @classmethod
    def _validate_session_inputs(
        cls,
        initialize_response,
        additional_directories: list[str],
        mcp_servers: list,
    ) -> None:
        """Reject session inputs the agent did not advertise support for."""
        if initialize_response is None:
            return
        if additional_directories and not cls._agent_capability(
            initialize_response, "session_capabilities", "additional_directories"
        ):
            raise RuntimeError("ACP Agent 未声明 additionalDirectories 支持")
        capabilities = getattr(
            getattr(initialize_response, "agent_capabilities", None),
            "mcp_capabilities",
            None,
        )
        if capabilities is None:
            if mcp_servers:
                raise RuntimeError("ACP Agent 未声明 MCP 支持")
            return
        for server in mcp_servers:
            server_type = (
                str(server.get("type") or "")
                if isinstance(server, dict)
                else str(getattr(server, "type", "") or "")
            )
            if (
                isinstance(server, schema.HttpMcpServer) or server_type == "http"
            ) and not capabilities.http:
                raise RuntimeError("ACP Agent 未声明 HTTP MCP 支持")
            if (
                isinstance(server, schema.SseMcpServer) or server_type == "sse"
            ) and not capabilities.sse:
                raise RuntimeError("ACP Agent 未声明 SSE MCP 支持")
            if (
                isinstance(server, schema.AcpMcpServer) or server_type == "acp"
            ) and not capabilities.acp:
                raise RuntimeError("ACP Agent 未声明 ACP MCP transport 支持")

    async def list_models(self, cwd: str) -> list[EngineModel]:
        """Read the ACP session's model configuration options."""
        skill_env = await asyncio.to_thread(self.project_skill_env, cwd)
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
                self._initialize_response = await client.initialize(
                    protocol_version=acp.PROTOCOL_VERSION,
                    client_capabilities=self._client_capabilities(),
                    client_info={"name": "WorkStep", "version": settings.version},
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
                self._initialize_response = await client.initialize(
                    protocol_version=acp.PROTOCOL_VERSION,
                    client_capabilities=self._client_capabilities(),
                    client_info={"name": "WorkStep", "version": settings.version},
                )
                return await action(client)
            finally:
                self._running = False
                self._process = None

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
        if prompt.strip() == "/compact":
            if not session_id:
                yield InternalEvent(type="error", data={
                    "message": "没有可压缩的 ACP 会话",
                })
                return
            commands = await self._inspect_acp_commands(cwd)
            if not any(command["name"] == "compact" for command in commands):
                yield InternalEvent(type="error", data={
                    "message": "ACP 引擎未声明 /compact 命令",
                })
                return

        def prepare_spawn():
            provider_runtime = self.resolve_provider_runtime(
                provider_id=str((config_overrides or {}).get("provider_id") or ""),
                model=model,
            )
            return (
                provider_runtime,
                self.project_skill_env(cwd),
                self.get_command(),
                self.get_permission_mode(),
            )

        provider_runtime, skill_env, cmd, permission_mode = await asyncio.to_thread(
            prepare_spawn
        )
        model = provider_runtime.model
        if not cmd:
            yield InternalEvent(type="error", data={"message": f"{self.ENGINE_ID}: no command configured"})
            return

        if self.REQUIRES_PERMISSION_MODE and not permission_mode:
            yield InternalEvent(type="error", data={
                "message": "Claude Code 权限模式尚未确认，请先在设置中选择权限模式",
            })
            return

        logger.info("ACP spawn: %s (cwd=%s)", " ".join(cmd), cwd)
        yield InternalEvent(type="status", data={"status": "initializing"})

        handler = _StreamingClient(self.runtime_permission_mode() or permission_mode)
        self._handler = handler
        self._last_cwd = cwd
        try:
            process_env = (
                provider_runtime.child_env()
                if provider_runtime.provider_id or provider_runtime.env
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
                    client_info={"name": "WorkStep", "version": settings.version},
                )
                self._initialize_response = init_resp
                logger.info("ACP initialized: %s", init_resp)

                if (
                    init_resp is not None
                    and getattr(init_resp, "protocol_version", acp.PROTOCOL_VERSION)
                    != acp.PROTOCOL_VERSION
                ):
                    raise RuntimeError(
                        "ACP 协议版本不兼容："
                        f"客户端={acp.PROTOCOL_VERSION}，Agent={init_resp.protocol_version}"
                    )

                mcp_servers = list(
                    (config_overrides or {}).get("mcp_servers") or []
                )
                self._validate_session_inputs(
                    init_resp, add_dirs or [], mcp_servers
                )

                if session_id:
                    try:
                        if self._agent_capability(
                            init_resp, "load_session"
                        ):
                            await client.load_session(
                                cwd=cwd,
                                session_id=session_id,
                                mcp_servers=mcp_servers,
                                additional_directories=add_dirs or [],
                            )
                        elif self._agent_capability(
                            init_resp, "session_capabilities", "resume"
                        ):
                            await client.resume_session(
                                cwd=cwd,
                                session_id=session_id,
                                mcp_servers=mcp_servers,
                                additional_directories=add_dirs or [],
                            )
                        else:
                            raise RuntimeError(
                                "ACP Agent 未声明 session/load 或 session/resume 支持"
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
                        mcp_servers=mcp_servers,
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
                if images and not self._agent_capability(
                    init_resp, "prompt_capabilities", "image"
                ):
                    raise RuntimeError("ACP Agent 未声明图片 Prompt 支持")
                prompt_blocks = await asyncio.to_thread(
                    self._acp_prompt_blocks, prompt, images
                )
                prompt_task = asyncio.create_task(
                    client.prompt(
                        session_id=active_session_id,
                        prompt=prompt_blocks,
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
                stop_reason = str(
                    getattr(prompt_response, "stop_reason", "end_turn")
                    or "end_turn"
                )
                if stop_reason == "cancelled":
                    yield InternalEvent(type="status", data={"status": "stopped"})
                    return
                if stop_reason in {"max_tokens", "max_turn_requests", "refusal"}:
                    yield InternalEvent(type="error", data={
                        "message": f"ACP Agent 提前停止：{stop_reason}",
                        "stop_reason": stop_reason,
                    })
                    return
                if prompt.strip() == "/compact":
                    # The advertised ACP command has finished successfully.
                    yield compacted_event()
                    yield InternalEvent(type="status", data={"status": "done"})
                    return

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
        config_overrides: dict | None = None,
        model: str | None = None,
    ) -> EngineTestResult:
        """Run a harmless minimal conversation through this engine.

        Adapters with a cheaper native health check may override this method.
        """
        started = time.monotonic()
        text_parts: list[str] = []
        errors: list[str] = []
        completed = False

        async def collect_events():
            nonlocal completed
            async for event in self.spawn_with_retry(
                prompt=(
                    "Reply with WORKSTEP_ENGINE_OK only. "
                    "Do not use tools and do not modify files."
                ),
                cwd=cwd,
                model=model,
                config_overrides=config_overrides,
            ):
                if event.type == "agent_message_chunk":
                    content = event.data.get("content") or {}
                    text_parts.append(str(content.get("text", "")))
                elif event.type == "status" and event.data.get("status") == "done":
                    completed = True
                elif event.type == "error":
                    errors.append(
                        str(
                            event.data.get("message")
                            or event.data.get("error")
                            or "引擎返回错误"
                        )
                    )

        collect_task = asyncio.create_task(collect_events())
        done, _ = await asyncio.wait({collect_task}, timeout=timeout_seconds)
        if not done:
            collect_task.cancel()
            with suppress(BaseException):
                await collect_task
            with suppress(Exception):
                await self.stop()
            return EngineTestResult(
                success=False,
                message=f"测试超时（{timeout_seconds:g} 秒）",
                duration_ms=round((time.monotonic() - started) * 1000),
            )
        try:
            await collect_task
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
        if not completed and not "".join(text_parts).strip():
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
        guarded_prompt = (
            prompt if session_id and self.supports_resume
            else self._coordinator_prompt(prompt, workstep_tools=workstep_tools)
        )
        if images and not self.capabilities.supports_vision:
            guarded_prompt = await asyncio.to_thread(
                self.render_image_prompt, guarded_prompt, images
            )
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

    async def send_live_step_message(self, content: str) -> bool:
        """Send a plain user message into a running step execution.

        Return True when the message was accepted by the engine, False when the
        adapter cannot deliver ordinary messages mid-run (permission responses
        go through inject_response instead). Adapters that implement this must
        also advertise ``supports_live_step_message`` in their capabilities.
        """
        return False

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
    def supports_live_step_message(self) -> bool:
        """Whether ordinary messages can be injected mid-run (ACP native only)."""
        return self._is_acp_native

    def build_resume_params(self, session_id: str) -> dict:
        return {"session_id": session_id}
