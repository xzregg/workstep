"""QoderSDKEngine — Qoder via the official ``qoder-agent-sdk`` Python package."""

import asyncio
import importlib.metadata
import logging
import os
from pathlib import Path
import re
import shutil
from typing import Any, AsyncIterator, Mapping

from engines.base import BaseLLMEngine, EngineModel
from engines.events import InternalEvent, compacted_event
from engines.schema import EngineConfigField, EngineConfigOption, EngineImage
from services.config import QODER_PERMISSION_MODES, config_store

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


class QoderSDKEngine(BaseLLMEngine):
    """Qoder driven by the official ``qoder-agent-sdk`` Python package.

    The SDK launches the ``qodercli`` binary as a child process (stream-json
    protocol) — no shell wrapper, no ACP bridge. The SDK wheel bundles a
    platform-matched ``qodercli`` runtime, so no separate CLI install is
    required. This adapter drives the SDK's async ``query()`` API and maps its
    messages to internal events.

    Authentication priority: stored PAT → ``QODER_PERSONAL_ACCESS_TOKEN`` env
    → local ``qodercli`` login (``qodercli_auth()``).
    """

    ENGINE_ID = "qoder_sdk"

    _live_message_wait_seconds: float = 1.5

    def __init__(self):
        self._running = False
        self._query_task: asyncio.Task | None = None

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

    @staticmethod
    def is_configured() -> bool:
        # Auth may come from stored PAT, env, or the local qodercli login;
        # the SDK raises a clear auth error when none is available.
        return True

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

        config_store.set_qoder_sdk_config(
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
        return type(block).__name__.replace("Block", "").lower()

    def _map_message(
        self,
        msg: Any,
        state: dict[str, Any] | None = None,
    ) -> list[InternalEvent]:
        """Map one SDK message to zero or more InternalEvents.

        ``state`` tracks whether text/thinking has already been streamed via
        ``StreamEvent`` so the final ``AssistantMessage`` does not duplicate it.
        """
        state = state if state is not None else {
            "emitted_text": False,
            "emitted_thinking": False,
        }
        events: list[InternalEvent] = []
        mtype = self._msg_type(msg)

        if mtype == "system":
            subtype = getattr(msg, "subtype", "") or ""
            if subtype == "init":
                events.append(
                    InternalEvent(type="status", data={"status": "initializing"})
                )
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
            event = getattr(msg, "event", {}) or {}
            if event.get("type") != "content_block_delta":
                return events
            delta = event.get("delta") or {}
            delta_type = delta.get("type", "")
            if delta_type == "text_delta":
                text = delta.get("text", "")
                if text:
                    state["emitted_text"] = True
                    events.append(
                        InternalEvent(type="text_delta", data={"delta": text})
                    )
            elif delta_type == "thinking_delta":
                thinking = delta.get("thinking", "")
                if thinking:
                    state["emitted_thinking"] = True
                    events.append(
                        InternalEvent(
                            type="thinking_delta", data={"delta": thinking}
                        )
                    )
            return events

        if mtype == "assistant":
            for block in getattr(msg, "content", []) or []:
                block_type = self._block_type(block)
                if block_type == "text":
                    text = getattr(block, "text", "") or ""
                    if text and not state["emitted_text"]:
                        state["emitted_text"] = True
                        events.append(
                            InternalEvent(type="text_delta", data={"delta": text})
                        )
                elif block_type == "thinking":
                    thinking = getattr(block, "thinking", "") or ""
                    if thinking and not state["emitted_thinking"]:
                        state["emitted_thinking"] = True
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
            for block in getattr(msg, "content", []) or []:
                if self._block_type(block) == "tool_result":
                    content = getattr(block, "content", "") or ""
                    if isinstance(content, list):
                        content = "\n".join(str(part) for part in content if part)
                    events.append(
                        InternalEvent(type="tool_result", data={
                            "tool_use_id": getattr(block, "tool_use_id", "") or "",
                            "content": content,
                            "is_error": bool(getattr(block, "is_error", False)),
                        })
                    )
            return events

        if mtype == "result":
            if not state["emitted_text"]:
                result_text = getattr(msg, "result", None) or ""
                if str(result_text).strip():
                    state["emitted_text"] = True
                    events.append(
                        InternalEvent(type="text_delta", data={"delta": str(result_text)})
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
                events.append(InternalEvent(type="usage", data=usage_data))
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
    ) -> AsyncIterator[InternalEvent]:
        if not self._sdk_available():
            yield InternalEvent(
                type="error", data={"message": "qoder-agent-sdk 未安装"}
            )
            return
        binary = self.resolve_binary()
        if not binary:
            yield InternalEvent(
                type="error", data={"message": "qodercli binary not found"}
            )
            return
        try:
            from qoder_agent_sdk import (
                QoderAgentOptions,
                access_token,
                access_token_from_env,
                qodercli_auth,
                query as sdk_query,
            )
        except Exception as exc:
            yield InternalEvent(
                type="error",
                data={"message": f"qoder-agent-sdk 未安装：{exc}"},
            )
            return

        config = config_store.get_qoder_sdk_config()
        token = str(config.get("personal_access_token") or "").strip()
        if token:
            auth = access_token(token)
        elif os.environ.get("QODER_PERSONAL_ACCESS_TOKEN"):
            auth = access_token_from_env()
        else:
            auth = qodercli_auth()

        options = QoderAgentOptions(
            auth=auth,
            cwd=cwd,
            cli_path=binary,
            model=model or config["model"] or None,
            permission_mode=config["permission_mode"] or "default",
            include_partial_messages=bool(config["include_partial_messages"]),
        )
        if live_message_queue is not None:
            options.continue_conversation = True
        if add_dirs:
            options.add_dirs = list(add_dirs)
        if session_id:
            options.session_id = session_id
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

        event_queue: asyncio.Queue[InternalEvent | None] = asyncio.Queue()
        state: dict[str, Any] = {"emitted_text": False, "emitted_thinking": False}

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
                logger.exception("Qoder Agent SDK query error")
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
            logger.exception("QoderSDKEngine spawn error")
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
        logger.warning("inject_response is not supported by QoderSDKEngine")

    @property
    def supports_resume(self) -> bool:
        return False

    @property
    def supports_interactive(self) -> bool:
        return True  # continue_conversation accepts ordinary user messages mid-run

    @property
    def supports_live_stage_message(self) -> bool:
        return True

    def build_resume_params(self, session_id: str) -> dict:
        return {}
