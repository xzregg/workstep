"""ClaudeAgentSDKEngine — Claude Code via the official claude-agent-sdk."""

import asyncio
import logging
import os
from pathlib import Path
import re
import shutil
import uuid
from typing import Any, AsyncIterator, Mapping

from engines.core.acp_base import AcpEngineBase
from engines.core.base import (
    EngineInstallResult,
    EngineModel,
    install_python_package,
    resolve_thinking_effort,
    sdk_turn_watchdog,
)

from engines.core.plans import subagent_event_from_message
from engines.core.events import (
    InternalEvent,
    compacted_event,
    normalize_token_usage,
    tool_call_event,
    tool_call_update_event,
)
from engines.core.schema import EngineImage
from engines.core.schema import EngineConfigField, EngineConfigOption
from services.config import CLAUDE_PERMISSION_MODES, config_store

logger = logging.getLogger(__name__)


class ClaudeAgentSDKEngine(AcpEngineBase):
    """Claude Code driven by the official ``claude-agent-sdk`` Python package.

    The SDK's ``local`` transport still starts the ``claude`` binary as a child
    process, but the SDK manages that process in-process via the stream-json
    protocol — no shell wrapper, no ACP bridge. This adapter only drives the
    SDK's async ``query()`` API and maps its messages to internal events.
    """

    ENGINE_ID = "claude_agent_sdk"

    def __init__(self):
        super().__init__()
        self._running = False
        self._receive_task: asyncio.Task | None = None
        self._client = None

    # --- Engine discovery ---

    @staticmethod
    def _sdk_available() -> bool:
        try:
            import claude_agent_sdk  # noqa: F401
            return True
        except Exception:
            return False

    @staticmethod
    def is_installed() -> bool:
        if not ClaudeAgentSDKEngine._sdk_available():
            return False
        return ClaudeAgentSDKEngine.resolve_binary() is not None

    @staticmethod
    def is_configured() -> bool:
        return True

    @staticmethod
    def get_version() -> str | None:
        binary = ClaudeAgentSDKEngine.resolve_binary()
        if not binary:
            return None
        try:
            import subprocess
            out = subprocess.run(
                [binary, "--version"], capture_output=True, text=True, timeout=5
            )
            return out.stdout.strip() if out.returncode == 0 else None
        except Exception:
            return None

    @staticmethod
    def resolve_binary() -> str | None:
        """Resolve the claude binary: override → env → SDK bundled → PATH.

        The SDK wheel bundles a platform-matched ``_bundled/claude`` runtime
        (``cli_path`` defaults to it), so no separate CLI install is required.
        """
        override = ClaudeAgentSDKEngine.get_binary_override()
        if override is not None:
            return override if os.path.isfile(override) else None
        env_bin = os.environ.get("CLAUDE_AGENT_CLAUDE_BIN")
        if env_bin and os.path.isfile(env_bin):
            return env_bin
        try:
            import claude_agent_sdk
            bundled = Path(claude_agent_sdk.__file__).parent / "_bundled" / (
                "claude.exe" if os.name == "nt" else "claude"
            )
            if bundled.is_file():
                return str(bundled)
        except Exception:
            pass
        return shutil.which("claude")

    @staticmethod
    def install_command() -> str:
        return "pip install claude-agent-sdk"

    async def install(self) -> EngineInstallResult:
        """Install the official ``claude-agent-sdk`` Python package."""
        return await install_python_package("claude-agent-sdk")

    # --- Config schema (backend-driven settings form) ---

    @classmethod
    def config_schema(cls) -> list[EngineConfigField]:
        return [
            EngineConfigField(
                key="permission_mode",
                label="权限模式",
                type="select",
                options=tuple(
                    EngineConfigOption(mode, mode) for mode in CLAUDE_PERMISSION_MODES
                ),
                placeholder="请选择并确认权限模式",
                required=True,
                confirm_values=("bypassPermissions",),
                help="与 Claude Code CLI 引擎共用同一权限模式配置。",
            ),
            EngineConfigField(
                key="max_turns",
                label="最大轮数",
                type="number",
                placeholder="如 20，留空为 SDK 默认",
                help="Agent 最多执行的工具调用轮数。",
            ),
            EngineConfigField(
                key="fallback_model",
                label="备用模型",
                type="text",
                placeholder="如 claude-3-5-haiku-latest",
                help="主模型不可用时自动切换的备用模型。",
            ),
        ]

    def get_config_values(self) -> dict:
        return config_store.get_claude_agent_sdk_config()

    async def save_config_values(
        self,
        values: dict,
        clear: dict[str, bool] | None = None,
        confirmed: dict[str, bool] | None = None,
    ) -> None:
        mode = str(values.get("permission_mode") or "").strip()
        if mode not in CLAUDE_PERMISSION_MODES:
            raise ValueError("不支持的权限模式")
        if mode == "bypassPermissions" and not (confirmed or {}).get(
            "permission_mode"
        ):
            raise ValueError("bypassPermissions 需要明确确认风险")
        config_store.set_claude_agent_sdk_config(
            max_turns=str(values.get("max_turns") or ""),
            permission_mode=mode,
            fallback_model=str(values.get("fallback_model") or ""),
        )

    async def list_models(self, cwd: str) -> list[EngineModel]:
        return [
            EngineModel("sonnet", "Sonnet"),
            EngineModel("opus", "Opus"),
            EngineModel("haiku", "Haiku"),
        ]

    # --- Execution ---

    @staticmethod
    def _msg_type(msg: Any) -> str:
        """Normalize the SDK MessageType (str enum or plain str) to lowercase."""
        raw = getattr(msg, "type", "")
        value = getattr(raw, "value", None)
        if value is not None:
            return str(value).lower()
        if raw:
            return str(raw).lower()
        name = type(msg).__name__
        if name.endswith("Message"):
            name = name[: -len("Message")]
        return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()

    @staticmethod
    def _block_type(block: Any) -> str:
        """Normalize a content block type (``type`` attr or class name)."""
        raw = getattr(block, "type", "")
        value = getattr(raw, "value", None)
        if value is not None:
            return str(value).lower()
        if raw:
            return str(raw).lower()
        name = type(block).__name__
        if name.endswith("Block"):
            name = name[: -len("Block")]
        return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()

    @staticmethod
    def _content_blocks(msg: Any) -> list[Any]:
        """Content blocks from either the legacy ``message.content`` or top-level ``content``."""
        message = getattr(msg, "message", None)
        if message is not None:
            blocks = getattr(message, "content", None)
            if blocks:
                return blocks
        return getattr(msg, "content", None) or []

    @staticmethod
    def _result_output(result: Any) -> str:
        """Extract final text from a result payload (str, dict, or object)."""
        if isinstance(result, str):
            return result
        if isinstance(result, Mapping):
            for key in ("output", "result", "text"):
                value = result.get(key)
                if value:
                    return str(value)
            return ""
        return str(
            getattr(result, "output", "") or getattr(result, "text", "") or ""
        )

    @staticmethod
    def _as_dict(value: Any) -> dict[str, Any]:
        """Best-effort conversion of the SDK Usage object to a plain dict."""
        if isinstance(value, Mapping):
            return dict(value)
        if hasattr(value, "to_dict") and callable(value.to_dict):
            try:
                converted = value.to_dict()
                if isinstance(converted, Mapping):
                    return dict(converted)
            except Exception:
                pass
        result: dict[str, Any] = {}
        for key in (
            "input_tokens",
            "output_tokens",
            "total_tokens",
            "cache_creation_input_tokens",
            "cache_read_input_tokens",
        ):
            item = getattr(value, key, None)
            if item is not None:
                result[key] = item
        return result

    def _map_message(
        self,
        msg: Any,
        state: dict[str, Any] | None = None,
    ) -> list[InternalEvent]:
        """Map one SDK message to zero or more InternalEvents.

        ``state`` tracks whether text has been emitted for this query so the
        ``result`` message only falls back to ``result.output`` when the model
        streamed no text blocks.
        """
        state = state if state is not None else {}
        state.setdefault("emitted_text", False)
        state.setdefault("streamed_text", False)
        state.setdefault("streamed_thinking", False)
        state.setdefault("session_started", False)
        events: list[InternalEvent] = []
        mtype = self._msg_type(msg)
        subtype = getattr(msg, "subtype", "") or ""
        if subtype in (
            "task_started",
            "task_progress",
            "task_updated",
            "task_notification",
        ):
            subagent = subagent_event_from_message(msg)
            if subagent is not None:
                events.append(subagent)
            return events

        if mtype == "system":
            subtype = getattr(msg, "subtype", "") or ""
            if subtype == "init":
                events.append(
                    InternalEvent(type="status", data={"status": "initializing"})
                )
                data = getattr(msg, "data", None) or {}
                session_id = data.get("session_id") if isinstance(data, Mapping) else None
                if session_id and not state["session_started"]:
                    state["session_started"] = True
                    events.append(InternalEvent(
                        type="session_started",
                        data={"session_id": str(session_id)},
                    ))
            elif subtype == "error":
                error = getattr(msg, "message", None) or "Claude Agent SDK 启动失败"
                events.append(InternalEvent(type="error", data={"message": str(error)}))
            elif "compact" in subtype.lower():
                data = getattr(msg, "data", None) or {}
                if isinstance(data, Mapping):
                    summary = (
                        data.get("summary")
                        or data.get("compact_summary")
                        or data.get("message")
                    )
                    events.append(compacted_event(str(summary) if summary else None))
                else:
                    events.append(compacted_event())
            return events

        if mtype == "stream_event":
            session_id = getattr(msg, "session_id", None)
            if session_id and not state["session_started"]:
                state["session_started"] = True
                events.append(InternalEvent(
                    type="session_started", data={"session_id": str(session_id)}
                ))
            stream_event = getattr(msg, "event", None) or {}
            if stream_event.get("type") != "content_block_delta":
                return events
            delta = stream_event.get("delta") or {}
            delta_type = delta.get("type", "")
            if delta_type == "text_delta" and delta.get("text"):
                state["emitted_text"] = True
                state["streamed_text"] = True
                events.append(InternalEvent(
                    type="agent_message_chunk",
                    data={"content": {"text": str(delta["text"])}},
                ))
            elif delta_type == "thinking_delta":
                thinking = delta.get("thinking") or delta.get("text")
                if thinking:
                    state["streamed_thinking"] = True
                    events.append(InternalEvent(
                        type="agent_thought_chunk",
                        data={"content": {"text": str(thinking)}},
                    ))
            elif delta_type == "input_json_delta" and delta.get("partial_json"):
                events.append(tool_call_update_event(
                    tool_call_id=str(stream_event.get("index") or ""),
                    status="in_progress",
                    raw_input=str(delta["partial_json"]),
                ))
            return events

        if mtype == "assistant":
            for block in self._content_blocks(msg):
                block_type = self._block_type(block)
                if block_type == "text" and not state["streamed_text"]:
                    delta = getattr(block, "text", "") or ""
                    if delta:
                        state["emitted_text"] = True
                        events.append(
                            InternalEvent(
                                type="agent_message_chunk",
                                data={"content": {"text": delta}},
                            )
                        )
                elif block_type == "thinking" and not state["streamed_thinking"]:
                    thinking = getattr(block, "thinking", "") or ""
                    if thinking:
                        events.append(
                            InternalEvent(
                                type="agent_thought_chunk",
                                data={"content": {"text": thinking}},
                            )
                        )
                elif block_type == "tool_use":
                    events.append(tool_call_event(
                        tool_call_id=str(getattr(block, "id", "") or ""),
                        title=str(getattr(block, "name", "") or "tool"),
                        raw_input=getattr(block, "input", {}) or {},
                    ))
            return events

        if mtype == "user":
            for block in self._content_blocks(msg):
                if self._block_type(block) == "tool_result":
                    content = getattr(block, "content", "") or ""
                    if isinstance(content, list):
                        content = "\n".join(
                            str(part) for part in content if part
                        )
                    events.append(tool_call_update_event(
                        tool_call_id=str(getattr(block, "tool_use_id", "") or ""),
                        status="failed" if bool(getattr(block, "is_error", False)) else "completed",
                        raw_output=content,
                    ))
            return events

        if mtype == "result":
            result = getattr(msg, "result", msg)
            is_error = bool(getattr(msg, "is_error", getattr(result, "is_error", False)))
            if not state["emitted_text"]:
                output = self._result_output(result)
                if str(output).strip():
                    state["emitted_text"] = True
                    events.append(
                        InternalEvent(
                            type="agent_message_chunk",
                            data={"content": {"text": str(output)}},
                        )
                    )
            usage = getattr(msg, "usage", None)
            if usage is None and result is not msg:
                usage = getattr(result, "usage", None)
            if usage is not None:
                usage_data = normalize_token_usage(self._as_dict(usage))
                cost_usd = getattr(msg, "total_cost_usd", None)
                if cost_usd is None and result is not msg:
                    cost_usd = getattr(result, "total_cost_usd", None)
                if (
                    cost_usd is not None
                    and isinstance(cost_usd, (int, float))
                    and not isinstance(cost_usd, bool)
                ):
                    usage_data["cost"] = {
                        "amount": round(float(cost_usd), 6),
                        "currency": "USD",
                    }
                session_id = getattr(msg, "session_id", None)
                if not session_id and result is not msg:
                    session_id = getattr(result, "session_id", None)
                usage_data["session_id"] = session_id or ""
                events.append(InternalEvent(type="usage_update", data=usage_data))
            if is_error:
                message = (
                    getattr(msg, "error", None)
                    or getattr(msg, "subtype", None)
                    or getattr(result, "error", None)
                    or getattr(result, "subtype", None)
                    or "Claude Agent SDK 执行失败"
                )
                events.append(
                    InternalEvent(type="error", data={"message": str(message)})
                )
            else:
                events.append(InternalEvent(type="status", data={"status": "done"}))
            return events

        return events

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
        prompt = self.render_image_prompt(prompt, images)
        binary = self.resolve_binary()
        if not binary:
            yield InternalEvent(
                type="error", data={"message": "claude binary not found"}
            )
            return
        try:
            from claude_agent_sdk import (
                ClaudeAgentOptions,
                ClaudeSDKClient,
                PermissionResultAllow,
                PermissionResultDeny,
            )
        except Exception as exc:
            yield InternalEvent(
                type="error",
                data={"message": f"claude-agent-sdk 未安装：{exc}"},
            )
            return

        event_queue: asyncio.Queue[InternalEvent | None] = asyncio.Queue()

        async def can_use_tool(tool_name, input_data, context):
            allowed, updated_input = await self.handle_tool_permission(
                event_queue.put,
                tool_name=str(tool_name),
                tool_input=input_data if isinstance(input_data, dict) else {},
                tool_use_id=str(getattr(context, "tool_use_id", "") or uuid.uuid4()),
                title=str(getattr(context, "title", "") or ""),
                session_id=session_id or "claude-agent-sdk",
            )
            if allowed:
                return PermissionResultAllow(updated_input=updated_input)
            return PermissionResultDeny(message="用户拒绝了该操作")

        sdk_config = self.merge_config_overrides(
            config_store.get_claude_agent_sdk_config(), config_overrides
        )
        options = ClaudeAgentOptions(
            cwd=cwd,
            model=model or None,
            permission_mode=sdk_config["permission_mode"] or "acceptEdits",
            cli_path=binary,
            resume=session_id or None,
            include_partial_messages=True,
            can_use_tool=can_use_tool,
        )
        if add_dirs:
            options.add_dirs = list(add_dirs)
        if sdk_config["max_turns"]:
            options.max_turns = int(sdk_config["max_turns"])
        if sdk_config["fallback_model"]:
            options.fallback_model = sdk_config["fallback_model"]
        effort = resolve_thinking_effort(thinking_effort)
        if effort and hasattr(options, "effort"):
            # Claude 的 effort 取值 low/medium/high/xhigh/max：
            # 极简映射到最低档，其余原样传递。
            options.effort = "low" if effort == "minimal" else effort

        logger.info(
            "ClaudeAgentSDKEngine spawn: binary=%s cwd=%s model=%s options=%s",
            binary, cwd, model, options,
        )

        self._running = True
        yield InternalEvent(type="status", data={"status": "running"})

        state: dict[str, Any] = {
            "emitted_text": False,
            "streamed_text": False,
            "streamed_thinking": False,
            "session_started": False,
        }

        client = ClaudeSDKClient(options=options)
        self._client = client
        await client.connect()

        turn_ended = asyncio.Event()
        end_prompt = asyncio.Event()
        input_closed = asyncio.Event()

        def _user_message(content: str) -> dict:
            return {
                "type": "user",
                "message": {"role": "user", "content": content},
                "parent_tool_use_id": None,
                "session_id": "default",
            }

        async def prompt_source() -> AsyncIterator[dict]:
            """Stream the initial prompt and live injections to the SDK.

            The SDK keeps stdin open for the whole session; ending this source
            closes stdin so the CLI finishes the turn, exits gracefully, and
            the SDK emits its stream-end frame (deterministic end, not a
            timeout).
            """
            yield _user_message(prompt)
            if live_message_queue is None:
                return
            while True:
                get_task = asyncio.create_task(live_message_queue.get())
                end_task = asyncio.create_task(end_prompt.wait())
                closed_task = asyncio.create_task(input_closed.wait())
                try:
                    done, _ = await asyncio.wait(
                        {get_task, end_task, closed_task},
                        return_when=asyncio.FIRST_COMPLETED,
                    )
                except asyncio.CancelledError:
                    for task in (get_task, end_task, closed_task):
                        task.cancel()
                    raise
                if end_task in done or closed_task in done:
                    if get_task in done:
                        # 消息已被取出但引擎收流：补报 error，避免静默丢失。
                        message_id, _ = get_task.result()
                        await event_queue.put(InternalEvent(
                            type="live_message",
                            data={
                                "message_id": message_id,
                                "status": "error",
                                "detail": "引擎执行已结束，无法接收新消息",
                            },
                        ))
                    else:
                        get_task.cancel()
                    return
                message_id, content = get_task.result()
                extras: list[tuple[str, str]] = []
                while not live_message_queue.empty():
                    extras.append(live_message_queue.get_nowait())
                combined = "\n\n".join(
                    [content] + [item[1] for item in extras]
                )
                for injected_id, _ in [(message_id, content), *extras]:
                    await event_queue.put(InternalEvent(
                        type="live_message",
                        data={
                            "message_id": injected_id,
                            "status": "delivered",
                            "detail": "",
                        },
                    ))
                yield _user_message(combined)

        query_task = asyncio.create_task(client.query(prompt_source()))

        async def receive() -> None:
            try:
                async for message in client.receive_messages():
                    if self._msg_type(message) == "result":
                        turn_ended.set()
                    for event in self._map_message(message, state):
                        await event_queue.put(event)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.exception("Claude Agent SDK query error")
                await event_queue.put(
                    InternalEvent(type="error", data={"message": str(exc)})
                )
            finally:
                input_closed.set()
                if query_task is not None:
                    try:
                        # 等输入源收尾：prompt_source 可能在收流瞬间已取出
                        # 插入消息，需先补报 error 事件，避免被 None 抢先吞掉。
                        await asyncio.wait_for(
                            asyncio.shield(query_task), timeout=5
                        )
                    except asyncio.TimeoutError:
                        query_task.cancel()
                    except asyncio.CancelledError:
                        pass
                await event_queue.put(None)

        receive_task = asyncio.create_task(receive())
        watchdog_task = asyncio.create_task(sdk_turn_watchdog(
            turn_ended,
            end_prompt.set,
            disconnect=client.disconnect,
            stream_closed=input_closed,
            pending_injection=(
                (lambda: not live_message_queue.empty())
                if live_message_queue is not None else None
            ),
        ))
        self._receive_task = receive_task
        try:
            while True:
                event = await event_queue.get()
                if event is None:
                    break
                yield event
            await receive_task
        except asyncio.CancelledError:
            yield InternalEvent(type="status", data={"status": "cancelled"})
        except Exception as exc:
            logger.exception("ClaudeAgentSDKEngine spawn error")
            yield InternalEvent(type="error", data={"message": str(exc)})
        finally:
            # 收流结束：尚未投递的插入消息标记失败，避免静默丢失。
            if live_message_queue is not None:
                remaining: list[tuple[str, str]] = []
                while not live_message_queue.empty():
                    remaining.append(live_message_queue.get_nowait())
                for message_id, _ in remaining:
                    yield InternalEvent(type="live_message", data={
                        "message_id": message_id,
                        "status": "error",
                        "detail": "引擎执行已结束，无法接收新消息",
                    })
            for task in (receive_task, query_task, watchdog_task):
                if task is not None and not task.done():
                    task.cancel()
            for task in (query_task, watchdog_task):
                if task is not None:
                    await asyncio.gather(task, return_exceptions=True)
            self._receive_task = None
            try:
                await client.disconnect()
            except Exception:
                pass
            self._client = None
            self._running = False

    async def stop(self) -> None:
        receive_task = self._receive_task
        self._receive_task = None
        if receive_task is not None and not receive_task.done():
            receive_task.cancel()
            await asyncio.gather(receive_task, return_exceptions=True)
        client = self._client
        self._client = None
        if client is not None:
            try:
                await client.disconnect()
            except Exception:
                pass
        self._running = False

    async def inject_response(self, tool_use_id: str, content: str) -> None:
        logger.warning("inject_response is not supported by ClaudeAgentSDKEngine")

    @property
    def supports_resume(self) -> bool:
        return True

    @property
    def supports_vision(self) -> bool:
        """Claude models accept markdown image references in prompts."""
        return True

    @property
    def supports_interactive(self) -> bool:
        return True  # ClaudeSDKClient 双向流式：运行中 query() 注入 + can_use_tool

    @property
    def supports_live_stage_message(self) -> bool:
        return True

    @property
    def supports_thinking_effort(self) -> bool:
        """ClaudeAgentOptions.effort maps to a per-turn thinking effort."""
        return True

    # --- ACP 会话 / 审批契约（非 ACP 引擎：用自己的传输实现等价语义） ---

    #: spawn 实际产出的 ACP 词汇事件（声明 = 实际；无原生来源不合成）。
    acp_events: frozenset[str] = frozenset({
        "agent_message_chunk",
        "agent_thought_chunk",
        "tool_call",
        "tool_call_update",
        "usage_update",
        "interaction_request",
        "live_message",
        "status",
        "session_started",
        "subagent",
        "compacted",
        "error",
    })

    @property
    def supports_sessions(self) -> bool:
        """ClaudeAgentOptions.resume 原生支持按 session_id 恢复会话。"""
        return True

    @property
    def supports_tool_approval(self) -> bool:
        """can_use_tool 回调桥接审批到 interaction_request，原生审批语义。"""
        return True

    async def create_session(
        self,
        cwd: str,
        add_dirs: list[str] | None = None,
        mcp_servers: list | None = None,
    ) -> str | None:
        """无法脱离提示词创建空会话；会话在首次 spawn（system/init）时建立。"""
        logger.info("ClaudeAgentSDK create_session: not supported without a prompt")
        return None

    async def resume_session(
        self,
        session_id: str,
        cwd: str,
        add_dirs: list[str] | None = None,
        mcp_servers: list | None = None,
    ) -> bool:
        """SDK resume 原生恢复；spawn(session_id=...) 时实际恢复。"""
        return bool(session_id)

    async def close_session(self, session_id: str, cwd: str | None = None) -> None:
        """关闭会话 = 断开当前 client 并结束运行中的任务。"""
        if self._running:
            await self.stop()

    async def cancel_session(self, session_id: str, cwd: str | None = None) -> None:
        """取消会话 = 断开当前 client 并结束运行中的任务。"""
        if self._running:
            await self.stop()

    async def set_config_option(
        self,
        config_id: str,
        value: str | bool,
        session_id: str | None = None,
    ) -> None:
        """配置在 spawn 时从 config_store 读取（permission_mode / model / effort）；
        运行中修改无原生入口。"""
        return None

    async def reset_options(self, session_id: str | None = None) -> None:
        """无原生 reset；新会话从全局配置重新读取。"""
        return None

    def build_resume_params(self, session_id: str) -> dict:
        return {"session_id": session_id}
