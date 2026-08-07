"""ClaudeAgentSDKEngine — Claude Code via the official claude-agent-sdk."""

import asyncio
import logging
import os
from pathlib import Path
import re
import shutil
from typing import Any, AsyncIterator, Mapping

from engines.base import BaseLLMEngine, EngineModel
from engines.events import InternalEvent, compacted_event, normalize_token_usage
from engines.schema import EngineImage
from engines.schema import EngineConfigField, EngineConfigOption
from services.config import CLAUDE_PERMISSION_MODES, config_store

logger = logging.getLogger(__name__)


class ClaudeAgentSDKEngine(BaseLLMEngine):
    """Claude Code driven by the official ``claude-agent-sdk`` Python package.

    The SDK's ``local`` transport still starts the ``claude`` binary as a child
    process, but the SDK manages that process in-process via the stream-json
    protocol — no shell wrapper, no ACP bridge. This adapter only drives the
    SDK's async ``query()`` API and maps its messages to internal events.
    """

    ENGINE_ID = "claude_agent_sdk"

    _live_message_wait_seconds: float = 1.5

    def __init__(self):
        self._running = False
        self._query_task: asyncio.Task | None = None

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
            EngineConfigField(
                key="max_budget_usd",
                label="美元预算",
                type="number",
                placeholder="如 0.5，留空为不限制",
                help="本轮对话的最大美元花费上限。",
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
            max_budget_usd=str(values.get("max_budget_usd") or ""),
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
        state = state if state is not None else {"emitted_text": False}
        events: list[InternalEvent] = []
        mtype = self._msg_type(msg)

        if mtype == "system":
            subtype = getattr(msg, "subtype", "") or ""
            if subtype == "init":
                events.append(
                    InternalEvent(type="status", data={"status": "initializing"})
                )
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

        if mtype == "assistant":
            for block in self._content_blocks(msg):
                block_type = self._block_type(block)
                if block_type == "text":
                    delta = getattr(block, "text", "") or ""
                    if delta:
                        state["emitted_text"] = True
                        events.append(
                            InternalEvent(type="text_delta", data={"delta": delta})
                        )
                elif block_type == "thinking":
                    thinking = getattr(block, "thinking", "") or ""
                    if thinking:
                        events.append(
                            InternalEvent(
                                type="thinking_delta", data={"delta": thinking}
                            )
                        )
                elif block_type == "tool_use":
                    events.append(
                        InternalEvent(type="tool_use", data={
                            "id": getattr(block, "id", "") or "",
                            "name": getattr(block, "name", "") or "",
                            "input": getattr(block, "input", {}) or {},
                        })
                    )
            return events

        if mtype == "user":
            for block in self._content_blocks(msg):
                if self._block_type(block) == "tool_result":
                    content = getattr(block, "content", "") or ""
                    if isinstance(content, list):
                        content = "\n".join(
                            str(part) for part in content if part
                        )
                    events.append(
                        InternalEvent(type="tool_result", data={
                            "tool_use_id": getattr(block, "tool_use_id", "") or "",
                            "content": content,
                            "is_error": bool(getattr(block, "is_error", False)),
                        })
                    )
            return events

        if mtype == "result":
            result = getattr(msg, "result", msg)
            is_error = bool(getattr(msg, "is_error", getattr(result, "is_error", False)))
            if not state["emitted_text"]:
                output = self._result_output(result)
                if str(output).strip():
                    state["emitted_text"] = True
                    events.append(
                        InternalEvent(type="text_delta", data={"delta": str(output)})
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
                events.append(InternalEvent(type="usage", data=usage_data))
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
    ) -> AsyncIterator[InternalEvent]:
        prompt = self.render_image_prompt(prompt, images)
        binary = self.resolve_binary()
        if not binary:
            yield InternalEvent(
                type="error", data={"message": "claude binary not found"}
            )
            return
        try:
            from claude_agent_sdk import ClaudeAgentOptions, query as sdk_query
        except Exception as exc:
            yield InternalEvent(
                type="error",
                data={"message": f"claude-agent-sdk 未安装：{exc}"},
            )
            return

        sdk_config = config_store.get_claude_agent_sdk_config()
        options = ClaudeAgentOptions(
            cwd=cwd,
            model=model or None,
            permission_mode=sdk_config["permission_mode"] or "acceptEdits",
            cli_path=binary,
        )
        if live_message_queue is not None:
            options.continue_conversation = True
        if add_dirs:
            options.add_dirs = list(add_dirs)
        if sdk_config["max_turns"]:
            options.max_turns = int(sdk_config["max_turns"])
        if sdk_config["fallback_model"]:
            options.fallback_model = sdk_config["fallback_model"]
        if sdk_config["max_budget_usd"]:
            options.max_budget_usd = float(sdk_config["max_budget_usd"])

        logger.info(
            "ClaudeAgentSDKEngine spawn: binary=%s cwd=%s model=%s options=%s",
            binary, cwd, model, options,
        )

        self._running = True
        yield InternalEvent(type="status", data={"status": "running"})

        event_queue: asyncio.Queue[InternalEvent | None] = asyncio.Queue()
        state: dict[str, Any] = {"emitted_text": False}

        async def prompt_source() -> AsyncIterator[str]:
            """Yield the initial prompt, then queued live messages."""
            yield prompt
            if live_message_queue is None:
                return
            while True:
                try:
                    message_id, content = await asyncio.wait_for(
                        live_message_queue.get(),
                        timeout=self._live_message_wait_seconds,
                    )
                except asyncio.TimeoutError:
                    return
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
                yield combined

        async def pump() -> None:
            try:
                async for message in sdk_query(
                    prompt=prompt_source(),
                    options=options,
                ):
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
                await event_queue.put(None)

        query_task = asyncio.create_task(pump())
        self._query_task = query_task
        try:
            while True:
                event = await event_queue.get()
                if event is None:
                    break
                yield event
            await query_task
        except asyncio.CancelledError:
            yield InternalEvent(type="status", data={"status": "cancelled"})
        except Exception as exc:
            logger.exception("ClaudeAgentSDKEngine spawn error")
            yield InternalEvent(type="error", data={"message": str(exc)})
        finally:
            if self._query_task is not None and not self._query_task.done():
                self._query_task.cancel()
                await asyncio.gather(self._query_task, return_exceptions=True)
            self._query_task = None
            self._running = False

    async def stop(self) -> None:
        if self._query_task is not None and not self._query_task.done():
            self._query_task.cancel()
            await asyncio.gather(self._query_task, return_exceptions=True)
            self._query_task = None
        self._running = False

    async def inject_response(self, tool_use_id: str, content: str) -> None:
        logger.warning("inject_response is not supported by ClaudeAgentSDKEngine")

    @property
    def supports_resume(self) -> bool:
        return False

    @property
    def supports_vision(self) -> bool:
        """Claude models accept markdown image references in prompts."""
        return True

    @property
    def supports_interactive(self) -> bool:
        return True  # continue_conversation accepts ordinary user messages mid-run

    @property
    def supports_live_stage_message(self) -> bool:
        return True

    def build_resume_params(self, session_id: str) -> dict:
        return {}
