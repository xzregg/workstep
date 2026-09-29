"""CodexSDKEngine — Codex via the official ``openai-codex`` Python SDK."""

import asyncio
import importlib.metadata
import inspect
import json
import logging
import os
import re
import uuid
from typing import Any, AsyncIterator

from engines.codex_compaction import compact_codex_thread
from engines.codex_sdk_events import CodexSDKNotificationMapper
from engines.core.acp_base import AcpEngineBase
from engines.core.base import (
    EngineInstallResult,
    EngineModel,
    ProviderRuntimeConfig,
    WIRE_API_BY_PROTOCOL,
    install_python_package,
    resolve_thinking_effort,
)

from engines.core.events import (
    InternalEvent,
    UnphasedMessageClassifier,
    agent_message_chunk,
    compacted_event,
)
from engines.core.interactions import permission_request, permission_signature
from engines.core.input_items import workstep_input_commands
from engines.core.packages import RuntimePackage
from engines.core.schema import EngineConfigField, EngineConfigOption, EngineImage
from services import providers as provider_service
from services.config import config_store
from services.engine_config_rules import (
    CODEX_REASONING_EFFORTS,
    CODEX_SANDBOX_MODES,
    CODEX_SDK_APPROVAL_MODES,
    normalize_codex_custom_config,
    parse_codex_custom_config,
)

logger = logging.getLogger(__name__)


_TRANSPORT_CLOSED_RE = re.compile(
    r"Codex process (?:closed stdout|is not running)",
    re.IGNORECASE,
)


def _public_transport_error(error: BaseException) -> str:
    """Hide SDK stderr dumps from user-visible assistant messages."""
    if _TRANSPORT_CLOSED_RE.search(str(error)):
        return "Codex 会话已结束，后台服务可能已重启。"
    return str(error)


class CodexSDKEngine(CodexSDKNotificationMapper, AcpEngineBase):
    """Codex driven by the official ``openai-codex`` Python SDK.

    The SDK launches a ``codex`` CLI binary in-process (stream-json protocol)
    — no shell wrapper, no ACP bridge. The bundled ``openai-codex-cli-bin``
    runtime is used unless an explicit binary override is configured. This
    adapter only drives the SDK's async client and maps its notifications to
    internal events.
    """

    ENGINE_ID = "codex_sdk"
    RUNTIME_PACKAGE = RuntimePackage('openai-codex', 'pypi', '0.147.0', None)
    UPDATE_PACKAGE = "openai-codex"
    QUOTA_TIMEOUT_SECONDS = 5

    @classmethod
    def supported_provider_protocols(cls) -> set[str]:
        return {"openai_responses"}

    def build_provider_runtime(self, provider, model, protocol=None):
        selected_protocol = str(protocol or "openai_responses")
        base_url = provider_service.provider_runtime_base_url(
            provider, selected_protocol
        )
        wire_api = WIRE_API_BY_PROTOCOL.get(
            selected_protocol, "responses"
        )
        return ProviderRuntimeConfig(
            provider_id=str(provider.get("id") or ""),
            model=model,
            protocol=selected_protocol,
            env={"WORKSTEP_LLM_API_KEY": str(provider.get("api_key") or "")},
            engine_config=(
                'model_provider="workstep"',
                'model_providers.workstep.name="WorkStep"',
                f"model_providers.workstep.base_url={json.dumps(base_url)}",
                'model_providers.workstep.env_key="WORKSTEP_LLM_API_KEY"',
                f'model_providers.workstep.wire_api="{wire_api}"',
            ),
        )

    def __init__(self):
        super().__init__()
        self._running = False
        self._stream_task: asyncio.Task | None = None
        self._client: Any | None = None
        self._goal_state: Any | None = None

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
            EngineConfigField(
                key="custom_config",
                label="自定义配置覆盖",
                type="textarea",
                step_hidden=True,
                placeholder="model_context_window = 128000\nmodel_max_output_tokens = 8192",
                help=(
                    "每行一条 key=value，写入 thread config（等价 config.toml 覆盖）。"
                    "# 开头为注释。已由 WorkStep / 供应商设置的键优先，此处只补充。"
                ),
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
        await asyncio.to_thread(
            config_store.set_codex_sdk_config,
            model_reasoning_effort=str(values.get("model_reasoning_effort") or ""),
            approval_mode=str(values.get("approval_mode") or ""),
            sandbox=str(values.get("sandbox") or ""),
            custom_config=str(values.get("custom_config") or ""),
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

    @staticmethod
    def _quota_window(value: Any) -> dict[str, Any] | None:
        if value is None:
            return None
        used = int(getattr(value, "used_percent", 0) or 0)
        return {
            "used_percent": used,
            "remaining_percent": max(0, 100 - used),
            "resets_at": getattr(value, "resets_at", None),
            "window_duration_mins": getattr(value, "window_duration_mins", None),
        }

    async def _read_account_quota(self, client: Any) -> dict[str, Any]:
        """Read and normalize account limits from an initialized SDK client."""
        from openai_codex.generated.v2_all import GetAccountRateLimitsResponse

        response = await client._client.request(
            "account/rateLimits/read",
            None,
            response_model=GetAccountRateLimitsResponse,
        )
        snapshot = response.rate_limits
        data: dict[str, Any] = {
            "engine_id": self.ENGINE_ID,
            "primary": self._quota_window(snapshot.primary),
            "secondary": self._quota_window(snapshot.secondary),
            "limit_id": snapshot.limit_id,
            "limit_name": snapshot.limit_name,
            "plan_type": getattr(snapshot.plan_type, "value", snapshot.plan_type),
            "rate_limit_reached_type": getattr(
                snapshot.rate_limit_reached_type,
                "value",
                snapshot.rate_limit_reached_type,
            ),
        }
        if snapshot.credits is not None:
            data["credits"] = {
                "balance": snapshot.credits.balance,
                "has_credits": snapshot.credits.has_credits,
                "unlimited": snapshot.credits.unlimited,
            }
        if snapshot.individual_limit is not None:
            data["individual_limit"] = {
                "limit": snapshot.individual_limit.limit,
                "used": snapshot.individual_limit.used,
                "remaining_percent": snapshot.individual_limit.remaining_percent,
                "resets_at": snapshot.individual_limit.resets_at,
            }
        if response.rate_limits_by_limit_id is not None:
            data["rate_limits_by_limit_id"] = response.rate_limits_by_limit_id
        return data

    async def get_quota(self, cwd: str = "") -> dict[str, Any] | None:
        """Fetch account quota through a short-lived Codex SDK connection."""
        from openai_codex import AsyncCodex, CodexConfig

        client = AsyncCodex(config=CodexConfig(
            codex_bin=self.get_binary_override() or None,
            cwd=cwd or None,
        ))

        async def fetch() -> dict[str, Any]:
            async with client:
                return await self._read_account_quota(client)

        try:
            return await asyncio.wait_for(fetch(), timeout=self.QUOTA_TIMEOUT_SECONDS)
        except Exception:
            logger.info("Codex SDK account quota unavailable", exc_info=True)
            return None

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
        plan_mode: bool | None = None,
        goal_action: str | None = None,
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
            plan_mode=plan_mode,
            goal_action=goal_action,
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
        message_history: list | None = None,
        report_engine_state: bool = False,
        thinking_effort: str | None = None,
        workstep_tools: bool = False,
        config_overrides: dict | None = None,
    ) -> AsyncIterator[InternalEvent]:
        # Codex SDK resumes context by native thread id.  Keep the common
        # coordinator signature, but do not round-trip host-managed history.
        guarded_prompt = await asyncio.to_thread(
            self.render_image_prompt,
            prompt if session_id and self.supports_resume
            else self._coordinator_prompt(prompt, workstep_tools=workstep_tools),
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
            config_overrides=config_overrides,
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
        plan_mode: bool | None = None,
        goal_action: str | None = None,
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
                AsyncTurnHandle,
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
            await asyncio.to_thread(config_store.get_codex_sdk_config),
            config_overrides,
        )
        provider_runtime = await asyncio.to_thread(
            self.resolve_provider_runtime,
            provider_id=str((config_overrides or {}).get("provider_id") or ""),
            model=model,
        )
        model = provider_runtime.model
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
        thread_config = {
            "model_reasoning_summary": "detailed",
            "model_supports_reasoning_summaries": True,
        }
        reasoning_effort = resolve_thinking_effort(
            thinking_effort, sdk_config["model_reasoning_effort"]
        )
        if reasoning_effort:
            thread_config["model_reasoning_effort"] = reasoning_effort
        # 自定义覆盖只补充：已由 WorkStep / 供应商设置的键优先。
        for key, value in parse_codex_custom_config(
            sdk_config.get("custom_config")
        ):
            thread_config.setdefault(key, value)
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
        from services.skill_runtime import prepare_codex_skills

        skill_override = await asyncio.to_thread(
            lambda: prepare_codex_skills(self.project_skills(cwd))[1]
        )
        client_config = CodexConfig(
            codex_bin=override or None,
            cwd=cwd or None,
            config_overrides=provider_runtime.engine_config + (skill_override,),
            env=(provider_runtime.child_env() if provider_runtime.provider_id else None),
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
                "unphased": UnphasedMessageClassifier(),
            }

            async def stream_turn(turn: Any) -> None:
                stream = turn.stream().__aiter__()
                notification_task = asyncio.create_task(anext(stream))
                live_task = (
                    asyncio.create_task(live_message_queue.get())
                    if live_message_queue is not None
                    else None
                )
                try:
                    while True:
                        waiters = {notification_task}
                        if live_task is not None:
                            waiters.add(live_task)
                        done, _ = await asyncio.wait(
                            waiters,
                            return_when=asyncio.FIRST_COMPLETED,
                        )
                        if live_task is not None and live_task in done:
                            live_items = [live_task.result()]
                            while not live_message_queue.empty():
                                live_items.append(live_message_queue.get_nowait())
                            injected = "\n\n".join(
                                content for _, content in live_items
                            )
                            try:
                                await turn.steer(injected)
                            except Exception as exc:
                                for message_id, _ in live_items:
                                    await event_queue.put(InternalEvent(
                                        type="live_message",
                                        data={
                                            "message_id": message_id,
                                            "status": "failed",
                                            "detail": str(exc) or "插入消息失败",
                                        },
                                    ))
                            else:
                                for message_id, _ in live_items:
                                    await event_queue.put(InternalEvent(
                                        type="live_message",
                                        data={
                                            "message_id": message_id,
                                            "status": "delivered",
                                            "detail": "",
                                        },
                                    ))
                            live_task = asyncio.create_task(
                                live_message_queue.get()
                            )
                            continue
                        try:
                            notification = notification_task.result()
                        except StopAsyncIteration:
                            break
                        for event in self._map_notification(notification, state):
                            await event_queue.put(event)
                        notification_task = asyncio.create_task(anext(stream))
                finally:
                    # Interrupted/older streams may never complete an item. Keep
                    # its actual text without guessing a phase or losing the tail.
                    for item_id, item in state.get("message_items", {}).items():
                        stream = self._visualize_stream(state, item_id)
                        rendered = (
                            stream.feed(item["pending"])
                            if item["pending"]
                            else ""
                        ) + stream.flush()
                        if rendered:
                            flushed_event = agent_message_chunk(
                                rendered, phase=item.get("phase"), source_item_id=item_id,
                            )
                            if item.get("phase"):
                                await event_queue.put(flushed_event)
                            else:
                                for event in state["unphased"].offer(
                                    flushed_event, split=True,
                                ):
                                    await event_queue.put(event)
                        if item["pending"]:
                            item["text"] += item["pending"]
                            item["pending"] = ""
                    for event in state["unphased"].flush():
                        await event_queue.put(event)
                    notification_task.cancel()
                    if live_task is not None:
                        live_task.cancel()
                    await asyncio.gather(
                        notification_task,
                        *([live_task] if live_task is not None else []),
                        return_exceptions=True,
                    )

            async def pump() -> None:
                try:
                    if prompt.strip() == "/compact" and not session_id:
                        raise ValueError("没有可压缩的 Codex 会话")
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
                    if prompt.strip() == "/compact":
                        await compact_codex_thread(client, thread)
                        await event_queue.put(compacted_event())
                        return
                    if goal_action:
                        await self._run_goal_command(
                            client, thread, goal_action, prompt, state, event_queue,
                            model=model, reasoning_effort=reasoning_effort,
                        )
                        return
                    if plan_mode is None:
                        turn = await thread.turn(prompt, model=model or None)
                    else:
                        turn = await self._start_collaboration_turn(
                            client,
                            thread,
                            prompt,
                            model=model,
                            reasoning_effort=reasoning_effort,
                            plan_mode=plan_mode,
                            turn_handle_type=AsyncTurnHandle,
                        )
                    await stream_turn(turn)
                    if (
                        state.get("notification_error")
                        and not state.get("turn_completed")
                    ):
                        await event_queue.put(InternalEvent(
                            type="error",
                            data={"message": state["notification_error"]},
                        ))
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    logger.exception("Codex SDK turn error")
                    await event_queue.put(
                        InternalEvent(
                            type="error",
                            data={"message": _public_transport_error(exc)},
                        )
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
            yield InternalEvent(
                type="error",
                data={"message": _public_transport_error(exc)},
            )
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

    async def _run_goal_command(
        self,
        client: Any,
        thread: Any,
        action: str,
        objective: str,
        state: dict[str, Any],
        event_queue: asyncio.Queue,
        *,
        model: str | None = None,
        reasoning_effort: str | None = None,
    ) -> None:
        """Run one native goal operation through the shared engine event stream."""
        from openai_codex.generated.v2_all import ThreadGoalGetResponse, ThreadGoalStatus

        raw = client._client
        if action in {"status", "pause", "clear"}:
            if action == "clear":
                await raw.thread_goal_clear(thread.id)
                await event_queue.put(InternalEvent(
                    type="goal_update", data={"status": "cleared"},
                ))
                return
            if action == "pause":
                response = await raw.pause_goal(thread.id)
            else:
                response = await raw.request(
                    "thread/goal/get", {"threadId": thread.id},
                    response_model=ThreadGoalGetResponse,
                )
            goal = getattr(response, "goal", None)
            await event_queue.put(InternalEvent(type="goal_update", data=(
                self._goal_data(goal) if goal is not None else {"status": "cleared"}
            )))
            return

        if action == "start":
            if not model:
                raise RuntimeError("Codex 目标模式需要明确的模型")
            goal_state = raw.register_goal_operation(thread.id)
            started_turn_id: str | None = None
            try:
                # An automatic goal continuation can inherit a persisted Plan
                # mode. Start the first turn explicitly in Default mode, then
                # attach the goal to that running turn. Later turns remain native.
                await raw.thread_goal_clear(thread.id)
                goal_state.activate_turn_routing()
                started = await raw.turn_start(thread.id, objective, params={
                    "collaborationMode": {
                        "mode": "default",
                        "settings": {
                            "model": model,
                            "reasoning_effort": reasoning_effort,
                            "developer_instructions": None,
                        },
                    },
                })
                started_turn_id = str(started.turn.id)
                await raw.thread_goal_set(
                    thread.id, objective=objective, status=ThreadGoalStatus.active,
                )
            except BaseException:
                if started_turn_id is not None:
                    try:
                        await raw.turn_interrupt(thread.id, started_turn_id)
                    except Exception:
                        logger.warning("Failed to interrupt orphaned Codex goal turn", exc_info=True)
                raw.unregister_goal_operation(goal_state)
                raise
        elif action == "resume":
            goal_state = raw.register_goal_operation(thread.id)
            try:
                goal_state.activate_turn_routing()
                await raw.thread_goal_set(thread.id, status=ThreadGoalStatus.active)
                started = await asyncio.to_thread(goal_state.wait_for_start, 30)
                if started is None:
                    raise RuntimeError("等待 Codex 目标恢复超时")
            except BaseException:
                raw.unregister_goal_operation(goal_state)
                raise
        else:
            raise ValueError(f"Unsupported goal action: {action}")

        self._goal_state = goal_state
        seen_running = False
        try:
            while True:
                notification = await raw.next_goal_notification(goal_state)
                for event in self._map_notification(notification, state):
                    if event.type == "status":
                        status = str(event.data.get("status") or "")
                        if status == "running":
                            if seen_running:
                                continue
                            seen_running = True
                        elif status in {"done", "failed", "cancelled"}:
                            # Physical turn completion is not goal completion.
                            continue
                    await event_queue.put(event)
                if goal_state.is_finished():
                    break
            await event_queue.put(InternalEvent(type="status", data={"status": "done"}))
        except asyncio.CancelledError:
            await raw.cancel_goal_operation(goal_state)
            await event_queue.put(InternalEvent(
                type="goal_update", data={"objective": objective, "status": "paused"},
            ))
            raise
        finally:
            raw.unregister_goal_operation(goal_state)
            self._goal_state = None

    @staticmethod
    async def _start_collaboration_turn(
        client: Any,
        thread: Any,
        prompt: str,
        *,
        model: str | None,
        reasoning_effort: str | None,
        plan_mode: bool,
        turn_handle_type: Any,
    ) -> Any:
        """Start a native Codex collaboration-mode turn.

        The app-server protocol exposes ``turn/start.collaborationMode``, but
        current openai-codex releases still omit it from ``AsyncThread.turn``.
        Prefer the public argument once a future SDK adds it; until then use
        the SDK's raw turn-start seam while preserving its early subscription.
        """
        if not model:
            raise RuntimeError("Codex SDK 原生计划模式需要明确的模型")
        mode = {
            "mode": "plan" if plan_mode else "default",
            "settings": {
                "model": model,
                "reasoning_effort": reasoning_effort,
                "developer_instructions": None,
            },
        }
        try:
            public_parameters = inspect.signature(thread.turn).parameters
        except (TypeError, ValueError):
            public_parameters = {}
        if "collaboration_mode" in public_parameters:
            return await thread.turn(
                prompt,
                model=model,
                collaboration_mode=mode,
            )

        async_client = getattr(client, "_client", None)
        if async_client is None:
            raise RuntimeError("当前 openai-codex SDK 不支持原生计划模式")
        params = {"collaborationMode": mode}
        start_with_subscription = getattr(async_client, "_start_turn", None)
        if callable(start_with_subscription):
            started, subscription = await start_with_subscription(
                thread.id,
                prompt,
                params=params,
                for_handle=True,
            )
            return turn_handle_type(
                client,
                thread.id,
                str(started.turn.id),
                _subscription=subscription,
            )

        start_turn = getattr(async_client, "turn_start", None)
        if not callable(start_turn):
            raise RuntimeError("当前 openai-codex SDK 不支持原生计划模式")
        started = await start_turn(thread.id, prompt, params=params)
        return turn_handle_type(client, thread.id, str(started.turn.id))

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
        runtime_decision = self.runtime_permission_decision()
        if runtime_decision is not None:
            return runtime_decision
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
    def supports_live_step_message(self) -> bool:
        return True

    @property
    def supports_thinking_effort(self) -> bool:
        """``config.model_reasoning_effort`` supports a per-turn override."""
        return True

    @property
    def supports_plan_mode(self) -> bool:
        """Codex app-server accepts native ``collaborationMode`` turns."""
        return True

    @property
    def supports_goal_mode(self) -> bool:
        """Codex app-server persists goals and automatically continues turns."""
        return True

    # --- ACP 会话 / 审批契约（非 ACP 引擎：用自己的传输实现等价语义） ---

    #: spawn 实际产出的 ACP 词汇事件（声明 = 实际；无原生来源不合成）。
    acp_events: frozenset[str] = frozenset({
        "subagent",
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
        "acp_raw",
    })

    @property
    def supports_sessions(self) -> bool:
        """SDK 的 thread_resume 原生支持按 thread_id 恢复会话。"""
        return True

    @property
    def supports_session_fork(self) -> bool:
        """The official SDK exposes ``thread_fork`` as a native primitive."""
        return True

    async def fork_session(
        self,
        session_id: str,
        cwd: str,
        *,
        fork_point: str | None = None,
        model: str | None = None,
        provider_id: str | None = None,
    ) -> str | None:
        """Fork a persisted Codex thread and return the new thread id."""
        if not session_id:
            return None
        from openai_codex import AsyncCodex, CodexConfig

        override = self.get_binary_override()
        provider_runtime = self.resolve_provider_runtime(
            provider_id=provider_id or "",
            model=model,
        )
        client = AsyncCodex(config=CodexConfig(
            codex_bin=override or None,
            cwd=cwd or None,
            config_overrides=provider_runtime.engine_config,
            env=(provider_runtime.child_env() if provider_runtime.provider_id else None),
        ))
        try:
            thread = await client.thread_fork(
                session_id,
                cwd=cwd or None,
                model=provider_runtime.model or None,
            )
            forked_id = str(thread.id)
            return forked_id if forked_id and forked_id != session_id else None
        finally:
            close = getattr(client, "close", None)
            if callable(close):
                await close()

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
        return workstep_input_commands(goal=True)
