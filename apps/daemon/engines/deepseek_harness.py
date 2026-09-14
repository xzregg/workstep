"""DeepSeekHarnessEngine — DeepSeek official Harness Python SDK adapter."""

import asyncio
import importlib.metadata
import importlib.util
import json
import logging
import os
import uuid
from collections.abc import Mapping
from pathlib import Path
from typing import Any, AsyncIterator

from engines.core.acp_base import AcpEngineBase
from engines.core.base import (
    EngineCapabilities,
    EngineInstallResult,
    EngineModel,
    install_python_package,
)
from engines.core.events import (
    InternalEvent,
    acp_raw_event,
    agent_message_chunk,
    agent_thought_chunk,
    compacted_event,
    tool_call_event,
    tool_call_update_event,
    usage_update_event,
)
from engines.core.plans import plan_event, subagent_event
from engines.core.schema import EngineConfigField, EngineConfigOption, EngineImage
from services import providers as provider_service
from services.config import config_store

logger = logging.getLogger(__name__)


class DeepSeekHarnessEngine(AcpEngineBase):
    """Run the official local DeepSeek Harness composition through its SDK."""

    ENGINE_ID = "deepseek_harness"
    UPDATE_PACKAGE = "deepseek-harness-sdk"

    @classmethod
    def supported_provider_protocols(cls) -> set[str]:
        return {"openai_chat_completions"}

    @classmethod
    def provider_required(cls) -> bool:
        return True

    @classmethod
    def supports_provider(cls, provider: dict) -> bool:
        return (
            super().supports_provider(provider)
            and str(provider.get("type") or "") == "deepseek"
        )
    SDK_PACKAGE = "deepseek-harness-sdk==0.1.0rc6"
    DEFAULT_PRESET = "standard"
    PRESET_COMPOSITIONS = {
        "standard": (
            Path(__file__).resolve().parent.parent
            / "data"
            / "deepseek-harness"
            / "standard.cordis.yml"
        ),
    }

    def __init__(self):
        super().__init__()
        self._running = False
        self._harness = None
        self._run_task: asyncio.Task | None = None
        self._streamed_blocks: set[tuple[int, int, str]] = set()
        self._turn_error_emitted = False

    @staticmethod
    def is_installed() -> bool:
        try:
            sdk_available = importlib.util.find_spec("deepseek_harness") is not None
        except (ImportError, ValueError):
            sdk_available = False
        return sdk_available and DeepSeekHarnessEngine.resolve_binary() is not None

    @staticmethod
    def is_configured() -> bool:
        config = config_store.get_deepseek_harness_config()
        provider = config_store.get_provider(config.get("provider_id") or "")
        return bool(
            config.get("model")
            and provider
            and provider.get("type") == "deepseek"
            and DeepSeekHarnessEngine.supports_provider(provider)
            and provider.get("enabled", True)
            and str(provider.get("base_url") or "").strip()
            and str(provider.get("api_key") or "").strip()
        )

    @staticmethod
    def get_version() -> str | None:
        try:
            return importlib.metadata.version("deepseek-harness-sdk")
        except importlib.metadata.PackageNotFoundError:
            return None

    @staticmethod
    def resolve_binary() -> str | None:
        override = DeepSeekHarnessEngine.get_binary_override()
        if override is not None:
            return override if os.path.isfile(override) else None
        try:
            from deepseek_harness_runtime import bundled_runtime_path

            path = bundled_runtime_path()
            return str(path) if path else None
        except Exception:
            return None

    @staticmethod
    def install_command() -> str:
        return f"pip install {DeepSeekHarnessEngine.SDK_PACKAGE}"

    async def install(self) -> EngineInstallResult:
        return await install_python_package(self.SDK_PACKAGE)

    @classmethod
    def config_schema(cls) -> list[EngineConfigField]:
        options = tuple(
            EngineConfigOption(str(item["id"]), str(item["name"]))
            for item in config_store.get_providers()
            if item.get("enabled", True) and item.get("type") == "deepseek"
        )
        return [
            EngineConfigField(
                key="provider_id",
                label="DeepSeek 供应商",
                type="select",
                options=options or (EngineConfigOption("", "暂无已启用的 DeepSeek 供应商"),),
                required=True,
                help="复用设置 → 供应商中的 DeepSeek API 地址与密钥。",
            ),
            EngineConfigField(
                key="max_tokens",
                label="最大输出 Token",
                type="number",
                placeholder="留空使用 Harness 默认值",
            ),
            EngineConfigField(
                key="preset",
                label="Agent 预设",
                type="select",
                options=(EngineConfigOption("standard", "标准（推荐）"),),
                required=True,
                help=(
                    "SDK 标准组合：命令、文件、技能、后台任务、子代理、Todo、"
                    "会话恢复与上下文压缩。"
                ),
            ),
        ]

    def get_config_values(self) -> dict:
        config = config_store.get_deepseek_harness_config()
        return {
            "provider_id": config["provider_id"],
            "max_tokens": config["max_tokens"],
            "preset": config.get("preset") or self.DEFAULT_PRESET,
        }

    async def save_config_values(
        self,
        values: dict,
        clear: dict[str, bool] | None = None,
        confirmed: dict[str, bool] | None = None,
    ) -> None:
        provider_id = str(values.get("provider_id") or "").strip()
        provider = await asyncio.to_thread(config_store.get_provider, provider_id)
        if not provider_id:
            raise ValueError("请选择 DeepSeek 供应商")
        if (
            provider is None
            or provider.get("type") != "deepseek"
            or not provider.get("enabled", True)
        ):
            raise ValueError("所选 DeepSeek 供应商不存在或已停用")
        current = await asyncio.to_thread(config_store.get_deepseek_harness_config)
        preset = str(
            values.get("preset", current.get("preset") or self.DEFAULT_PRESET) or ""
        ).strip()
        if preset not in self.PRESET_COMPOSITIONS:
            raise ValueError("DeepSeek Harness preset 不受支持")
        max_tokens = str(values.get("max_tokens", current["max_tokens"]) or "").strip()
        if max_tokens:
            try:
                if int(max_tokens) <= 0:
                    raise ValueError
            except ValueError:
                raise ValueError("最大输出 Token 必须是正整数") from None
        await asyncio.to_thread(
            config_store.set_deepseek_harness_config,
            provider_id=provider_id,
            model=str(current["model"] or "deepseek-v4-flash"),
            max_tokens=max_tokens,
            preset=preset,
        )

    async def list_models(
        self,
        cwd: str,
        provider_id: str | None = None,
        refresh: bool = False,
    ) -> list[EngineModel]:
        config = await asyncio.to_thread(config_store.get_deepseek_harness_config)
        provider = await asyncio.to_thread(
            config_store.get_provider, provider_id or config["provider_id"]
        )
        if provider is None or provider.get("type") != "deepseek":
            return []
        entry = await asyncio.to_thread(config_store.get_provider_models, provider["id"])
        if entry and not refresh:
            return await asyncio.to_thread(provider_service.saved_models, provider["id"])
        return await provider_service.fetch_and_save_models(provider)

    def _build_harness(
        self,
        *,
        cwd: str,
        provider: dict,
        model: str,
        max_tokens: int | None,
        preset: str,
    ):
        from deepseek_harness import DeepSeekHarness

        composition = self.PRESET_COMPOSITIONS.get(preset)
        if composition is None:
            raise ValueError(f"Unsupported DeepSeek Harness preset: {preset}")
        if not composition.is_file():
            raise FileNotFoundError(f"DeepSeek Harness composition not found: {composition}")

        project_root = Path(cwd).expanduser().resolve()
        from services.skill_runtime import prepare_deepseek_composition

        controlled_skills = self.project_skills(str(project_root))
        composition = prepare_deepseek_composition(controlled_skills, composition)
        session_root = project_root / ".workstep" / "deepseek-harness" / "sessions"
        session_root.mkdir(parents=True, exist_ok=True)
        kwargs: dict[str, Any] = {
            "provider": "deepseek-official",
            "model": model,
            "max_tokens": max_tokens,
            "cwd": str(project_root),
            "runtime_cwd": str(project_root),
            "session_root": str(session_root),
            "base_url": str(provider.get("base_url") or "").rstrip("/"),
            "api_key": str(provider.get("api_key") or ""),
            "cordis": str(composition),
        }
        override = self.get_binary_override()
        if override:
            kwargs["runtime_bin"] = override
        return DeepSeekHarness(**kwargs)

    @staticmethod
    def _text_content(blocks: Any) -> str:
        if not isinstance(blocks, list):
            return ""
        parts: list[str] = []
        for block in blocks:
            if not isinstance(block, Mapping):
                continue
            if block.get("type") == "text":
                parts.append(str(block.get("text") or ""))
            elif block.get("type") == "tool-result":
                parts.append(DeepSeekHarnessEngine._text_content(block.get("content")))
        return "".join(parts)

    @staticmethod
    def _tool_input(raw: Any) -> Any:
        if not isinstance(raw, str):
            return raw
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return raw

    def _map_notification(self, notification, root_session_id):
        payload = getattr(notification, "payload", {})
        method = getattr(notification, "method", "")
        if not isinstance(payload, Mapping):
            return self._map_notification_content(notification, root_session_id)
        children = self.__dict__.setdefault("_child_streamed_blocks", {})
        if method == "subagent.started" and payload.get("parentSessionId") == root_session_id:
            children.setdefault(str(payload.get("childSessionId")), set())
        child_id = str(payload.get("sessionId") or "")
        if method == "session.event" and child_id != root_session_id and child_id in children:
            parent_blocks = self._streamed_blocks
            try:
                self._streamed_blocks = children[child_id]
                events = self._map_notification_content(notification, child_id)
            finally:
                self._streamed_blocks = parent_blocks
            frames = []
            for event in events:
                frame = subagent_event(task_id=child_id, status="running", stage="progress")
                frame.data["event"] = event.to_dict()
                frames.append(frame)
            return frames
        return self._map_notification_content(notification, root_session_id)

    def _map_notification_content(
        self,
        notification: Any,
        root_session_id: str,
    ) -> list[InternalEvent]:
        """Map one official SDK notification without leaking child text."""
        method = str(getattr(notification, "method", "") or "")
        payload = getattr(notification, "payload", {})
        if not isinstance(payload, Mapping):
            return [acp_raw_event({"method": method, "payload": payload})]

        if method in {"subagent.started", "subagent.finished"}:
            parent_id = str(payload.get("parentSessionId") or "")
            child_id = str(payload.get("childSessionId") or "")
            if not child_id or (parent_id != root_session_id and child_id == root_session_id):
                return []
            if method == "subagent.started":
                return [subagent_event(
                    task_id=child_id,
                    status="running",
                    stage="started",
                    description=f"DeepSeek Harness 子代理 {child_id}",
                )]
            status = "completed" if payload.get("status") == "ok" else "failed"
            return [subagent_event(
                task_id=child_id,
                status=status,
                stage="finished",
                description=f"DeepSeek Harness 子代理 {child_id}",
                summary=self._text_content(payload.get("lastAssistantMessage")) or None,
            )]

        if method == "session.status":
            if payload.get("sessionId") != root_session_id:
                return []
            status = str(payload.get("status") or "")
            return [InternalEvent(type="status", data={"status": status})]

        if method != "session.event":
            return [acp_raw_event({"method": method, "payload": dict(payload)})]
        if payload.get("sessionId") != root_session_id:
            return []
        event = payload.get("event")
        if not isinstance(event, Mapping):
            return [acp_raw_event({"method": method, "payload": dict(payload)})]
        event_type = str(event.get("type") or "")
        data = event.get("data")
        data = data if isinstance(data, Mapping) else {}

        if event_type == "turn/start":
            self._streamed_blocks.clear()
            return []
        if event_type == "assistant/chunk":
            chunk = data.get("chunk")
            if not isinstance(chunk, Mapping):
                return [acp_raw_event(event)]
            chunk_type = str(chunk.get("type") or "")
            text = str(chunk.get("text") or "")
            if chunk_type in {"text-delta", "reasoning-delta"} and text:
                key = (
                    int(data.get("turn") or 0),
                    int(data.get("step") or 0),
                    chunk_type,
                )
                self._streamed_blocks.add(key)
                factory = (
                    agent_message_chunk
                    if chunk_type == "text-delta"
                    else agent_thought_chunk
                )
                return [factory(text)]
            if chunk_type in {"block-start", "block-end", "tool-call-delta"}:
                return []
            return [acp_raw_event(event)]
        if event_type == "assistant/message":
            result: list[InternalEvent] = []
            turn = int(data.get("turn") or 0)
            step = int(data.get("step") or 0)
            message = data.get("message")
            message = message if isinstance(message, Mapping) else data
            for block in message.get("content", []) if isinstance(message, Mapping) else []:
                if not isinstance(block, Mapping):
                    continue
                block_type = str(block.get("type") or "")
                text = str(block.get("text") or "")
                stream_type = {
                    "text": "text-delta",
                    "reasoning": "reasoning-delta",
                }.get(block_type)
                if not text or stream_type is None:
                    continue
                if (turn, step, stream_type) in self._streamed_blocks:
                    continue
                factory = (
                    agent_message_chunk
                    if block_type == "text"
                    else agent_thought_chunk
                )
                result.append(factory(text))
            usage = data.get("usage")
            if isinstance(usage, Mapping):
                normalized = {
                    "input_tokens": usage.get("inputTokens", usage.get("input_tokens", 0)),
                    "output_tokens": usage.get("outputTokens", usage.get("output_tokens", 0)),
                    "cache_read_input_tokens": usage.get(
                        "cacheReadInputTokens",
                        usage.get("cache_read_input_tokens", 0),
                    ),
                    "cache_creation_input_tokens": usage.get(
                        "cacheCreationInputTokens",
                        usage.get("cache_creation_input_tokens", 0),
                    ),
                }
                result.append(usage_update_event(normalized))
            return result
        if event_type == "tool/call":
            return [tool_call_event(
                tool_call_id=str(data.get("callId") or ""),
                title=str(data.get("name") or "tool"),
                kind="other",
                raw_input=self._tool_input(data.get("arguments")),
            )]
        if event_type == "tool/result":
            message = data.get("message")
            message = message if isinstance(message, Mapping) else data
            source = message.get("source") if isinstance(message, Mapping) else {}
            source = source if isinstance(source, Mapping) else {}
            blocks = message.get("content") if isinstance(message, Mapping) else []
            is_error = bool(data.get("isError"))
            if isinstance(blocks, list):
                for block in blocks:
                    if isinstance(block, Mapping) and block.get("type") == "tool-result":
                        is_error = bool(block.get("isError"))
            return [tool_call_update_event(
                tool_call_id=str(source.get("callId") or data.get("callId") or ""),
                status="failed" if is_error else "completed",
                raw_output=self._text_content(blocks),
            )]
        if event_type == "todo/write":
            todos = data.get("todos")
            return [plan_event(
                item for item in (todos if isinstance(todos, list) else [])
                if isinstance(item, Mapping)
            )]
        if event_type == "compaction/summary":
            return [compacted_event(self._text_content(data.get("summary")) or None)]
        if event_type == "turn/end":
            reason = data.get("reason")
            reason = reason if isinstance(reason, Mapping) else {}
            if reason.get("kind") != "error":
                return []
            failure = reason.get("error") or reason.get("failure")
            failure = failure if isinstance(failure, Mapping) else {}
            message = str(
                failure.get("message")
                or reason.get("message")
                or "DeepSeek Harness 执行失败"
            )
            error_data = {"message": message}
            code = failure.get("code") or reason.get("code")
            if code:
                error_data["code"] = str(code)
            self._turn_error_emitted = True
            return [InternalEvent(type="error", data=error_data)]
        if event_type in {
            "agent/inbox/spliced", "user/message", "step/start", "step/end",
        }:
            return []
        return [acp_raw_event(event)]

    @property
    def capabilities(self) -> EngineCapabilities:
        return EngineCapabilities(
            supports_coordinator=self.is_configured(),
            supports_resume=True,
            supports_tool_disable=False,
            supports_native_schema=False,
            supports_live_stage_message=False,
            supports_sessions=True,
            supports_tool_approval=False,
            supports_vision=False,
            supports_workstep_tools=False,
            supports_thinking_effort=False,
        )

    @property
    def supports_sessions(self) -> bool:
        return True

    @property
    def supports_resume(self) -> bool:
        return True

    async def spawn(
        self,
        prompt: str,
        cwd: str,
        model: str | None = None,
        session_id: str | None = None,
        images: list[EngineImage] | None = None,
        **kwargs,
    ) -> AsyncIterator[InternalEvent]:
        yield InternalEvent(type="status", data={"status": "initializing"})
        if images:
            yield InternalEvent(
                type="error",
                data={"message": "DeepSeek Harness 当前不支持图片输入"},
            )
            return
        if not await asyncio.to_thread(self.is_installed):
            yield InternalEvent(
                type="error",
                data={"message": "deepseek-harness-sdk 未安装"},
            )
            return

        config = self.merge_config_overrides(
            await asyncio.to_thread(config_store.get_deepseek_harness_config),
            kwargs.get("config_overrides"),
        )
        selected_model = str(
            model
            or await asyncio.to_thread(
                config_store.get_engine_default_model, self.ENGINE_ID
            )
            or config.get("model")
            or "deepseek-v4-flash"
        )
        try:
            provider_runtime = self.resolve_provider_runtime(
                provider_id=str(config.get("provider_id") or ""),
                model=selected_model,
            )
        except ValueError as exc:
            yield InternalEvent(type="error", data={"message": str(exc)})
            return
        provider = await asyncio.to_thread(
            config_store.get_provider, provider_runtime.provider_id
        )
        if (
            provider is None
            or not provider.get("base_url")
            or not provider.get("api_key")
        ):
            yield InternalEvent(
                type="error",
                data={"message": "请先配置可用的 DeepSeek 供应商"},
            )
            return
        raw_max_tokens = str(config.get("max_tokens") or "").strip()
        max_tokens = int(raw_max_tokens) if raw_max_tokens else None
        root_session_id = str(session_id or f"session-{uuid.uuid4().hex}")
        event_queue: asyncio.Queue[tuple[str, Any]] = asyncio.Queue()
        loop = asyncio.get_running_loop()
        harness = None

        try:
            harness = await asyncio.to_thread(
                self._build_harness,
                cwd=cwd,
                provider=provider,
                model=selected_model,
                max_tokens=max_tokens,
                preset=str(config.get("preset") or self.DEFAULT_PRESET),
            )
            self._harness = harness
            self._running = True
            self._streamed_blocks.clear()
            self.__dict__.setdefault("_child_streamed_blocks", {}).clear()
            self._turn_error_emitted = False
            yield InternalEvent(
                type="session_started",
                data={"session_id": root_session_id},
            )
            yield InternalEvent(type="status", data={"status": "running"})

            def on_notification(notification: Any) -> None:
                loop.call_soon_threadsafe(
                    event_queue.put_nowait,
                    ("notification", notification),
                )

            async def run_sdk() -> None:
                try:
                    result = await asyncio.to_thread(
                        harness.run,
                        prompt,
                        session_id=root_session_id,
                        on_notification=on_notification,
                    )
                    await event_queue.put(("result", result))
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    await event_queue.put(("error", exc))

            self._run_task = asyncio.create_task(run_sdk())
            finish_reason: str | None = None
            while True:
                item_type, value = await event_queue.get()
                if item_type == "notification":
                    for event in self._map_notification(value, root_session_id):
                        # The adapter owns top-level lifecycle events. SDK idle/running
                        # notifications only delimit its synchronous run internally.
                        if event.type != "status":
                            yield event
                    continue
                if item_type == "error":
                    raise value
                finish_reason = str(getattr(value, "finish_reason", "") or "")
                break

            await self._run_task
            if finish_reason in {"aborted", "disposed", "interrupted", "cancelled"}:
                yield InternalEvent(type="status", data={"status": "cancelled"})
            elif finish_reason == "error":
                if not self._turn_error_emitted:
                    yield InternalEvent(
                        type="error",
                        data={"message": "DeepSeek Harness 执行失败"},
                    )
            else:
                yield InternalEvent(type="status", data={"status": "done"})
        except asyncio.CancelledError:
            yield InternalEvent(type="status", data={"status": "cancelled"})
        except Exception as exc:
            logger.exception("DeepSeekHarnessEngine spawn error")
            yield InternalEvent(type="error", data={"message": str(exc)})
        finally:
            task, self._run_task = self._run_task, None
            if task is not None and not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            if harness is not None:
                try:
                    await asyncio.wait_for(asyncio.to_thread(harness.close), timeout=5)
                except Exception:
                    logger.warning("DeepSeek Harness runtime close failed", exc_info=True)
            self._harness = None
            self._running = False

    async def stop(self) -> None:
        self._running = False
        harness, self._harness = self._harness, None
        if harness is not None:
            try:
                await asyncio.wait_for(asyncio.to_thread(harness.close), timeout=5)
            except Exception:
                logger.warning("DeepSeek Harness runtime stop failed", exc_info=True)

    async def create_session(
        self,
        cwd: str,
        add_dirs: list[str] | None = None,
        mcp_servers: list | None = None,
    ) -> str | None:
        # The official SDK creates and persists a session lazily on first prompt.
        return None

    async def resume_session(
        self,
        session_id: str,
        cwd: str,
        add_dirs: list[str] | None = None,
        mcp_servers: list | None = None,
    ) -> bool:
        # spawn(session_id=...) is the SDK's native resume seam.
        return bool(session_id)

    async def close_session(self, session_id: str, cwd: str | None = None) -> None:
        if self._running:
            await self.stop()

    async def cancel_session(self, session_id: str, cwd: str | None = None) -> None:
        if self._running:
            await self.stop()

    def build_resume_params(self, session_id: str) -> dict:
        return {"session_id": session_id}

    acp_events: frozenset[str] = frozenset({
        "agent_message_chunk",
        "agent_thought_chunk",
        "tool_call",
        "tool_call_update",
        "plan",
        "usage_update",
        "status",
        "session_started",
        "compacted",
        "subagent",
        "error",
        "acp_raw",
    })
