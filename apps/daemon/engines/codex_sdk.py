"""CodexSDKEngine — Codex via the official ``openai-codex`` Python SDK."""

from engines.core.plans import codex_subagent_events

import asyncio
import importlib.metadata
import json
import logging
import os
import re
import uuid
from typing import Any, AsyncIterator

from engines.core.acp_base import AcpEngineBase
from engines.core.packages import RuntimePackage
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
    extract_reasoning_text,
    tool_call_event,
    tool_call_update_event,
    usage_update_event,
)
from engines.core.interactions import permission_request, permission_signature
from engines.core.input_items import workstep_input_commands
from engines.core.plans import plan_event
from engines.core.schema import EngineConfigField, EngineConfigOption, EngineImage
from engines.core.tool_inputs import file_change_input
from engines.codex_events import codex_raw_event
from engines.codex_visualize import CodexVisualizeStream
from services import providers as provider_service
from services.config import (
    CODEX_REASONING_EFFORTS,
    CODEX_SANDBOX_MODES,
    CODEX_SDK_APPROVAL_MODES,
    config_store,
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


def _is_codex_sdk_terminal_event(event: InternalEvent) -> bool:
    if event.type in {"usage_update", "error"}:
        return True
    return (
        event.type == "status"
        and event.data.get("status") in {"done", "cancelled", "failed"}
    )


class CodexSDKEngine(AcpEngineBase):
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

    # --- Notification mapping ---

    @staticmethod
    def _notification_method(notification: Any) -> str:
        return str(getattr(notification, "method", "") or "")

    @staticmethod
    def _visualize_stream(state: dict[str, Any], item_id: str) -> CodexVisualizeStream:
        item_key = item_id or "__default__"
        streams = state.setdefault("visualize_streams", {})
        return streams.setdefault(item_key, CodexVisualizeStream())

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
            name = "EditFile"
            kind = "edit"
            tool_input = file_change_input(
                cls._plain(getattr(root, "changes", []) or [])
            )
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
        if rtype != "fileChange":
            kind = "other"
        return tool_call_event(
            tool_call_id=str(getattr(root, "id", "") or ""),
            title=name,
            kind=kind,
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

    def _map_notification(self, notification, state):
        state.setdefault("unphased", UnphasedMessageClassifier())
        raw_events = self._map_notification_content(notification, state)
        payload = getattr(notification, "payload", None)
        root = self._root_of(getattr(payload, "item", None))
        if getattr(root, "type", "") == "collabAgentToolCall":
            raw_events.extend(codex_subagent_events({
                "receiver_thread_ids": getattr(root, "receiver_thread_ids", []),
                "agents_states": self._plain(getattr(root, "agents_states", {})),
            }))
        events: list[InternalEvent] = []
        for event in raw_events:
            events.extend(state["unphased"].offer(
                event,
                terminal=_is_codex_sdk_terminal_event(event),
                split=True,
            ))
            if (
                event.type == "status"
                and event.data.get("status") == "done"
            ):
                events.extend(state["unphased"].flush())
        return events

    def _map_notification_content(
        self,
        notification: Any,
        state: dict[str, Any],
    ) -> list[InternalEvent]:
        """Map one SDK notification to zero or more InternalEvents.

        ``state`` tracks message phases and emitted text per item, and which
        tool IDs already produced a start event. Unidentified text is buffered
        until its item metadata arrives; completed items never duplicate deltas.
        """
        events: list[InternalEvent] = []
        method = self._notification_method(notification)
        payload = getattr(notification, "payload", None)

        if method == "turn/started":
            events.append(InternalEvent(type="status", data={"status": "running"}))

        elif method == "item/agentMessage/delta":
            delta = getattr(payload, "delta", None) or ""
            if delta:
                item_id = str(getattr(payload, "item_id", "") or "")
                items = state.setdefault("message_items", {})
                item = items.setdefault(item_id, {"text": "", "pending": ""})
                if item.get("completed"):
                    return events
                if item_id and (
                    not item.get("started") or not item.get("phase")
                ):
                    item["pending"] += str(delta)
                else:
                    rendered = self._visualize_stream(state, item_id).feed(str(delta))
                    item["text"] += str(delta)
                    if rendered:
                        state["emitted_text"] = True
                        events.append(agent_message_chunk(
                            rendered, phase=item.get("phase"), source_item_id=item_id,
                        ))

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
            if getattr(root, "type", "") == "agentMessage":
                item_id = str(tool_id or "")
                item = state.setdefault("message_items", {}).setdefault(
                    item_id, {"text": "", "pending": ""},
                )
                phase = getattr(root, "phase", None)
                item["started"] = True
                item["phase"] = getattr(phase, "value", phase)
                if item["pending"] and item["phase"]:
                    rendered = self._visualize_stream(state, item_id).feed(item["pending"])
                    if rendered:
                        events.append(agent_message_chunk(
                            rendered, phase=item["phase"], source_item_id=item_id,
                        ))
                    item["text"] += item["pending"]
                    item["pending"] = ""
            if (
                getattr(root, "type", "") in {
                    "commandExecution", "fileChange", "mcpToolCall",
                    "dynamicToolCall", "collabAgentToolCall", "webSearch",
                }
                and tool_id not in state["tool_emitted"]
            ):
                state["tool_emitted"].add(tool_id)
                events.append(self._tool_use_event(root))
            elif getattr(root, "type", "") not in {
                "agentMessage",
                "commandExecution",
                "fileChange",
                "mcpToolCall",
                "dynamicToolCall",
                "collabAgentToolCall",
                "webSearch",
            }:
                events.append(codex_raw_event(method, {
                    "item": self._plain(root),
                    "item_id": tool_id,
                }))

        elif method == "item/completed":
            root = self._root_of(getattr(payload, "item", None))
            if root is None:
                return events
            rtype = getattr(root, "type", "")
            if rtype == "agentMessage":
                text = getattr(root, "text", None) or ""
                item_id = str(getattr(root, "id", "") or "")
                item = state.setdefault("message_items", {}).setdefault(
                    item_id, {"text": "", "pending": ""},
                )
                if item.get("completed"):
                    return events
                phase = getattr(root, "phase", None)
                item["phase"] = getattr(phase, "value", phase) or item.get("phase")
                # Old transports without item IDs retain their legacy deduplication.
                emitted = item["text"]
                remaining = str(text)[len(emitted):] if str(text).startswith(emitted) else ""
                if not text:
                    remaining = item["pending"]
                stream = self._visualize_stream(state, item_id)
                rendered = stream.feed(str(remaining)) if remaining else ""
                rendered += stream.flush()
                if rendered and (item_id or not state.get("emitted_text")):
                    state["emitted_text"] = True
                    message_event = agent_message_chunk(
                        rendered, phase=item.get("phase"), source_item_id=item_id,
                    )
                    events.append(message_event)
                item.update(text=str(text), pending="", completed=True)
            elif rtype == "reasoning":
                text = extract_reasoning_text(getattr(root, "content", None))
                if not text:
                    text = extract_reasoning_text(getattr(root, "summary", None))
                if text and not state.get("emitted_thinking", False):
                    state["emitted_thinking"] = True
                    events.append(
                        InternalEvent(
                            type="agent_thought_chunk",
                            data={"content": {"text": str(text)}},
                        )
                    )
            elif rtype == "plan":
                text = getattr(root, "text", None)
                data: dict[str, Any] = {
                    "id": str(getattr(root, "id", "") or ""),
                    "type": "markdown",
                }
                if text is not None:
                    data["content"] = str(text)
                events.append(InternalEvent(type="plan_update", data=data))
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
            elif rtype == "contextCompaction":
                events.append(compacted_event())
            else:
                events.append(codex_raw_event(method, {
                    "item": self._plain(root),
                    "item_id": getattr(root, "id", None),
                }))

        elif method == "thread/tokenUsage/updated":
            usage = getattr(payload, "token_usage", None)
            source = getattr(usage, "last", None)
            is_context_snapshot = source is not None
            if source is None:
                source = getattr(usage, "total", None)
            if source is not None:
                raw = {
                    "input_tokens": getattr(source, "input_tokens", 0) or 0,
                    "output_tokens": getattr(source, "output_tokens", 0) or 0,
                    "cache_read_input_tokens": getattr(source, "cached_input_tokens", 0) or 0,
                    "total_tokens": getattr(source, "total_tokens", 0) or 0,
                }
                context_window = None
                if is_context_snapshot:
                    context_window = getattr(usage, "model_context_window", None)
                    if context_window is None:
                        context_window = getattr(usage, "modelContextWindow", None)
                usage_event = usage_update_event(raw, size=context_window)
                reasoning = getattr(source, "reasoning_output_tokens", None)
                if isinstance(reasoning, (int, float)):
                    usage_event.data["reasoning_output_tokens"] = int(reasoning)
                events.append(usage_event)

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

        elif method == "item/plan/delta":
            delta = getattr(payload, "delta", None)
            item_id = str(getattr(payload, "item_id", "") or "")
            data: dict[str, Any] = {"id": item_id, "type": "markdown"}
            if delta is not None:
                data["content"] = str(delta)
            events.append(InternalEvent(type="plan_update", data=data))

        elif method in (
            "item/commandExecution/outputDelta",
            "item/fileChange/outputDelta",
        ):
            delta = getattr(payload, "delta", None)
            events.append(tool_call_update_event(
                tool_call_id=str(getattr(payload, "item_id", "") or ""),
                status="in_progress",
                raw_output=str(delta) if delta is not None else None,
            ))

        elif method == "item/fileChange/patchUpdated":
            changes = self._plain(getattr(payload, "changes", None) or [])
            events.append(tool_call_update_event(
                tool_call_id=str(getattr(payload, "item_id", "") or ""),
                status="in_progress",
                raw_output=changes,
            ))

        elif method == "item/commandExecution/terminalInteraction":
            stdin = getattr(payload, "stdin", None)
            events.append(tool_call_update_event(
                tool_call_id=str(getattr(payload, "item_id", "") or ""),
                status="in_progress",
                raw_input=(
                    {"stdin": str(stdin), "process_id": getattr(payload, "process_id", None)}
                    if stdin is not None
                    else None
                ),
            ))

        elif method == "item/mcpToolCall/progress":
            message = getattr(payload, "message", None)
            events.append(tool_call_update_event(
                tool_call_id=str(getattr(payload, "item_id", "") or ""),
                status="in_progress",
                raw_output=str(message) if message is not None else None,
            ))

        elif method == "thread/name/updated":
            name = getattr(payload, "thread_name", None)
            events.append(InternalEvent(
                type="session_info_update",
                data={"title": str(name)} if name else {},
            ))

        elif method == "thread/status/changed":
            status = self._plain(getattr(payload, "status", None))
            if isinstance(status, dict):
                status_name = status.get("type") or status.get("status")
            else:
                status_name = status
            data: dict[str, Any] = {}
            if status_name:
                data["thread_status"] = str(status_name)
            if isinstance(status, dict) and status.get("activeFlags") is not None:
                data["active_flags"] = status.get("activeFlags")
            events.append(codex_raw_event(method, {
                "thread_id": getattr(payload, "thread_id", None),
                **data,
                "raw_status": status,
            }))

        elif method == "thread/settings/updated":
            settings = self._plain(getattr(payload, "thread_settings", None))
            data = {"settings": settings} if settings is not None else {}
            thread_id = getattr(payload, "thread_id", None)
            if thread_id:
                data["thread_id"] = str(thread_id)
            events.append(codex_raw_event(method, data))

        elif method in ("hook/started", "hook/completed"):
            run = self._plain(getattr(payload, "run", None))
            data: dict[str, Any] = {"hook_run": run} if run is not None else {}
            for source, target in (
                ("thread_id", "thread_id"),
                ("turn_id", "turn_id"),
            ):
                value = getattr(payload, source, None)
                if value:
                    data[target] = str(value)
            events.append(codex_raw_event(method, data))

        elif method in (
            "item/autoApprovalReview/started",
            "item/autoApprovalReview/completed",
        ):
            data: dict[str, Any] = {}
            for source, target in (
                ("review_id", "review_id"),
                ("target_item_id", "target_item_id"),
                ("thread_id", "thread_id"),
                ("turn_id", "turn_id"),
                ("action", "action"),
                ("decision_source", "decision_source"),
                ("review", "review"),
                ("started_at_ms", "started_at_ms"),
                ("completed_at_ms", "completed_at_ms"),
            ):
                value = getattr(payload, source, None)
                if value is not None:
                    data[target] = self._plain(value)
            events.append(codex_raw_event(method, data))

        elif method == "turn/diff/updated":
            diff = getattr(payload, "diff", None)
            events.append(codex_raw_event(method, {
                "thread_id": getattr(payload, "thread_id", None),
                "turn_id": getattr(payload, "turn_id", None),
                "diff": str(diff) if diff is not None else "",
            }))

        elif method == "model/verification":
            events.append(codex_raw_event(method, {
                "thread_id": getattr(payload, "thread_id", None),
                "turn_id": getattr(payload, "turn_id", None),
                "verifications": self._plain(getattr(payload, "verifications", None) or []),
            }))

        elif method == "model/safetyBuffering/updated":
            events.append(codex_raw_event(method, {
                "thread_id": getattr(payload, "thread_id", None),
                "turn_id": getattr(payload, "turn_id", None),
                "model": getattr(payload, "model", None),
                "faster_model": getattr(payload, "faster_model", None),
                "reasons": self._plain(getattr(payload, "reasons", None) or []),
                "use_cases": self._plain(getattr(payload, "use_cases", None) or []),
                "show_buffering_ui": getattr(payload, "show_buffering_ui", None),
            }))

        elif method in ("process/outputDelta", "command/exec/outputDelta"):
            events.append(codex_raw_event(method, {
                "process_id": (
                    getattr(payload, "process_id", None)
                    or getattr(payload, "process_handle", None)
                ),
                "stream": self._plain(getattr(payload, "stream", None)),
                "delta_base64": getattr(payload, "delta_base64", None),
                "cap_reached": getattr(payload, "cap_reached", None),
            }))

        elif method == "process/exited":
            events.append(codex_raw_event(method, {
                "process_id": getattr(payload, "process_handle", None),
                "exit_code": getattr(payload, "exit_code", None),
                "stdout": getattr(payload, "stdout", None),
                "stderr": getattr(payload, "stderr", None),
                "stdout_cap_reached": getattr(payload, "stdout_cap_reached", None),
                "stderr_cap_reached": getattr(payload, "stderr_cap_reached", None),
            }))

        elif method in (
            "thread/environment/connected",
            "thread/environment/disconnected",
        ):
            events.append(codex_raw_event(method, {
                "thread_id": getattr(payload, "thread_id", None),
                "environment_id": getattr(payload, "environment_id", None),
            }))

        elif method == "skills/changed":
            events.append(codex_raw_event(method, {}))

        elif method in (
            "warning",
            "guardianWarning",
            "configWarning",
            "deprecationNotice",
            "windows/worldWritableWarning",
        ):
            data: dict[str, Any] = {
                key: self._plain(value)
                for key, value in (
                    ("message", getattr(payload, "message", None)),
                    ("summary", getattr(payload, "summary", None)),
                    ("details", getattr(payload, "details", None)),
                    ("path", getattr(payload, "path", None)),
                    ("thread_id", getattr(payload, "thread_id", None)),
                    ("sample_paths", getattr(payload, "sample_paths", None)),
                    ("failed_scan", getattr(payload, "failed_scan", None)),
                )
                if value is not None
            }
            events.append(codex_raw_event(method, data))

        elif method == "model/rerouted":
            events.append(codex_raw_event(
                method,
                {
                    "from_model": getattr(payload, "from_model", None),
                    "to_model": getattr(payload, "to_model", None),
                    "reason": getattr(
                        getattr(payload, "reason", None), "value",
                        getattr(payload, "reason", None),
                    ),
                },
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

        else:
            # 未识别的 SDK 原生通知统一透传 acp_raw（不静默丢弃）。
            events.append(codex_raw_event(method or "unknown", payload))

        return events

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
        from services.skill_runtime import codex_skills_config

        skill_override = await asyncio.to_thread(
            lambda: codex_skills_config(self.project_skills(cwd))
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
                    await stream_turn(turn)
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
        return workstep_input_commands()
