"""QoderSDKEngine — Qoder via the official ``qoder-agent-sdk`` Python package."""

import asyncio
import importlib.metadata
import logging
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
import uuid
from typing import Any, AsyncIterator, Mapping

from engines.core.acp_base import AcpEngineBase
from engines.core.base import (
    EngineInstallResult,
    EngineModel,
    install_python_package,
    sdk_turn_watchdog,
)

from engines.core.plans import subagent_event_from_message, route_subagent_message
from engines.core.events import (
    InternalEvent,
    compacted_event,
    tool_call_event,
    tool_call_update_event,
    usage_update_event,
)
from engines.core.interactions import elicitation_request
from engines.core.schema import EngineConfigField, EngineConfigOption, EngineImage
from services.config import QODER_PERMISSION_MODES, config_store
from services.chat_permissions import map_permission_overrides

logger = logging.getLogger(__name__)

# Qoder 官方模型别名；账号实际可用的模型以
# ``QoderSDKClient.get_available_models()`` 实时返回为准。
QODER_MODEL_ALIASES: tuple[tuple[str, str], ...] = (
    ("auto", "Auto（按任务自动选择）"),
    ("performance", "Performance（高性能）"),
    ("efficient", "Efficient（均衡）"),
    ("lite", "Lite（轻量快速）"),
    ("ultimate", "Ultimate（最强推理）"),
)


class QoderSDKEngine(AcpEngineBase):
    """Qoder driven by the official ``qoder-agent-sdk`` Python package.

    The SDK launches the ``qodercli`` binary as a child process (stream-json
    protocol) — no shell wrapper, no ACP bridge. The SDK wheel bundles a
    platform-matched ``qodercli`` runtime, so no separate CLI install is
    required. This adapter drives the SDK's async ``query()`` API and maps its
    messages to internal events.

    Authentication priority: stored PAT → ``QODER_PERSONAL_ACCESS_TOKEN`` env
    → local ``qodercli`` login (``qodercli_auth()``).
    """

    async def set_permission_mode(self, mode: str) -> None:
        await super().set_permission_mode(mode)
        client = self._client
        if client is None:
            return
        mapped = (
            map_permission_overrides(self.ENGINE_ID, mode).get("permission_mode", "")
            if mode
            else str(
                (await asyncio.to_thread(config_store.get_qoder_sdk_config))
                .get("permission_mode")
                or "default"
            )
        )
        await client.set_permission_mode(mapped)

    ENGINE_ID = "qoder_sdk"
    UPDATE_PACKAGE = "qoder-agent-sdk"

    def __init__(self):
        super().__init__()
        self._running = False
        self._receive_task: asyncio.Task | None = None
        self._client = None

    # --- Engine discovery ---

    @staticmethod
    def _sdk_available() -> bool:
        try:
            import qoder_agent_sdk  # noqa: F401
            return True
        except Exception:
            return False

    @staticmethod
    def is_installed() -> bool:
        if not QoderSDKEngine._sdk_available():
            return False
        return QoderSDKEngine.resolve_binary() is not None

    _STATUS_TTL = 300.0
    _status_cache: tuple[float, bool] | None = None

    @classmethod
    def is_configured(cls) -> bool:
        config = config_store.get_qoder_sdk_config()
        if str(config.get("personal_access_token") or "").strip():
            return True
        if str(os.environ.get("QODER_PERSONAL_ACCESS_TOKEN") or "").strip():
            return True
        binary = cls.resolve_binary()
        if not binary:
            return False
        now = time.monotonic()
        if cls._status_cache is not None and now - cls._status_cache[0] < cls._STATUS_TTL:
            return cls._status_cache[1]
        try:
            result = subprocess.run(
                [binary, "status"],
                capture_output=True,
                text=True,
                timeout=5,
            )
            ok = result.returncode == 0 and "not logged in" not in (
                f"{getattr(result, 'stdout', '')}\n{getattr(result, 'stderr', '')}"
            ).lower()
        except (OSError, subprocess.SubprocessError):
            ok = False
        cls._status_cache = (now, ok)
        return ok

    @staticmethod
    def get_version() -> str | None:
        try:
            return importlib.metadata.version("qoder-agent-sdk")
        except importlib.metadata.PackageNotFoundError:
            return None

    @staticmethod
    def resolve_binary() -> str | None:
        """Resolve qodercli binary: override → QODERCLI_PATH → SDK bundled → PATH.

        The SDK wheel ships a platform-matched ``_bundled/qodercli`` binary,
        so no separate qodercli install is required (SDK lookup order mirrors
        ``QoderAgentOptions.cli_path`` → ``QODERCLI_PATH`` → bundled → PATH).
        """
        override = QoderSDKEngine.get_binary_override()
        if override is not None:
            return override if os.path.isfile(override) else None
        env_bin = os.environ.get("QODERCLI_PATH")
        if env_bin and os.path.isfile(env_bin):
            return env_bin
        try:
            import qoder_agent_sdk
            bundled = Path(qoder_agent_sdk.__file__).parent / "_bundled" / (
                "qodercli.exe" if os.name == "nt" else "qodercli"
            )
            if bundled.is_file():
                return str(bundled)
        except Exception:
            pass
        return shutil.which("qodercli")

    @staticmethod
    def install_command() -> str:
        return "pip install qoder-agent-sdk"

    @staticmethod
    def third_party_terms_url() -> str:
        return "https://qoder.com/product-service"

    @staticmethod
    def requires_third_party_terms_acceptance() -> bool:
        return True

    async def install(self) -> EngineInstallResult:
        """Install the official ``qoder-agent-sdk`` Python package."""
        return await install_python_package("qoder-agent-sdk")

    # --- Config schema (backend-driven settings form) ---

    @classmethod
    def config_schema(cls) -> list[EngineConfigField]:
        return [
            EngineConfigField(
                key="personal_access_token",
                label="Personal Access Token",
                type="password",
                placeholder="qoder.com/account/integrations 生成的 PAT",
                sensitive=True,
                help="留空则读取环境变量 QODER_PERSONAL_ACCESS_TOKEN；"
                "都为空时复用本机 qodercli 登录。",
            ),
            EngineConfigField(
                key="permission_mode",
                label="权限模式",
                type="select",
                options=tuple(
                    EngineConfigOption(mode, mode)
                    for mode in sorted(QODER_PERMISSION_MODES)
                ),
                default="default",
                required=True,
                confirm_values=("bypassPermissions",),
                help="bypassPermissions 跳过全部权限检查，需要明确确认。",
            ),
            EngineConfigField(
                key="model",
                label="模型",
                type="text",
                placeholder="如 auto / performance，留空用账号默认",
                help="Qoder 模型别名，也可在阶段/任务里单独指定。",
            ),
            EngineConfigField(
                key="allowed_tools",
                label="工具白名单",
                type="textarea",
                placeholder="如 Read, Write, Edit, Glob, Grep, Bash",
                help="逗号分隔；白名单内工具自动授权，留空使用 SDK 默认。",
            ),
            EngineConfigField(
                key="max_turns",
                label="最大轮数",
                type="number",
                placeholder="留空为 SDK 默认",
                help="Agent 最多执行的工具调用轮数。",
            ),
            EngineConfigField(
                key="include_partial_messages",
                label="流式输出",
                type="checkbox",
                default=True,
                help="开启后实时推送文本/思考增量（打字机效果）。",
            ),
        ]

    def get_config_values(self) -> dict:
        config = config_store.get_qoder_sdk_config()
        return {
            "personal_access_token": "",  # masked
            "permission_mode": config["permission_mode"] or "default",
            "model": config["model"] or "",
            "allowed_tools": config["allowed_tools"] or "",
            "max_turns": config["max_turns"] or "",
            "include_partial_messages": (
                "true" if config["include_partial_messages"] else "false"
            ),
        }

    def get_config_secrets(self) -> dict[str, bool]:
        config = config_store.get_qoder_sdk_config()
        return {"personal_access_token": bool(config["personal_access_token"])}

    def reveal_config_value(self, key: str) -> str | None:
        if key == "personal_access_token":
            return config_store.get_qoder_sdk_config().get(
                "personal_access_token"
            ) or None
        return None

    async def save_config_values(
        self,
        values: dict,
        clear: dict[str, bool] | None = None,
        confirmed: dict[str, bool] | None = None,
    ) -> None:
        clear = clear or {}
        confirmed = confirmed or {}
        mode = str(values.get("permission_mode") or "default").strip()
        if mode not in QODER_PERMISSION_MODES:
            raise ValueError("不支持的权限模式")
        if mode == "bypassPermissions" and not confirmed.get("permission_mode"):
            raise ValueError("bypassPermissions 需要明确确认风险")

        token: str | None = None
        if clear.get("personal_access_token"):
            token = ""
        else:
            new_token = str(values.get("personal_access_token") or "").strip()
            if new_token:
                token = new_token

        max_turns = str(values.get("max_turns") or "").strip()
        if max_turns:
            try:
                turns = int(max_turns)
            except ValueError:
                raise ValueError("最大轮数必须是正整数")
            if turns <= 0:
                raise ValueError("最大轮数必须是正整数")

        include_partial = str(
            values.get("include_partial_messages") or ""
        ).lower() in {"true", "1", "on"}

        await asyncio.to_thread(
            config_store.set_qoder_sdk_config,
            personal_access_token=token,
            permission_mode=mode,
            model=str(values.get("model") or "").strip(),
            allowed_tools=str(values.get("allowed_tools") or "").strip(),
            max_turns=max_turns,
            include_partial_messages=include_partial,
        )

    async def list_models(self, cwd: str) -> list[EngineModel]:
        return [
            EngineModel(model_id, label)
            for model_id, label in QODER_MODEL_ALIASES
        ]

    # --- Execution ---

    @staticmethod
    def _normalize_qoder_usage(raw: Mapping[str, Any]) -> dict[str, Any]:
        """Normalize the SDK's camelCase ModelUsage to WorkStep's event schema."""

        def num(*keys: str) -> int:
            for key in keys:
                value = raw.get(key)
                if isinstance(value, (int, float)) and not isinstance(value, bool):
                    return int(value)
            return 0

        input_tokens = num("inputTokens", "input_tokens")
        output_tokens = num("outputTokens", "output_tokens")
        usage_data: dict[str, Any] = {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cache_creation_input_tokens": num(
                "cacheCreationInputTokens", "cache_creation_input_tokens"
            ),
            "cache_read_input_tokens": num(
                "cacheReadInputTokens", "cache_read_input_tokens"
            ),
            "total_tokens": num("totalTokens", "total_tokens")
            or input_tokens + output_tokens,
        }
        cost = raw.get("costUSD")
        if isinstance(cost, (int, float)) and not isinstance(cost, bool):
            usage_data["cost"] = {
                "amount": round(float(cost), 6),
                "currency": "USD",
            }
        credits = raw.get("credits")
        if isinstance(credits, (int, float)) and not isinstance(credits, bool):
            usage_data["credits"] = float(credits)
        return usage_data

    @staticmethod
    def _msg_type(msg: Any) -> str:
        """Normalize a SDK message to ``system`` / ``stream`` / ``assistant`` /
        ``user`` / ``result``.

        Prefers an explicit ``type`` attribute (``str`` or ``StrEnum``), then
        falls back to the class name — works with real dataclasses and
        lightweight fakes."""
        raw = getattr(msg, "type", "")
        value = getattr(raw, "value", None)
        if value is not None:
            return str(value).lower()
        if raw:
            return str(raw).lower()
        name = type(msg).__name__
        for suffix in ("Message", "Event"):
            if name.endswith(suffix):
                name = name[: -len(suffix)]
                break
        parts = [part for part in re.split(r"(?<!^)(?=[A-Z])", name) if part]
        return parts[-1].lower() if parts else name.lower()

    @staticmethod
    def _block_type(block: Any) -> str:
        raw = getattr(block, "type", "")
        value = getattr(raw, "value", None)
        if value is not None:
            return str(value).lower()
        if raw:
            return str(raw).lower()
        name = type(block).__name__.replace("Block", "")
        parts = [part for part in re.split(r"(?<!^)(?=[A-Z])", name) if part]
        return "_".join(part.lower() for part in parts) if parts else name.lower()

    def _map_message(self, msg, state=None):
        state = state if state is not None else {}
        return route_subagent_message(msg, state, self._map_message_content)

    def _map_message_content(
        self,
        msg: Any,
        state: dict[str, Any] | None = None,
    ) -> list[InternalEvent]:
        """Map one SDK message to zero or more InternalEvents.

        ``state`` tracks whether text/thinking has already been streamed via
        ``StreamEvent`` so the final ``AssistantMessage`` does not duplicate it.
        """
        state = state if state is not None else {}
        state.setdefault("emitted_text", False)
        state.setdefault("emitted_thinking", False)
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
                data = getattr(msg, "data", {}) or {}
                session_id = data.get("session_id") if isinstance(data, Mapping) else None
                if session_id and not state["session_started"]:
                    state["session_started"] = True
                    events.append(InternalEvent(
                        type="session_started",
                        data={"session_id": str(session_id)},
                    ))
            elif subtype == "error":
                data = getattr(msg, "data", {}) or {}
                message = (
                    data.get("error")
                    or data.get("message")
                    or "Qoder 启动失败"
                )
                events.append(
                    InternalEvent(type="error", data={"message": str(message)})
                )
            elif "compact" in subtype.lower():
                data = getattr(msg, "data", {}) or {}
                if isinstance(data, Mapping):
                    summary = (
                        data.get("compact_summary")
                        or data.get("summary")
                    )
                    events.append(compacted_event(str(summary) if summary else None))
                else:
                    events.append(compacted_event())
            return events

        if mtype == "stream":
            session_id = getattr(msg, "session_id", None)
            if session_id and not state["session_started"]:
                state["session_started"] = True
                events.append(InternalEvent(
                    type="session_started", data={"session_id": str(session_id)}
                ))
            event = getattr(msg, "event", {}) or {}
            if event.get("type") != "content_block_delta":
                return events
            delta = event.get("delta") or {}
            delta_type = delta.get("type", "")
            if delta_type == "text_delta":
                text = delta.get("text", "")
                if text:
                    state["emitted_text"] = True
                    state["streamed_text"] = True
                    events.append(
                        InternalEvent(
                            type="agent_message_chunk",
                            data={"content": {"text": text}},
                        )
                    )
            elif delta_type == "thinking_delta":
                thinking = delta.get("thinking", "")
                if thinking:
                    state["emitted_thinking"] = True
                    state["streamed_thinking"] = True
                    events.append(
                        InternalEvent(
                            type="agent_thought_chunk",
                            data={"content": {"text": thinking}},
                        )
                    )
            return events

        if mtype == "assistant":
            for block in getattr(msg, "content", []) or []:
                block_type = self._block_type(block)
                if block_type == "text":
                    text = getattr(block, "text", "") or ""
                    if text and not state["streamed_text"]:
                        state["emitted_text"] = True
                        events.append(
                            InternalEvent(
                                type="agent_message_chunk",
                                data={"content": {"text": text}},
                            )
                        )
                elif block_type == "thinking":
                    thinking = getattr(block, "thinking", "") or ""
                    if thinking and not state["streamed_thinking"]:
                        state["emitted_thinking"] = True
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
            for block in getattr(msg, "content", []) or []:
                if self._block_type(block) == "tool_result":
                    content = getattr(block, "content", "") or ""
                    if isinstance(content, list):
                        content = "\n".join(str(part) for part in content if part)
                    events.append(tool_call_update_event(
                        tool_call_id=str(getattr(block, "tool_use_id", "") or ""),
                        status="failed" if bool(getattr(block, "is_error", False)) else "completed",
                        raw_output=content,
                    ))
            return events

        if mtype == "result":
            if not state["emitted_text"]:
                result_text = getattr(msg, "result", None) or ""
                if str(result_text).strip():
                    state["emitted_text"] = True
                    events.append(
                        InternalEvent(
                            type="agent_message_chunk",
                            data={"content": {"text": str(result_text)}},
                        )
                    )
            usage = getattr(msg, "usage", None)
            if usage is not None:
                raw = usage if isinstance(usage, Mapping) else {}
                usage_data = self._normalize_qoder_usage(raw)
                cost_usd = getattr(msg, "total_cost_usd", None)
                if cost_usd is None:
                    cost_usd = raw.get("costUSD")
                if (
                    cost_usd is not None
                    and isinstance(cost_usd, (int, float))
                    and not isinstance(cost_usd, bool)
                ):
                    usage_data["cost"] = {
                        "amount": round(float(cost_usd), 6),
                        "currency": "USD",
                    }
                credits = getattr(msg, "total_credits", None)
                if (
                    credits is not None
                    and isinstance(credits, (int, float))
                    and not isinstance(credits, bool)
                ):
                    usage_data["credits"] = float(credits)
                session_id = getattr(msg, "session_id", None)
                if session_id:
                    usage_data["session_id"] = str(session_id)
                events.append(usage_update_event(usage_data))
            is_error = bool(getattr(msg, "is_error", False))
            subtype = getattr(msg, "subtype", "") or ""
            if is_error or (subtype and subtype != "success"):
                errors = getattr(msg, "errors", None) or []
                message = str(errors[0]) if errors else (subtype or "Qoder 执行失败")
                events.append(
                    InternalEvent(type="error", data={"message": message})
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
        config_overrides: dict | None = None,
    ) -> AsyncIterator[InternalEvent]:
        if not self._sdk_available():
            yield InternalEvent(
                type="error", data={"message": "qoder-agent-sdk 未安装"}
            )
            return
        binary = await asyncio.to_thread(self.resolve_binary)
        if not binary:
            yield InternalEvent(
                type="error", data={"message": "qodercli binary not found"}
            )
            return
        if not await asyncio.to_thread(self.is_configured):
            yield InternalEvent(type="error", data={
                "message": (
                    "Qoder 尚未登录：请运行 qodercli login，或在设置中配置 "
                    "Personal Access Token"
                ),
            })
            return
        try:
            from qoder_agent_sdk import (
                PermissionResultAllow,
                PermissionResultDeny,
                QoderAgentOptions,
                QoderSDKClient,
                access_token,
                access_token_from_env,
                qodercli_auth,
            )
        except Exception as exc:
            yield InternalEvent(
                type="error",
                data={"message": f"qoder-agent-sdk 未安装：{exc}"},
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
                session_id=session_id or "qoder-agent-sdk",
            )
            if allowed:
                return PermissionResultAllow(updated_input=updated_input)
            return PermissionResultDeny(message="用户拒绝了该操作")

        async def on_elicitation(request):
            request_data = request if isinstance(request, dict) else {}
            if request_data.get("mode", "form") != "form":
                return {"action": "decline"}
            interaction_id = str(
                request_data.get("elicitationId") or uuid.uuid4()
            )
            event = elicitation_request(
                interaction_id=interaction_id,
                message=str(request_data.get("message") or "需要你的输入"),
                requested_schema=request_data.get("requestedSchema") or {
                    "type": "object", "properties": {},
                },
                session_id=session_id or "qoder-agent-sdk",
            )
            return await self.request_interaction(event, event_queue.put)

        config = self.merge_config_overrides(
            await asyncio.to_thread(config_store.get_qoder_sdk_config),
            config_overrides,
        )
        token = str(config.get("personal_access_token") or "").strip()
        if token:
            auth = access_token(token)
        elif os.environ.get("QODER_PERSONAL_ACCESS_TOKEN"):
            auth = access_token_from_env()
        else:
            auth = qodercli_auth()

        from services.skill_runtime import prepare_qoder_plugin

        plugin_dir, skill_names = await asyncio.to_thread(
            lambda: prepare_qoder_plugin(self.project_skills(cwd))
        )
        options = QoderAgentOptions(
            auth=auth,
            cwd=cwd,
            cli_path=binary,
            model=model or config["model"] or None,
            permission_mode=config["permission_mode"] or "default",
            include_partial_messages=bool(config["include_partial_messages"]),
            can_use_tool=can_use_tool,
            on_elicitation=on_elicitation,
            plugins=[{"type": "local", "path": str(plugin_dir)}],
            skills=skill_names,
            setting_sources=[],
        )
        if add_dirs:
            options.add_dirs = list(add_dirs)
        if session_id:
            options.resume = session_id
        if config["permission_mode"] == "bypassPermissions":
            options.allow_dangerously_skip_permissions = True
        allowed = str(config.get("allowed_tools") or "").strip()
        if allowed:
            options.allowed_tools = [
                item.strip() for item in allowed.split(",") if item.strip()
            ]
        max_turns = str(config.get("max_turns") or "").strip()
        if max_turns:
            try:
                options.max_turns = int(max_turns)
            except ValueError:
                options.max_turns = None

        logger.info(
            "QoderSDKEngine spawn: binary=%s cwd=%s model=%s",
            binary, cwd, options.model,
        )

        self._running = True
        yield InternalEvent(type="status", data={"status": "running"})

        state: dict[str, Any] = {
            "emitted_text": False,
            "emitted_thinking": False,
            "streamed_text": False,
            "streamed_thinking": False,
            "session_started": False,
        }

        client = QoderSDKClient(options=options)
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
                logger.exception("Qoder Agent SDK query error")
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
            logger.exception("QoderSDKEngine spawn error")
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
        logger.warning("inject_response is not supported by QoderSDKEngine")

    @property
    def supports_resume(self) -> bool:
        return True

    @property
    def supports_interactive(self) -> bool:
        return True  # QoderSDKClient 双向流式：运行中 query() 注入 + can_use_tool

    @property
    def supports_live_stage_message(self) -> bool:
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
        """QoderAgentOptions.resume 原生支持按 session_id 恢复会话。"""
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
        logger.info("QoderSDK create_session: not supported without a prompt")
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
        """配置在 spawn 时从 config_store 读取（permission_mode / model / max_turns）；
        运行中修改无原生入口。"""
        return None

    async def reset_options(self, session_id: str | None = None) -> None:
        """无原生 reset；新会话从全局配置重新读取。"""
        return None

    def build_resume_params(self, session_id: str) -> dict:
        return {"session_id": session_id}
