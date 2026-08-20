"""CodexSDKEngine — Codex via the official ``openai-codex`` Python SDK."""

import asyncio
import importlib.metadata
import logging
import os
import uuid
from typing import Any, AsyncIterator

from engines.core.acp_base import AcpEngineBase
from engines.core.base import (
    EngineInstallResult,
    EngineModel,
    install_python_package,
    resolve_thinking_effort,
)

from engines.core.events import (
    InternalEvent,
    compacted_event,
    normalize_token_usage,
    tool_call_event,
    tool_call_update_event,
)
from engines.core.interactions import permission_request, permission_signature
from engines.core.input_items import workstep_input_commands
from engines.core.plans import plan_event
from engines.core.schema import EngineConfigField, EngineConfigOption, EngineImage
from services.config import (
    CODEX_REASONING_EFFORTS,
    CODEX_SANDBOX_MODES,
    CODEX_SDK_APPROVAL_MODES,
    config_store,
)

logger = logging.getLogger(__name__)


class CodexSDKEngine(AcpEngineBase):
    """Codex driven by the official ``openai-codex`` Python SDK.

    The SDK launches a ``codex`` CLI binary in-process (stream-json protocol)
    — no shell wrapper, no ACP bridge. The bundled ``openai-codex-cli-bin``
    runtime is used unless an explicit binary override is configured. This
    adapter only drives the SDK's async client and maps its notifications to
    internal events.
    """

    ENGINE_ID = "codex_sdk"

    def __init__(self):
        super().__init__()
        self._running = False
        self._stream_task: asyncio.Task | None = None
        self._client: Any | None = None

    # --- Engine discovery ---

    @staticmethod
    def _sdk_available() -> bool:
        try:
            import openai_codex  # noqa: F401
            return True
        except Exception:
            return False

    @staticmethod
    def is_installed() -> bool:
        return CodexSDKEngine._sdk_available()

    @staticmethod
    def is_configured() -> bool:
        # Reuses the existing Codex auth state; no engine-specific config.
        return True

    @staticmethod
    def get_version() -> str | None:
        try:
            return importlib.metadata.version("openai-codex")
        except importlib.metadata.PackageNotFoundError:
            return None

    @staticmethod
    def resolve_binary() -> str | None:
        """Resolve the codex binary: override → SDK bundled binary."""
        override = CodexSDKEngine.get_binary_override()
        if override is not None:
            return override if os.path.isfile(override) else None
        try:
            from codex_cli_bin import bundled_codex_path
            path = bundled_codex_path()
            return str(path) if path else None
        except Exception:
            return None

    @staticmethod
    def install_command() -> str:
        return "pip install openai-codex"

    async def install(self) -> EngineInstallResult:
        """Install the official ``openai-codex`` Python SDK package."""
        return await install_python_package("openai-codex")

    # --- Config schema (backend-driven settings form) ---

    @classmethod
    def config_schema(cls) -> list[EngineConfigField]:
        return [
            EngineConfigField(
                key="model_reasoning_effort",
                label="推理强度",
                type="select",
                options=tuple(
                    EngineConfigOption(level, level)
                    for level in CODEX_REASONING_EFFORTS
                ),
                placeholder="默认不覆盖",
                help="thread_start/thread_resume 的 config.model_reasoning_effort。",
            ),
            EngineConfigField(
                key="approval_mode",
                label="审批模式",
                type="select",
                options=tuple(
                    EngineConfigOption(mode, mode) for mode in CODEX_SDK_APPROVAL_MODES
                ),
                placeholder="默认 auto_review",
                help="SDK 的 ApprovalMode：auto_review 自动放行，deny_all 拒绝所有工具调用。",
            ),
            EngineConfigField(
                key="sandbox",
                label="沙箱模式",
                type="select",
                options=tuple(
                    EngineConfigOption(mode, mode) for mode in CODEX_SANDBOX_MODES
                ),
                default="workspace-write",
                help="工具执行沙箱；danger-full-access 对应 SDK 的 full-access。",
            ),
        ]

    def get_config_values(self) -> dict:
        return config_store.get_codex_sdk_config()

    async def save_config_values(
        self,
        values: dict,
        clear: dict[str, bool] | None = None,
        confirmed: dict[str, bool] | None = None,
    ) -> None:
        config_store.set_codex_sdk_config(
            model_reasoning_effort=str(values.get("model_reasoning_effort") or ""),
            approval_mode=str(values.get("approval_mode") or ""),
            sandbox=str(values.get("sandbox") or ""),
        )

    async def list_models(self, cwd: str) -> list[EngineModel]:
        if not CodexSDKEngine._sdk_available():
            return []
        from openai_codex import AsyncCodex, CodexConfig

        client = AsyncCodex(config=CodexConfig(cwd=cwd or None))
        try:
            response = await client.models()
        finally:
            await client.close()
        return [
            EngineModel(
                id=model.id,
                label=model.display_name or model.id,
                description=model.description,
            )
            for model in response.data
            if not getattr(model, "hidden", False)
        ]

    # --- Notification mapping ---

    @staticmethod
    def _notification_method(notification: Any) -> str:
        return str(getattr(notification, "method", "") or "")

    @staticmethod
    def _root_of(item: Any) -> Any:
        return getattr(item, "root", item)

    @staticmethod
    def _plain(value: Any) -> Any:
        if hasattr(value, "model_dump"):
            return value.model_dump(by_alias=True, mode="json")
        if isinstance(value, list):
            return [CodexSDKEngine._plain(item) for item in value]
        if isinstance(value, dict):
            return {key: CodexSDKEngine._plain(item) for key, item in value.items()}
        enum_value = getattr(value, "value", None)
        return enum_value if enum_value is not None else value

    @staticmethod
    def _status_value(root: Any) -> str:
        status = getattr(root, "status", "")
        return str(getattr(status, "value", status) or "").lower()

    @classmethod
    def _tool_use_event(cls, root: Any) -> InternalEvent:
        rtype = getattr(root, "type", "")
        if rtype == "commandExecution":
            name = "Bash"
            tool_input = {"command": getattr(root, "command", "") or ""}
            if getattr(root, "cwd", None):
                tool_input["cwd"] = str(root.cwd)
        elif rtype == "mcpToolCall":
            server = getattr(root, "server", "") or ""
            tool = getattr(root, "tool", "") or ""
            name = f"{server}/{tool}" if server else tool
            tool_input = cls._plain(getattr(root, "arguments", {}) or {})
        elif rtype == "fileChange":
            name = "FileChange"
            tool_input = {"changes": cls._plain(getattr(root, "changes", []) or [])}
        elif rtype == "webSearch":
            name = "WebSearch"
            tool_input = {"query": getattr(root, "query", "") or ""}
        elif rtype == "collabAgentToolCall":
            name = str(cls._plain(getattr(root, "tool", "Agent")) or "Agent")
            tool_input = {
                "prompt": getattr(root, "prompt", None),
                "model": getattr(root, "model", None),
                "receiver_thread_ids": list(
                    getattr(root, "receiver_thread_ids", []) or []
                ),
            }
        else:
            name = getattr(root, "tool", "") or ""
            tool_input = cls._plain(getattr(root, "arguments", {}) or {})
        return tool_call_event(
            tool_call_id=str(getattr(root, "id", "") or ""),
            title=name,
            kind="other",
            raw_input=tool_input,
        )

    @classmethod
    def _tool_result_event(cls, root: Any) -> InternalEvent:
        rtype = getattr(root, "type", "")
        content_parts: list[str] = []
        if rtype == "commandExecution":
            content_parts.append(str(getattr(root, "aggregated_output", "") or ""))
        elif rtype == "mcpToolCall":
            result = getattr(root, "result", None)
            if result is not None:
                content_parts.append(str(cls._plain(result)))
            error = getattr(root, "error", None)
            if error is not None:
                content_parts.append(str(cls._plain(error)))
        elif rtype in {"fileChange", "collabAgentToolCall", "webSearch"}:
            value = (
                getattr(root, "changes", None)
                or getattr(root, "agents_states", None)
                or getattr(root, "query", None)
                or ""
            )
            content_parts.append(str(cls._plain(value)))
        else:
            for content_item in getattr(root, "content_items", None) or []:
                item_root = cls._root_of(content_item)
                text = getattr(item_root, "text", None)
                if text:
                    content_parts.append(str(text))
        exit_code = getattr(root, "exit_code", None)
        is_error = (
            cls._status_value(root) in {"failed", "declined", "error"}
            or getattr(root, "success", True) is False
            or getattr(root, "error", None) is not None
            or (isinstance(exit_code, int) and exit_code != 0)
        )
        return tool_call_update_event(
            tool_call_id=str(getattr(root, "id", "") or ""),
            status="failed" if bool(is_error) else "completed",
            raw_output="\n".join(content_parts),
        )

    def _map_notification(
        self,
        notification: Any,
        state: dict[str, Any],
    ) -> list[InternalEvent]:
        """Map one SDK notification to zero or more InternalEvents.

        ``state`` tracks whether text has been emitted and which tool call
        IDs already produced a ``tool_use`` event, so completed items never
        duplicate streamed content.
        """
        events: list[InternalEvent] = []
        method = self._notification_method(notification)
        payload = getattr(notification, "payload", None)

        if method == "turn/started":
            events.append(InternalEvent(type="status", data={"status": "running"}))

        elif method == "item/agentMessage/delta":
            delta = getattr(payload, "delta", None) or ""
            if delta:
                state["emitted_text"] = True
                events.append(
                    InternalEvent(
                        type="agent_message_chunk",
                        data={"content": {"text": str(delta)}},
                    )
                )

        elif method in ("item/reasoning/textDelta", "item/reasoning/summaryTextDelta"):
            delta = getattr(payload, "delta", None) or ""
            if delta:
                state["emitted_thinking"] = True
                events.append(
                    InternalEvent(
                        type="agent_thought_chunk",
                        data={"content": {"text": str(delta)}},
                    )
                )

        elif method == "item/started":
            root = self._root_of(getattr(payload, "item", None))
            tool_id = getattr(root, "id", None)
            if (
                getattr(root, "type", "") in {
                    "commandExecution", "fileChange", "mcpToolCall",
                    "dynamicToolCall", "collabAgentToolCall", "webSearch",
                }
                and tool_id not in state["tool_emitted"]
            ):
                state["tool_emitted"].add(tool_id)
                events.append(self._tool_use_event(root))

        elif method == "item/completed":
            root = self._root_of(getattr(payload, "item", None))
            if root is None:
                return events
            rtype = getattr(root, "type", "")
            if rtype == "agentMessage":
                text = getattr(root, "text", None) or ""
                if text and not state["emitted_text"]:
                    state["emitted_text"] = True
                    events.append(
                        InternalEvent(
                            type="agent_message_chunk",
                            data={"content": {"text": str(text)}},
                        )
                    )
            elif rtype == "reasoning":
                content = getattr(root, "content", None)
                if isinstance(content, list):
                    text = "\n".join(str(item) for item in content if item)
                else:
                    text = getattr(self._root_of(content), "text", None) or ""
                if text and not state.get("emitted_thinking", False):
                    state["emitted_thinking"] = True
                    events.append(
                        InternalEvent(
                            type="agent_thought_chunk",
                            data={"content": {"text": str(text)}},
                        )
                    )
            elif rtype in {
                "commandExecution", "fileChange", "mcpToolCall",
                "dynamicToolCall", "collabAgentToolCall", "webSearch",
            }:
                status_value = self._status_value(root)
                tool_id = getattr(root, "id", None)
                if status_value in {"inprogress", "pending", "running"}:
                    if tool_id not in state["tool_emitted"]:
                        state["tool_emitted"].add(tool_id)
                        events.append(self._tool_use_event(root))
                else:
                    events.append(self._tool_result_event(root))

        elif method == "thread/tokenUsage/updated":
            usage = getattr(payload, "token_usage", None)
            source = getattr(usage, "last", None)
            if source is None:
                source = getattr(usage, "total", None)
            if source is not None:
                raw = {
                    "input_tokens": getattr(source, "input_tokens", 0) or 0,
                    "output_tokens": getattr(source, "output_tokens", 0) or 0,
                    "cache_read_input_tokens": getattr(source, "cached_input_tokens", 0) or 0,
                    "total_tokens": getattr(source, "total_tokens", 0) or 0,
                }
                usage_data = normalize_token_usage(raw)
                reasoning = getattr(source, "reasoning_output_tokens", None)
                if isinstance(reasoning, (int, float)):
                    usage_data["reasoning_output_tokens"] = int(reasoning)
                events.append(InternalEvent(type="usage_update", data=usage_data))

        elif method == "thread/compacted":
            events.append(compacted_event())

        elif method == "turn/plan/updated":
            entries = []
            for step in getattr(payload, "plan", None) or []:
                status = getattr(step, "status", "pending")
                entries.append({
                    "step": getattr(step, "step", "") or "",
                    "status": getattr(status, "value", status),
                })
            events.append(plan_event(
                entries,
                explanation=getattr(payload, "explanation", None),
            ))

        elif method == "turn/completed":
            turn = getattr(payload, "turn", None)
            if turn is None:
                events.append(InternalEvent(type="status", data={"status": "done"}))
                return events
            status = getattr(getattr(turn, "status", None), "value", None)
            if status == "failed":
                error = getattr(turn, "error", None)
                message = getattr(error, "message", None) or "Codex 执行失败"
                events.append(
                    InternalEvent(type="error", data={"message": str(message)})
                )
            else:
                events.append(InternalEvent(type="status", data={"status": "done"}))

        elif method == "error":
            error = getattr(payload, "error", None)
            message = getattr(error, "message", None) or str(error or "Codex SDK 错误")
            events.append(InternalEvent(type="error", data={"message": str(message)}))

        return events

    # --- Execution ---

    async def spawn(
        self,
        prompt: str,
        cwd: str,
        model: str | None = None,
        add_dirs: list[str] | None = None,
        session_id: str | None = None,
        images: list[EngineImage] | None = None,
        live_message_queue: asyncio.Queue | None = None,
        thinking_effort: str | None = None,
        config_overrides: dict | None = None,
    ) -> AsyncIterator[InternalEvent]:
        async for event in self._spawn_with_sandbox(
            prompt=prompt,
            cwd=cwd,
            model=model,
            session_id=session_id,
            images=images,
            read_only=False,
            live_message_queue=live_message_queue,
            thinking_effort=thinking_effort,
            config_overrides=config_overrides,
        ):
            yield event

    async def spawn_coordinator(
        self,
        prompt: str,
        cwd: str,
        model: str | None = None,
        session_id: str | None = None,
        images: list[EngineImage] | None = None,
        thinking_effort: str | None = None,
        workstep_tools: bool = False,
    ) -> AsyncIterator[InternalEvent]:
        guarded_prompt = self.render_image_prompt(
            self._coordinator_prompt(prompt, workstep_tools=workstep_tools),
            images,
        )
        async for event in self._spawn_with_sandbox(
            prompt=guarded_prompt,
            cwd=cwd,
            model=model,
            session_id=session_id,
            images=images,
            read_only=not workstep_tools,
            thinking_effort=thinking_effort,
        ):
            yield event

    async def _spawn_with_sandbox(
        self,
        prompt: str,
        cwd: str,
        model: str | None = None,
        session_id: str | None = None,
        read_only: bool = False,
        images: list[EngineImage] | None = None,
        live_message_queue: asyncio.Queue | None = None,
        thinking_effort: str | None = None,
        config_overrides: dict | None = None,
    ) -> AsyncIterator[InternalEvent]:
        """Internal spawn with an explicit codex sandbox policy."""
        if not CodexSDKEngine._sdk_available():
            yield InternalEvent(
                type="error", data={"message": "openai-codex SDK 未安装"}
            )
            return
        try:
            from openai_codex import (
                ApprovalMode,
                AsyncCodex,
                CodexConfig,
                Sandbox,
            )
        except Exception as exc:
            yield InternalEvent(
                type="error",
                data={"message": f"openai-codex SDK 未安装：{exc}"},
            )
            return

        sdk_config = self.merge_config_overrides(
            config_store.get_codex_sdk_config(), config_overrides
        )
        sandbox_map = {
            "read-only": Sandbox.read_only,
            "workspace-write": Sandbox.workspace_write,
            "danger-full-access": Sandbox.full_access,
        }
        if read_only:
            sandbox = Sandbox.read_only
        else:
            sandbox = sandbox_map.get(sdk_config["sandbox"], Sandbox.workspace_write)
        approval_mode = None
        if sdk_config["approval_mode"]:
            approval_mode = ApprovalMode(sdk_config["approval_mode"])
        thread_config = {}
        reasoning_effort = resolve_thinking_effort(
            thinking_effort, sdk_config["model_reasoning_effort"]
        )
        if reasoning_effort:
            thread_config["model_reasoning_effort"] = reasoning_effort
        thread_kwargs: dict[str, Any] = {
            "cwd": cwd,
            "model": model or None,
            "sandbox": sandbox,
            "config": thread_config or None,
        }
        if approval_mode is not None:
            # thread_start 的 approval_mode 不接受 None（默认 auto_review）
            thread_kwargs["approval_mode"] = approval_mode
        override = self.get_binary_override()
        client_config = CodexConfig(
            codex_bin=override or None,
            cwd=cwd or None,
        )

        self._running = True
        yield InternalEvent(type="status", data={"status": "initializing"})

        client: Any = None
        try:
            event_queue: asyncio.Queue[InternalEvent | None] = asyncio.Queue()
            approval_handler = self._build_approval_handler(
                event_queue,
                asyncio.get_running_loop(),
                session_id or "",
            )
            client = AsyncCodex(config=client_config)
            self._install_approval_handler(client, approval_handler)
            self._client = client
            state: dict[str, Any] = {
                "emitted_text": False,
                "emitted_thinking": False,
                "tool_emitted": set(),
            }

            async def pump() -> None:
                try:
                    if session_id:
                        thread = await client.thread_resume(
                            session_id,
                            **thread_kwargs,
                        )
                    else:
                        thread = await client.thread_start(
                            **thread_kwargs,
                        )
                    await event_queue.put(InternalEvent(
                        type="session_started",
                        data={"session_id": str(thread.id)},
                    ))
                    await event_queue.put(InternalEvent(
                        type="status", data={"status": "running"}
                    ))
                    turn = await thread.turn(prompt, model=model or None)
                    async for notification in turn.stream():
                        for event in self._map_notification(notification, state):
                            await event_queue.put(event)
                    while live_message_queue is not None:
                        live_items: list[tuple[str, str]] = []
                        while not live_message_queue.empty():
                            live_items.append(live_message_queue.get_nowait())
                        if not live_items:
                            # 插入队列已空：回复即收尾，不等待插入窗口。
                            break
                        injected = "\n\n".join(
                            content for _, content in live_items
                        )
                        # 先确认送达再开启响应 turn：runner 收到 delivered 后
                        # 封口插入前的输出段并开启新的响应段，响应事件归入新段。
                        for message_id, _ in live_items:
                            await event_queue.put(InternalEvent(
                                type="live_message",
                                data={
                                    "message_id": message_id,
                                    "status": "delivered",
                                    "detail": "",
                                },
                            ))
                        turn = await thread.turn(injected, model=model or None)
                        async for notification in turn.stream():
                            for event in self._map_notification(notification, state):
                                await event_queue.put(event)
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    logger.exception("Codex SDK turn error")
                    await event_queue.put(
                        InternalEvent(type="error", data={"message": str(exc)})
                    )
                finally:
                    await event_queue.put(None)

            stream_task = asyncio.create_task(pump())
            self._stream_task = stream_task
            while True:
                event = await event_queue.get()
                if event is None:
                    break
                yield event
            await stream_task
        except asyncio.CancelledError:
            yield InternalEvent(type="status", data={"status": "cancelled"})
        except Exception as exc:
            logger.exception("CodexSDKEngine spawn error")
            yield InternalEvent(type="error", data={"message": str(exc)})
        finally:
            if self._stream_task is not None and not self._stream_task.done():
                self._stream_task.cancel()
                await asyncio.gather(self._stream_task, return_exceptions=True)
            self._stream_task = None
            self._client = None
            if client is not None:
                close = getattr(client, "close", None)
                if callable(close):
                    try:
                        await asyncio.wait_for(close(), timeout=5)
                    except Exception:
                        pass
            self._running = False

    @staticmethod
    def _install_approval_handler(client: Any, handler: Any) -> None:
        """Install WorkStep's approval bridge on openai-codex 0.144.x.

        The public ``AsyncCodex`` wrapper does not expose the
        ``approval_handler`` accepted by its wrapped synchronous
        ``CodexClient``.  Validate that compatibility seam before assigning it
        so an SDK layout change fails closed instead of silently auto-accepting
        tool approvals.
        """
        async_client = getattr(client, "_client", None)
        sync_client = getattr(async_client, "_sync", None)
        if sync_client is None or not hasattr(sync_client, "_approval_handler"):
            raise RuntimeError(
                "当前 openai-codex SDK 不支持 WorkStep 异步审批桥接"
            )
        sync_client._approval_handler = handler

    def _build_approval_handler(
        self,
        event_queue: asyncio.Queue[InternalEvent | None],
        loop: asyncio.AbstractEventLoop,
        session_id: str,
    ) -> Any:
        """Build the synchronous approval callback handed to ``AsyncCodex``.

        The SDK invokes it from its stdout reader thread when Codex requests
        approval for a command/file change. We bridge it to the ACP-shaped
        ``interaction_request`` flow: submit the prompt to the main loop,
        block the reader thread until the user answers, then return the
        ``decision`` the SDK expects.
        """
        approval_methods = {
            "item/commandExecution/requestApproval",
            "item/fileChange/requestApproval",
        }

        def handler(method: str, params: Any) -> dict:
            if method not in approval_methods:
                return {}
            future = asyncio.run_coroutine_threadsafe(
                self._ask_approval(event_queue, session_id, method, params or {}),
                loop,
            )
            try:
                allowed = future.result(timeout=300)
            except Exception:
                return {}
            return {"decision": "accept" if allowed else "deny"}

        return handler

    async def _ask_approval(
        self,
        event_queue: asyncio.Queue[InternalEvent | None],
        session_id: str,
        method: str,
        params: dict[str, Any],
    ) -> bool:
        """Ask the user to allow/deny a Codex approval request (ACP-shaped)."""
        raw = params if isinstance(params, dict) else {}
        if method == "item/fileChange/requestApproval":
            tool_name = "Edit"
            title = "文件修改"
            tool_input = raw
        else:
            tool_name = "Bash"
            proposed = raw.get("proposed_exec") or {}
            command = (
                raw.get("command")
                or (proposed.get("command") if isinstance(proposed, dict) else None)
                or ""
            )
            title = f"执行命令: {command[:120]}" if command else "执行命令"
            tool_input = {"command": command} if command else raw
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
            return True
        if signature and signature in session_reject:
            return False
        event = permission_request(
            interaction_id=str(uuid.uuid4()),
            session_id=session_id or "codex-sdk",
            tool_call={
                "tool_call_id": str(raw.get("approval_id") or uuid.uuid4()),
                "title": title,
                "name": tool_name,
                "raw_input": raw,
            },
            options=[
                {"option_id": "allow_once", "name": "允许一次", "kind": "allow_once"},
                {"option_id": "allow_for_session", "name": "允许本次运行", "kind": "allow_for_session"},
                {"option_id": "reject_once", "name": "拒绝", "kind": "reject_once"},
                {"option_id": "reject_for_session", "name": "拒绝本次运行", "kind": "reject_for_session"},
            ],
        )
        response = await self.request_interaction(event, event_queue.put)
        outcome = response.get("outcome") or {}
        option_id = str(outcome.get("option_id") or "")
        if option_id == "allow_for_session" and signature:
            session_allow.add(signature)
        elif option_id == "reject_for_session" and signature:
            session_reject.add(signature)
        return option_id in {"allow_once", "allow_for_session"}

    async def stop(self) -> None:
        if self._stream_task is not None and not self._stream_task.done():
            self._stream_task.cancel()
            await asyncio.gather(self._stream_task, return_exceptions=True)
            self._stream_task = None
        client = self._client
        self._client = None
        if client is not None:
            close = getattr(client, "close", None)
            if callable(close):
                try:
                    await asyncio.wait_for(close(), timeout=5)
                except Exception:
                    pass
        self._running = False

    async def inject_response(self, tool_use_id: str, content: str) -> None:
        logger.warning("inject_response is not supported by CodexSDKEngine")

    @property
    def supports_resume(self) -> bool:
        return True

    @property
    def supports_interactive(self) -> bool:
        return True  # Same-thread turns accept ordinary user messages mid-run

    @property
    def supports_live_stage_message(self) -> bool:
        return True

    @property
    def supports_thinking_effort(self) -> bool:
        """``config.model_reasoning_effort`` supports a per-turn override."""
        return True

    # --- ACP 会话 / 审批契约（非 ACP 引擎：用自己的传输实现等价语义） ---

    #: spawn 实际产出的 ACP 词汇事件（声明 = 实际；无原生来源不合成）。
    acp_events: frozenset[str] = frozenset({
        "agent_message_chunk",
        "agent_thought_chunk",
        "tool_call",
        "tool_call_update",
        "plan",
        "usage_update",
        "interaction_request",
        "live_message",
        "status",
        "session_started",
        "compacted",
        "error",
    })

    @property
    def supports_sessions(self) -> bool:
        """SDK 的 thread_resume 原生支持按 thread_id 恢复会话。"""
        return True

    @property
    def supports_tool_approval(self) -> bool:
        """SDK approval_handler 桥接审批回调到 interaction_request，原生审批语义。"""
        return True

    async def create_session(
        self,
        cwd: str,
        add_dirs: list[str] | None = None,
        mcp_servers: list | None = None,
    ) -> str | None:
        """无法脱离提示词创建空会话；会话在首次 spawn（thread_start）时建立。"""
        logger.info("CodexSDK create_session: not supported without a prompt")
        return None

    async def resume_session(
        self,
        session_id: str,
        cwd: str,
        add_dirs: list[str] | None = None,
        mcp_servers: list | None = None,
    ) -> bool:
        """SDK thread_resume 原生恢复；spawn(session_id=...) 时实际恢复。"""
        return bool(session_id)

    async def close_session(self, session_id: str, cwd: str | None = None) -> None:
        """关闭会话 = 结束当前运行中的 client / 流任务。"""
        if self._running:
            await self.stop()

    async def cancel_session(self, session_id: str, cwd: str | None = None) -> None:
        """取消会话 = 终止当前运行中的 client / 流任务。"""
        if self._running:
            await self.stop()

    async def set_config_option(
        self,
        config_id: str,
        value: str | bool,
        session_id: str | None = None,
    ) -> None:
        """配置在 spawn 时从 config_store 读取（sandbox / approval_mode / reasoning）；
        运行中修改无原生入口。"""
        return None

    async def reset_options(self, session_id: str | None = None) -> None:
        """无原生 reset；新会话从全局配置重新读取。"""
        return None

    def build_resume_params(self, session_id: str) -> dict:
        return {"session_id": session_id}
    @property
    def skill_invocation_prefix(self) -> str:
        return "$"

    def input_commands(self) -> list[dict[str, str]]:
        return workstep_input_commands()
