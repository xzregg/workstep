"""CodexSDKEngine — Codex via the official ``openai-codex`` Python SDK."""

import asyncio
import importlib.metadata
import logging
import os
from typing import Any, AsyncIterator

from engines.base import BaseLLMEngine, EngineModel
from engines.events import InternalEvent, compacted_event, normalize_token_usage
from engines.schema import EngineConfigField, EngineConfigOption, EngineImage
from services.config import (
    CODEX_REASONING_EFFORTS,
    CODEX_SANDBOX_MODES,
    CODEX_SDK_APPROVAL_MODES,
    config_store,
)

logger = logging.getLogger(__name__)


class CodexSDKEngine(BaseLLMEngine):
    """Codex driven by the official ``openai-codex`` Python SDK.

    The SDK launches a ``codex`` CLI binary in-process (stream-json protocol)
    — no shell wrapper, no ACP bridge. The bundled ``openai-codex-cli-bin``
    runtime is used unless an explicit binary override is configured. This
    adapter only drives the SDK's async client and maps its notifications to
    internal events.
    """

    ENGINE_ID = "codex_sdk"

    _live_message_wait_seconds: float = 1.5

    def __init__(self):
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
        try:
            from openai_codex import AsyncCodex
            client = AsyncCodex(cwd=cwd or None)
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
        except Exception as exc:
            logger.warning("CodexSDKEngine list_models failed: %s", exc)
            return []

    # --- Notification mapping ---

    @staticmethod
    def _notification_method(notification: Any) -> str:
        return str(getattr(notification, "method", "") or "")

    @staticmethod
    def _root_of(item: Any) -> Any:
        return getattr(item, "root", item)

    @staticmethod
    def _tool_use_event(root: Any) -> InternalEvent:
        return InternalEvent(type="tool_use", data={
            "id": getattr(root, "id", "") or "",
            "name": getattr(root, "tool", "") or "",
            "input": getattr(root, "arguments", {}) or {},
        })

    @staticmethod
    def _tool_result_event(root: Any) -> InternalEvent:
        content_parts: list[str] = []
        for content_item in getattr(root, "content_items", None) or []:
            item_root = CodexSDKEngine._root_of(content_item)
            text = getattr(item_root, "text", None)
            if text:
                content_parts.append(str(text))
        status = getattr(root, "status", None)
        is_error = (
            getattr(status, "value", None) == "failed"
            or getattr(root, "success", True) is False
        )
        return InternalEvent(type="tool_result", data={
            "tool_use_id": getattr(root, "id", "") or "",
            "content": "\n".join(content_parts),
            "is_error": bool(is_error),
        })

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
                    InternalEvent(type="text_delta", data={"delta": str(delta)})
                )

        elif method in ("item/reasoning/textDelta", "item/reasoning/summaryTextDelta"):
            delta = getattr(payload, "delta", None) or ""
            if delta:
                events.append(
                    InternalEvent(type="thinking_delta", data={"delta": str(delta)})
                )

        elif method == "item/started":
            root = self._root_of(getattr(payload, "item", None))
            tool_id = getattr(root, "id", None)
            if (
                getattr(root, "type", "") == "dynamicToolCall"
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
                        InternalEvent(type="text_delta", data={"delta": str(text)})
                    )
            elif rtype == "reasoning":
                content = getattr(root, "content", None)
                text = getattr(self._root_of(content), "text", None) or ""
                if text:
                    events.append(
                        InternalEvent(type="thinking_delta", data={"delta": str(text)})
                    )
            elif rtype == "dynamicToolCall":
                status = getattr(root, "status", None)
                status_value = getattr(status, "value", None) or str(status or "").lower()
                tool_id = getattr(root, "id", None)
                if status_value == "inProgress":
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
                events.append(InternalEvent(type="usage", data=usage_data))

        elif method == "thread/compacted":
            events.append(compacted_event())

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
    ) -> AsyncIterator[InternalEvent]:
        async for event in self._spawn_with_sandbox(
            prompt=prompt,
            cwd=cwd,
            model=model,
            session_id=session_id,
            images=images,
            read_only=False,
            live_message_queue=live_message_queue,
        ):
            yield event

    async def spawn_coordinator(
        self,
        prompt: str,
        cwd: str,
        model: str | None = None,
        session_id: str | None = None,
        images: list[EngineImage] | None = None,
    ) -> AsyncIterator[InternalEvent]:
        guarded_prompt = self.render_image_prompt(
            self.coordinator_guard(prompt),
            images,
        )
        async for event in self._spawn_with_sandbox(
            prompt=guarded_prompt,
            cwd=cwd,
            model=model,
            session_id=session_id,
            images=images,
            read_only=True,
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
    ) -> AsyncIterator[InternalEvent]:
        """Internal spawn with an explicit codex sandbox policy."""
        if not CodexSDKEngine._sdk_available():
            yield InternalEvent(
                type="error", data={"message": "openai-codex SDK 未安装"}
            )
            return
        try:
            from openai_codex import ApprovalMode, AsyncCodex, Sandbox
        except Exception as exc:
            yield InternalEvent(
                type="error",
                data={"message": f"openai-codex SDK 未安装：{exc}"},
            )
            return

        sdk_config = config_store.get_codex_sdk_config()
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
        if sdk_config["model_reasoning_effort"]:
            thread_config["model_reasoning_effort"] = sdk_config[
                "model_reasoning_effort"
            ]
        thread_kwargs: dict[str, Any] = {
            "cwd": cwd,
            "model": model or None,
            "sandbox": sandbox,
            "config": thread_config or None,
        }
        if approval_mode is not None:
            # thread_start 的 approval_mode 不接受 None（默认 auto_review）
            thread_kwargs["approval_mode"] = approval_mode
        client_kwargs: dict[str, Any] = {}
        override = self.get_binary_override()
        if override:
            client_kwargs["codex_bin"] = override

        self._running = True
        yield InternalEvent(type="status", data={"status": "initializing"})

        client: Any = None
        try:
            client = AsyncCodex(**client_kwargs)
            self._client = client
            event_queue: asyncio.Queue[InternalEvent | None] = asyncio.Queue()
            state: dict[str, Any] = {"emitted_text": False, "tool_emitted": set()}

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
                        turn = await thread.turn(injected, model=model or None)
                        async for notification in turn.stream():
                            for event in self._map_notification(notification, state):
                                await event_queue.put(event)
                        for message_id, _ in live_items:
                            await event_queue.put(InternalEvent(
                                type="live_message",
                                data={
                                    "message_id": message_id,
                                    "status": "delivered",
                                    "detail": "",
                                },
                            ))
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

    def build_resume_params(self, session_id: str) -> dict:
        return {"session_id": session_id}
