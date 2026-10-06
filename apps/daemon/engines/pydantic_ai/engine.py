"""PydanticAIEngine — built-in Python agent powered by Pydantic AI."""

import asyncio
import functools
from inspect import isawaitable
from importlib import metadata, util
import json
import logging
from pathlib import Path
import uuid
from typing import Any, AsyncIterator, Awaitable, Callable

from engines.core.image_input import render_image_prompt
from engines.core.acp_base import AcpEngineBase
from engines.pydantic_ai.harness_runtime import PydanticAIHarnessRuntime
from engines.core.base import EngineModel, resolve_thinking_effort
from engines.core.schema import EngineImage
from engines.core.events import (
    InternalEvent,
    agent_message_chunk,
    normalize_token_usage,
    tool_call_event,
    tool_call_update_event,
    usage_update_event,
)
from engines.core.interactions import elicitation_request, permission_request
from engines.core.plans import normalize_plan_status, plan_event, subagent_event
from engines.core.schema import EngineConfigField, EngineConfigOption
from engines.pydantic_ai.coder import WorkStepCoder
from services import providers as provider_service
from services.config import config_store
from services.tool_registry import WorkstepClient, workstep_tools_instruction

logger = logging.getLogger(__name__)

PYDANTIC_AI_REQUEST_LIMIT = 100
PYDANTIC_AI_TOOL_RETRIES = 3
PYDANTIC_AI_CODER_COMMANDS = (
    "git",
    "rg",
    "grep",
    "find",
    "ls",
    "cat",
    "sed",
    "head",
    "tail",
    "python",
    "uv",
    "pytest",
    "ruff",
    "make",
    "yarn",
    "npm",
    "npx",
    "node",
)

#: pydantic-ai-harness `Planning` toolset tools that mutate the plan store.
#: After any of them completes, the pinned store is the authoritative plan
#: state, so the engine republishes an ACP ``plan`` snapshot (the frontend
#: renders it identically to other engines' plan events).
PYDANTIC_PLANNING_TOOL_NAMES = frozenset({
    "write_plan",
    "add_task",
    "update_task_status",
    "update_task_statuses",
    "remove_task",
    "add_subtask",
    "set_dependency",
})


class PydanticAIEngine(PydanticAIHarnessRuntime, AcpEngineBase):
    ENGINE_ID = "pydantic_ai"
    SYSTEM_PROMPT_MODE = "system"

    @classmethod
    def supported_provider_protocols(cls) -> set[str]:
        return {
            "anthropic_messages",
            "openai_responses",
            "openai_chat_completions",
        }

    @classmethod
    def provider_required(cls) -> bool:
        return True

    """Built-in agent that lets Pydantic AI load the configured provider."""

    def __init__(self):
        super().__init__()
        self._running = False
        self._run_task: asyncio.Task | None = None
        self._interaction_permission_grants: set[str] = set()
        self._interaction_permission_rejects: set[str] = set()
        # Pinned harness Planning store of the current spawn (authoritative
        # plan source) plus the last published snapshot signature for dedupe.
        self._active_plan_store: Any = None
        self._last_plan_snapshot: str | None = None

    @property
    def supports_vision(self) -> bool:
        """Pydantic AI passes image parts natively to the provider."""
        return True

    @property
    def supports_workstep_tools(self) -> bool:
        """The built-in agent can load WorkStep internal tools on demand."""
        return True

    @staticmethod
    def _tool_error_value(return_annotation: Any, exc: Exception) -> Any:
        """Turn a tool failure into a model-visible value matching the return type.

        pydantic-ai 2.23 re-raises plain tool exceptions and aborts the whole
        run, so built-in tools convert failures into error values the model can
        read and correct from instead of killing the agent turn.
        """
        message = f"工具执行失败（{type(exc).__name__}）：{exc}"
        annotation = str(return_annotation)
        if "list" in annotation:
            return [message]
        if "dict" in annotation:
            return {"ok": False, "error": message}
        return message

    @classmethod
    async def run_simple(cls, prompt: str,
                         usage_details: dict | None = None) -> str:
        """One-shot, context-free completion via the configured provider.

        无工具、无项目上下文、无会话记忆：仅用于轻量单轮改写等快速场景。
        """
        if not await asyncio.to_thread(cls.is_installed):
            raise RuntimeError("Pydantic AI 未安装")
        get_config = getattr(config_store, "get_pydantic_ai_engine_config", None)
        if get_config is None:
            raise RuntimeError("Pydantic AI 尚未配置")
        config = await asyncio.to_thread(get_config)
        model_name = str(config.get("model") or "")
        try:
            runtime = await asyncio.to_thread(
                cls().resolve_provider_runtime,
                provider_id=str(config.get("provider_id") or ""),
                model=model_name,
            )
        except ValueError as exc:
            raise RuntimeError(str(exc)) from exc
        provider = await asyncio.to_thread(config_store.get_provider, runtime.provider_id)
        if provider is None or not provider.get("base_url") or not model_name:
            raise RuntimeError("Pydantic AI 尚未配置供应商和模型")
        if usage_details is not None:
            from services.gateway_client.usage import snapshot_usage_provider

            usage_details.update({
                "provider": snapshot_usage_provider(provider),
                "model": model_name,
            })
        loaded_model = cls.build_model(
            provider=provider,
            model_name=model_name,
            protocol=runtime.protocol,
        )
        from pydantic_ai import Agent

        agent = Agent(loaded_model)
        result = await agent.run(prompt)
        if usage_details is not None:
            usage_attr = getattr(result, "usage", None)
            usage = usage_attr() if callable(usage_attr) else usage_attr
            if usage is not None:
                usage_details["usage"] = {
                    "input_tokens": getattr(usage, "input_tokens", 0),
                    "output_tokens": getattr(usage, "output_tokens", 0),
                    "cache_read_input_tokens": getattr(usage, "cache_read_tokens", 0),
                    "cache_creation_input_tokens": getattr(usage, "cache_write_tokens", 0),
                    "cache_input_included": runtime.protocol != "anthropic_messages",
                }
        return str(getattr(result, "output", "") or "").strip()

    @staticmethod
    def is_installed() -> bool:
        return util.find_spec("pydantic_ai") is not None

    @staticmethod
    def is_configured() -> bool:
        config = config_store.get_pydantic_ai_engine_config()
        if not config["provider_id"] or not config["model"]:
            return False
        provider = config_store.get_provider(config["provider_id"])
        return bool(
            provider
            and provider.get("base_url")
            and provider.get("enabled", True)
            and PydanticAIEngine.supports_provider(provider)
        )

    @staticmethod
    def get_version() -> str | None:
        try:
            return metadata.version("pydantic-ai-slim")
        except metadata.PackageNotFoundError:
            try:
                return metadata.version("pydantic-ai")
            except metadata.PackageNotFoundError:
                return None

    @staticmethod
    def resolve_binary() -> None:
        return None

    # --- Config schema (backend-driven settings form) ---

    @classmethod
    def config_schema(cls) -> list[EngineConfigField]:
        options = tuple(
            EngineConfigOption(str(item["id"]), str(item["name"]))
            for item in config_store.get_providers()
            if item.get("enabled", True)
        )
        return [
            EngineConfigField(
                key="provider_id",
                label="供应商",
                type="select",
                options=options or (EngineConfigOption("", "暂无已启用供应商"),),
                required=True,
                help="在设置 → 供应商中管理 API 地址与密钥；本引擎复用所选供应商的凭据。",
            ),
            EngineConfigField(
                key="sandbox",
                label="沙箱模式",
                type="select",
                options=tuple(
                    EngineConfigOption(mode, mode)
                    for mode in ("read-only", "workspace-write", "danger-full-access")
                ),
                default="workspace-write",
                help="工具执行沙箱；workspace-write 及以上权限允许 cd 等导航命令。",
            ),
        ]

    def get_config_values(self) -> dict:
        config = config_store.get_pydantic_ai_engine_config()
        return {
            "provider_id": config["provider_id"],
            "sandbox": config["sandbox"],
        }

    def get_config_secrets(self) -> dict[str, bool]:
        return {}

    def clear_provider_default_model(self) -> None:
        current = config_store.get_pydantic_ai_engine_config()
        config_store.set_pydantic_ai_engine_config(
            provider_id=current["provider_id"],
            model="",
            mcp_servers=current["mcp_servers"],
            harness="auto",
            sandbox=current["sandbox"],
        )

    async def save_config_values(
        self,
        values: dict,
        clear: dict[str, bool] | None = None,
        confirmed: dict[str, bool] | None = None,
    ) -> None:
        provider_id = str(values.get("provider_id") or "").strip()
        if not provider_id:
            raise ValueError("请选择供应商")
        provider = await asyncio.to_thread(config_store.get_provider, provider_id)
        if provider is None or not provider.get("enabled", True):
            raise ValueError("所选供应商不存在或已停用")
        def save() -> None:
            current = config_store.get_pydantic_ai_engine_config()
            config_store.set_pydantic_ai_engine_config(
                provider_id=provider_id,
                model=str(current["model"]),
                mcp_servers=current["mcp_servers"],
                # harness 扩展始终自动：已安装 pydantic-ai-harness 时挂载
                # 压缩与会话持久化，否则回退 message_history，不由用户选择。
                harness="auto",
                sandbox=str(values.get("sandbox") or current["sandbox"]),
            )

        await asyncio.to_thread(save)

    async def inspect_capabilities(
        self,
        project_root: str | None = None,
    ) -> dict:
        """Return the project skills and MCP servers the engine loads."""
        skills: list[dict] = []
        resolved_root: Path | None = None
        if project_root:
            resolved_root = await asyncio.to_thread(
                Path(project_root).expanduser().resolve
            )
            selection = await asyncio.to_thread(self.project_skills, str(resolved_root))
            skills = [
                {
                    "name": skill.name,
                    "description": skill.description,
                    "source_dir": str(skill.runtime_path),
                }
                for skill in selection.enabled
                if skill.runtime_path is not None
            ]
        input_items = [dict(item) for item in self.input_commands()]
        known_names = {item["name"] for item in input_items}
        input_items.extend(
            {
                "kind": "skill",
                "name": skill["name"],
                "description": skill["description"],
                "insert_text": f"/{skill['name']} ",
                "action": "prompt",
            }
            for skill in skills
            if skill["name"] not in known_names
        )
        config = await asyncio.to_thread(config_store.get_pydantic_ai_engine_config)
        mcp_servers = [
            {
                "name": server["name"],
                "command": server["command"],
                "args": list(server.get("args") or []),
            }
            for server in (config.get("mcp_servers") or [])
            if isinstance(server, dict)
        ]
        mcp_supported, mcp_error = self._mcp_support_status()
        return {
            "engine_id": "pydantic_ai",
            "project_root": str(resolved_root) if resolved_root else None,
            "skills": skills,
            "input_items": input_items,
            "mcp_servers": mcp_servers,
            "mcp_supported": mcp_supported,
            "mcp_error": mcp_error,
            "harness_enabled": self._harness_enabled(),
            "harness_version": self._harness_version(),
            "websearch": True,
            "webfetch": True,
        }

    @staticmethod
    def _harness_version() -> str | None:
        """pydantic-ai-harness version when installed, else None."""
        try:
            from importlib import metadata

            return metadata.version("pydantic-ai-harness")
        except Exception:
            return None

    @staticmethod
    def _mcp_support_status() -> tuple[bool, str | None]:
        """Whether the runtime can actually load MCP servers (fastmcp)."""
        try:
            if util.find_spec("fastmcp") is None or util.find_spec("mcp") is None:
                return (
                    False,
                    '缺少 MCP 依赖，安装后即可加载：pip install "pydantic-ai-slim[mcp]"',
                )
            return True, None
        except Exception as exc:  # pragma: no cover
            return False, str(exc)

    def reveal_config_value(self, key: str) -> str | None:
        return None

    async def list_models(
        self,
        cwd: str,
        provider_id: str | None = None,
        refresh: bool = False,
    ) -> list[EngineModel]:
        """List models for a provider; ``provider_id`` overrides the global
        config so assistant-level dynamic config can drive the dropdown.

        Defaults to the locally saved copy; ``refresh=True`` re-fetches from
        the provider address and saves the result.
        """
        config = await asyncio.to_thread(config_store.get_pydantic_ai_engine_config)
        provider = await asyncio.to_thread(
            config_store.get_provider, provider_id or config["provider_id"]
        )
        if provider is None:
            return []
        protocol = self.pick_protocol(provider)
        entry = await asyncio.to_thread(
            config_store.get_provider_models, provider["id"], protocol
        )
        if not refresh and entry:
            return await asyncio.to_thread(
                provider_service.saved_models, provider["id"], protocol
            )
        return await provider_service.fetch_and_save_models(
            provider, protocol=protocol
        )

    @staticmethod
    def build_model(*, provider: dict, model_name: str, protocol: str | None = None):
        """Construct the Pydantic AI model from a stored provider record.

        ``protocol`` 由基类 ``pick_protocol`` 解析（供应商多协议时按其
        列表顺序与本引擎支持集合取交集）；缺省回退供应商默认协议。
        """
        provider_service.require_managed_model(provider, model_name)
        provider_type = str(provider.get("type") or "custom")
        protocol = str(protocol or "").strip() or (
            provider_service.normalize_provider_protocol(
                str(provider.get("protocol") or ""), provider_type
            )
        )
        base_url = provider_service.provider_runtime_base_url(provider, protocol)
        api_key = str(provider.get("api_key") or "")
        if protocol == "anthropic_messages":
            from pydantic_ai.models.anthropic import AnthropicModel
            from pydantic_ai.providers.anthropic import AnthropicProvider

            return AnthropicModel(
                model_name,
                provider=AnthropicProvider(
                    base_url=base_url,
                    api_key=api_key or "not-needed",
                ),
            )

        from pydantic_ai.models.openai import OpenAIChatModel, OpenAIResponsesModel
        from pydantic_ai.providers.openai import OpenAIProvider

        model_class = (
            OpenAIResponsesModel
            if protocol == "openai_responses"
            else OpenAIChatModel
        )
        return model_class(
            model_name,
            provider=OpenAIProvider(
                base_url=base_url,
                api_key=api_key or "not-needed",
            ),
        )

    async def _stream_agent_run(
        self,
        agent,
        *,
        prompt: str,
        on_event: Callable[[InternalEvent], Awaitable[None]],
        message_history: list | None = None,
        model_settings: dict[str, Any] | None = None,
        conversation_id: str | None = None,
    ):
        """Run one agent round and forward mapped internal events."""
        from pydantic_ai import UsageLimits

        kwargs = {
            "usage_limits": UsageLimits(
                request_limit=PYDANTIC_AI_REQUEST_LIMIT,
            ),
        }
        if message_history is not None:
            kwargs["message_history"] = message_history
        if model_settings:
            kwargs["model_settings"] = model_settings
        if conversation_id:
            kwargs["conversation_id"] = conversation_id
        tool_names: dict[str, str] = {}
        text_parts: dict[int, dict[str, Any]] = {}
        pending: list[InternalEvent] = []
        round_id = 0
        run_id = uuid.uuid4().hex

        async def flush(phase):
            nonlocal round_id
            for item in pending:
                if (
                    item.type == "agent_message_chunk"
                    and phase == "commentary"
                    and item.data.get("phase") != "final_answer"
                ):
                    # 中间引导文本归入思考通道（对齐 Codex reasoning 行为）
                    text = item.data.get("content", {}).get("text", "")
                    if text:
                        await on_event(InternalEvent(
                            type="agent_thought_chunk",
                            data={"content": {"text": text}},
                        ))
                    continue
                if item.type == "agent_message_chunk":
                    item.data.setdefault("phase", phase)
                    item.data.setdefault("source_item_id", f"{run_id}:{round_id}")
                await on_event(item)
            pending.clear()
            round_id += 1

        try:
            async with agent.run_stream_events(prompt, **kwargs) as stream:
                result = None
                async for event in stream:
                    if getattr(event, "event_kind", "") == "agent_run_result":
                        result = event.result
                        await flush("final_answer")
                        continue
                    internal = self._map_stream_event(event, text_parts)
                    if internal is None:
                        continue
                    if internal.type == "tool_call":
                        # A tool request is protocol evidence that this model
                        # response is an intermediate step, even without phase.
                        await flush("commentary")
                        call_id = str(internal.data.get("tool_call_id") or "")
                        if call_id:
                            tool_names[call_id] = str(internal.data.get("title") or "")
                    if internal.type == "agent_message_chunk" or pending:
                        pending.append(internal)
                    else:
                        await on_event(internal)
                    if internal.type == "tool_call_update" and tool_names.get(
                        str(internal.data.get("tool_call_id") or "")
                    ) in PYDANTIC_PLANNING_TOOL_NAMES:
                        await self._publish_plan_snapshot(on_event)
                if result is None:
                    raise RuntimeError("Pydantic AI 未返回执行结果")
                return result
        finally:
            # An interrupted run has no accepted final result. Keep its partial
            # output in the process log instead of inventing a final answer.
            await flush("commentary")

    async def _publish_plan_snapshot(
        self,
        on_event: Callable[[InternalEvent], Awaitable[None]],
    ) -> None:
        """Republish the harness plan as an ACP ``plan`` snapshot.

        The Pydantic AI Coder's ``Planning`` toolset (``write_plan``,
        ``update_task_status``/``update_task_statuses``, …) mutates the pinned
        store directly; those tools are Pydantic-engine-specific and have no
        ACP plan events of their own, so after each of them completes the
        store is read back and published as the standard ``plan`` snapshot the
        frontend already renders. Duplicates of an unchanged plan are skipped.
        """
        store = getattr(self, "_active_plan_store", None)
        if store is None:
            return
        try:
            items = await store.get_items()
        except Exception:
            logger.exception("Failed to read harness plan store")
            return
        entries = [self._harness_plan_entry(item) for item in items]
        signature = json.dumps(entries, ensure_ascii=False, sort_keys=True)
        if signature == getattr(self, "_last_plan_snapshot", None):
            return
        self._last_plan_snapshot = signature
        await on_event(plan_event(entries))

    @staticmethod
    def _harness_plan_entry(item: Any) -> dict[str, str]:
        """Project a harness ``PlanItem`` onto ACP stable plan fields."""
        content = str(getattr(item, "content", "") or "").strip()
        if not content:
            return {
                "content": content,
                "priority": "medium",
                "status": "pending",
            }
        status = str(
            getattr(getattr(item, "status", None), "value", item.status)
            or "pending"
        )
        entry: dict[str, str] = {
            "content": content,
            "priority": "medium",
            "status": normalize_plan_status(status),
        }
        active_form = str(getattr(item, "active_form", "") or "").strip()
        if active_form and active_form != content:
            entry["detail"] = active_form
        return entry

    @staticmethod
    def _accumulate_usage(total, result):
        usage_attr = getattr(result, "usage", None)
        usage = usage_attr() if callable(usage_attr) else usage_attr
        if usage is None:
            return total
        return usage if total is None else total + usage

    @staticmethod
    def _context_usage_snapshot(result, model) -> tuple[int | None, int | None]:
        """Return current context occupancy separately from cumulative run usage."""
        try:
            from pydantic_ai_harness.compaction import (
                DEFAULT_CONTEXT_WINDOW,
                estimate_context_tokens,
                resolve_context_window,
            )

            messages = result.all_messages()
            used = estimate_context_tokens(messages)
            size = resolve_context_window(model) or DEFAULT_CONTEXT_WINDOW
            return int(used), int(size)
        except Exception:
            logger.exception("Failed to estimate Pydantic AI context usage")
            return None, None

    async def _ask_user(
        self,
        on_event: Callable[[InternalEvent], Awaitable[None]],
        *,
        question: str,
        options: list[str] | None = None,
        multiple: bool = False,
        allow_input: bool = True,
    ) -> dict[str, Any]:
        """Pause the in-process agent with an ACP form elicitation."""
        interaction_id = str(uuid.uuid4())
        choices = [
            {"const": str(option), "title": str(option)}
            for option in (options or [])
            if str(option).strip()
        ]
        if multiple:
            field: dict[str, Any] = {
                "type": "array",
                "title": "请选择",
                "description": question,
                "items": {"oneOf": choices},
            }
        else:
            field = {
                "type": "string",
                "title": "请输入或选择",
                "description": question,
            }
            if choices:
                field["oneOf"] = choices
        field["_meta"] = {"allowInput": allow_input}
        event = elicitation_request(
            interaction_id=interaction_id,
            tool_call_id=interaction_id,
            message=question,
            requested_schema={
                "type": "object",
                "properties": {"answer": field},
                "required": ["answer"],
            },
        )
        response = await self.request_interaction(event, on_event)
        if response.get("action") != "accept":
            return {"action": response.get("action") or "cancel"}
        content = response.get("content")
        return content if isinstance(content, dict) else {}

    async def _update_plan(
        self,
        on_event: Callable[[InternalEvent], Awaitable[None]],
        *,
        entries: list[dict[str, str]],
        explanation: str = "",
    ) -> str:
        """Publish the model's current execution plan through the Base seam."""
        event = plan_event(entries, explanation=explanation or None)
        published = on_event(event)
        if isawaitable(published):
            await published
        return f"计划已更新：{len(event.data['entries'])} 项"

    async def _request_permission(
        self,
        on_event: Callable[[InternalEvent], Awaitable[None]],
        *,
        tool_name: str,
        title: str,
        kind: str,
        tool_input: dict[str, Any],
    ) -> bool:
        """Request ACP-style permission for a mutating in-process tool."""
        runtime_decision = self.runtime_permission_decision()
        if runtime_decision is not None:
            return runtime_decision
        if tool_name in self._interaction_permission_grants:
            return True
        if tool_name in self._interaction_permission_rejects:
            return False
        interaction_id = str(uuid.uuid4())
        option_prefix = f"{interaction_id}:"
        event = permission_request(
            interaction_id=interaction_id,
            session_id=str(getattr(self, "_active_session_id", "pydantic-ai")),
            tool_call={
                "tool_call_id": interaction_id,
                "title": title,
                "name": tool_name,
                "kind": kind,
                "raw_input": tool_input,
            },
            options=[
                {
                    "option_id": f"{option_prefix}allow_once",
                    "name": "允许一次",
                    "kind": "allow_once",
                },
                {
                    "option_id": f"{option_prefix}allow_always",
                    "name": "本次运行始终允许",
                    "kind": "allow_always",
                },
                {
                    "option_id": f"{option_prefix}reject_once",
                    "name": "拒绝",
                    "kind": "reject_once",
                },
                {
                    "option_id": f"{option_prefix}reject_for_session",
                    "name": "本次运行拒绝",
                    "kind": "reject_for_session",
                },
            ],
        )
        response = await self.request_interaction(event, on_event)
        outcome = response.get("outcome") or {}
        selected_id = str(outcome.get("option_id") or "")
        selected = next(
            (
                option for option in event.data["options"]
                if option["option_id"] == selected_id
            ),
            None,
        )
        if selected and selected["kind"] == "allow_always":
            self._interaction_permission_grants.add(tool_name)
        elif selected and selected["kind"] == "reject_for_session":
            self._interaction_permission_rejects.add(tool_name)
        return bool(selected and str(selected["kind"]).startswith("allow"))

    async def _run_agent(
        self,
        *,
        prompt: str,
        cwd: str,
        add_dirs: list[str] | None,
        model,
        on_event: Callable[[InternalEvent], Awaitable[None]],
        live_message_queue: asyncio.Queue | None = None,
        images: list[EngineImage] | None = None,
        thinking_effort: str | None = None,
        workstep_tools: bool = False,
        session_id: str | None = None,
        sandbox: str = "workspace-write",
        system_prompt: str | None = None,
    ) -> tuple[Any, Any]:
        """Run the agent, injecting queued live messages between rounds."""
        from pydantic_ai import Agent
        from pydantic_ai.capabilities import Thinking, WebFetch, WebSearch
        from pydantic_ai_harness import Skills

        root = await asyncio.to_thread(Path(cwd).resolve)

        # Refresh the fail-closed SkillCenter mirror before handing that single
        # project-owned library to the harness Skills capability.
        await asyncio.to_thread(self.project_skills, str(root))

        harness_capabilities = await asyncio.to_thread(
            self._harness_capabilities, root, session_id
        )
        effort = resolve_thinking_effort(thinking_effort)
        allowed = list(PYDANTIC_AI_CODER_COMMANDS)
        if sandbox in ("workspace-write", "danger-full-access"):
            allowed.append("cd")
        subagent_capability = self._make_subagent_capability(on_event)
        coder = WorkStepCoder(
            root,
            allowed_commands=allowed,
            subagent_capability=subagent_capability,
        )
        # The pinned Planning store is the authoritative source for the
        # harness planning tools (write_plan / update_task_status / …);
        # reset the dedupe cache because the store is fresh per spawn.
        self._active_plan_store = getattr(coder, "plan_store", None)
        self._last_plan_snapshot = None
        capabilities = [coder]
        skill_library = root / ".workstep" / "skills"
        if await asyncio.to_thread(skill_library.is_dir):
            capabilities.append(Skills(skill_library))
        if effort:
            if effort == "minimal":
                # 「极简」= 关闭思考模式：Pydantic AI 的 ThinkingLevel 支持
                # bool，effort=False → ModelSettings(thinking=False)，显式
                # 关闭思考（仅对始终开启思考的模型被静默忽略）。
                capabilities.append(Thinking(effort=False))
            else:
                capabilities.append(Thinking(effort=effort))
        capabilities.extend(harness_capabilities or [])
        # WebSearch / WebFetch 强制本地模式（native=False）：不调用供应商
        # 原生工具（避免按次计费），由本地实现处理 —— WebSearch→ddgs
        # （duckduckgo extra）、WebFetch→markdownify（web-fetch extra）。
        capabilities.append(WebSearch(native=False, local=True))
        capabilities.append(WebFetch(native=False, local=True))
        agent = Agent(
            model,
            **({"system_prompt": system_prompt} if system_prompt else {}),
            capabilities=capabilities,
            retries={"tools": PYDANTIC_AI_TOOL_RETRIES, "output": 1},
        )

        def guard_async(return_type):
            """Wrap an async tool so failures become model-visible error values."""
            def decorate(func):
                @functools.wraps(func)
                async def wrapped(*args, **kwargs):
                    try:
                        return await func(*args, **kwargs)
                    except Exception as exc:
                        return self._tool_error_value(return_type, exc)
                return wrapped
            return decorate

        if workstep_tools:
            async def workstep_call(
                operation: str,
                arguments: dict[str, Any],
            ) -> dict[str, Any]:
                """WorkStep daemon tool wrapper."""
                return await WorkstepClient().call(operation, arguments)

            workstep_call.__doc__ = workstep_tools_instruction()
            agent.tool_plain(guard_async(dict[str, Any])(workstep_call))

        async def ask_user(
            question: str,
            options: list[str] | str | None = None,
            multiple: bool = False,
            allow_input: bool = True,
        ) -> dict[str, Any]:
            """Ask the user a required question and wait for their response.

            Use options for suggested choices, multiple for multi-select, and
            allow_input when the user may enter a custom answer. Options may be
            a JSON array string when the model cannot emit a native array.
            """
            normalized_options = options
            if isinstance(options, str):
                try:
                    decoded = json.loads(options)
                except (TypeError, ValueError):
                    decoded = None
                normalized_options = (
                    [str(option) for option in decoded]
                    if isinstance(decoded, list)
                    else [options]
                )
            return await self._ask_user(
                on_event,
                question=question,
                options=normalized_options,
                multiple=multiple,
                allow_input=allow_input,
            )

        agent.tool_plain(ask_user)

        async def update_plan(
            entries: list[dict[str, str]],
            explanation: str = "",
        ) -> str:
            """Replace the current execution plan with a complete task snapshot.

            Each entry contains content, pending/in_progress/completed status,
            and an optional high/medium/low priority.
            """
            return await self._update_plan(
                on_event,
                entries=entries,
                explanation=explanation,
            )

        agent.tool_plain(update_plan)

        total_usage = None
        receipt_scope = self._open_receipt_scope(harness_capabilities)
        try:
            async with agent:
                stream_kwargs: dict[str, Any] = {}
                # Cross-turn context is owned entirely by the harness
                # StepPersistence store (``.workstep/harness_runs.db``); no
                # host-supplied ``message_history`` is accepted.
                seeded_history = (
                    await self._harness_continue_history(root, session_id)
                    if harness_capabilities
                    else None
                )
                seeded_history = self._with_session_system_prompt(seeded_history, system_prompt)
                if seeded_history is not None:
                    stream_kwargs["message_history"] = seeded_history
                result = await self._stream_agent_run(
                    agent,
                    prompt=await asyncio.to_thread(
                        self._build_user_content, prompt, images
                    ),
                    on_event=on_event,
                    conversation_id=(
                        session_id if harness_capabilities else None
                    ),
                    **stream_kwargs,
                )
                total_usage = self._accumulate_usage(total_usage, result)
                while live_message_queue is not None:
                    live_items = self._take_live_items(live_message_queue)
                    if not live_items:
                        # 插入队列已空：回复即收尾，不等待插入窗口。
                        break
                    injected = "\n\n".join(content for _, content in live_items)
                    # 先确认送达再跑插入轮：runner 收到 delivered 后封口插入前的
                    # 输出段并开启新的响应段，本轮响应事件归入新段。
                    for message_id, _ in live_items:
                        await on_event(InternalEvent(type="live_message", data={
                            "message_id": message_id,
                            "status": "delivered",
                            "detail": "",
                        }))
                    result = await self._stream_agent_run(
                        agent,
                        prompt=injected,
                        on_event=on_event,
                        conversation_id=(
                            session_id if harness_capabilities else None
                        ),
                        **{
                            **({"message_history": result.all_messages()}),
                        },
                    )
                    total_usage = self._accumulate_usage(total_usage, result)
        finally:
            await self._drain_compaction_receipts(receipt_scope, on_event)
        return result, total_usage

    @staticmethod
    def _build_user_content(
        prompt: str,
        images: list[EngineImage] | None,
    ) -> str | list:
        """Build a Pydantic AI UserContent, embedding images when present."""
        if not images:
            return prompt
        from pydantic_ai.messages import ImageUrl

        parts = [prompt]
        for image in images:
            parts.append(ImageUrl(url=image.to_data_url()))
        return parts

    @staticmethod
    def _take_live_items(queue: asyncio.Queue) -> list[tuple[str, str]]:
        """Drain all queued ``(message_id, content)`` pairs without blocking."""
        items: list[tuple[str, str]] = []
        while not queue.empty():
            items.append(queue.get_nowait())
        return items

    @staticmethod
    def _json_safe(value: Any) -> Any:
        try:
            return json.loads(json.dumps(value, ensure_ascii=False, default=str))
        except (TypeError, ValueError):
            return str(value)

    @classmethod
    def _map_stream_event(cls, event, text_parts: dict | None = None) -> InternalEvent | None:
        """Map Pydantic AI agent events without duplicating completed parts."""
        event_kind = getattr(event, "event_kind", "")
        if text_parts is None:
            text_parts = {}
        index = getattr(event, "index", 0)

        if event_kind == "part_start":
            part = event.part
            part_kind = getattr(part, "part_kind", "")
            content = getattr(part, "content", "")
            text_parts.pop(index, None)
            if part_kind == "text":
                details = getattr(part, "provider_details", None) or {}
                text_parts[index] = {
                    "phase": details.get("phase"),
                    "source_item_id": getattr(part, "id", None),
                }
            if part_kind == "text" and content:
                return agent_message_chunk(content, **text_parts[index])
            if part_kind == "thinking" and content:
                return InternalEvent(
                    type="agent_thought_chunk",
                    data={"content": {"text": content}},
                )
            if part_kind == "builtin-tool-call":
                return tool_call_event(
                    tool_call_id=str(getattr(part, "tool_call_id", "")),
                    title=str(getattr(part, "tool_name", "")),
                    raw_input=cls._json_safe(getattr(part, "args", {})),
                )
            if part_kind == "builtin-tool-return":
                return tool_call_update_event(
                    tool_call_id=str(getattr(part, "tool_call_id", "")),
                    status="failed" if getattr(part, "outcome", "success") != "success" else "completed",
                    raw_output=cls._json_safe(content),
                )

        if event_kind == "part_delta":
            delta = event.delta
            delta_kind = getattr(delta, "part_delta_kind", "")
            content = getattr(delta, "content_delta", "")
            if delta_kind == "text" and content:
                return agent_message_chunk(content, **text_parts.get(index, {}))
            if delta_kind == "thinking" and content:
                return InternalEvent(
                    type="agent_thought_chunk",
                    data={"content": {"text": content}},
                )

        if event_kind in {"function_tool_call", "output_tool_call"}:
            part = event.part
            return tool_call_event(
                tool_call_id=str(getattr(part, "tool_call_id", "")),
                title=str(getattr(part, "tool_name", "")),
                raw_input=cls._json_safe(getattr(part, "args", {})),
            )

        if event_kind in {"function_tool_result", "output_tool_result"}:
            part = event.part
            content = getattr(event, "content", None)
            if content is None:
                content = getattr(part, "content", "")
            return tool_call_update_event(
                tool_call_id=str(getattr(part, "tool_call_id", "")),
                status="failed" if (
                    getattr(part, "part_kind", "") == "retry-prompt"
                    or getattr(part, "outcome", "success") != "success"
                ) else "completed",
                raw_output=cls._json_safe(content),
            )

        return None

    def _make_subagent_capability(self, on_event):
        """Observe the whole child run; SDK event streams only cover one node."""
        from pydantic_ai.capabilities import AbstractCapability

        mapper = self._map_stream_event

        class SubagentProgress(AbstractCapability):
            async def emit(self, ctx, status, stage, internal=None):
                agent = ctx.agent
                frame = subagent_event(
                    task_id=f"subagent-{ctx.run_id}",
                    description=getattr(agent, "description", None) or getattr(agent, "name", None),
                    status=status,
                    stage=stage,
                    last_tool_name=(internal.data.get("title")
                                    if internal and internal.type == "tool_call" else None),
                )
                if internal is not None:
                    frame.data["event"] = internal.to_dict()
                await on_event(frame)

            async def wrap_run(self, ctx, *, handler):
                await self.emit(ctx, "running", "started")
                status = "failed"
                try:
                    result = await handler()
                    status = "completed"
                    return result
                except asyncio.CancelledError:
                    status = "stopped"
                    raise
                finally:
                    await self.emit(ctx, status, "finished")

            async def wrap_run_event_stream(self, ctx, *, stream):
                text_parts = {}
                async for event in stream:
                    internal = mapper(event, text_parts)
                    if internal is not None:
                        await self.emit(ctx, "running", "progress", internal)
                    yield event

        return SubagentProgress()

    async def spawn(
        self,
        prompt: str,
        cwd: str,
        model: str | None = None,
        add_dirs: list[str] | None = None,
        session_id: str | None = None,
        live_message_queue: asyncio.Queue | None = None,
        images: list[EngineImage] | None = None,
        thinking_effort: str | None = None,
        config_overrides: dict | None = None,
        workstep_tools: bool = False,
        system_prompt: str | None = None,
    ) -> AsyncIterator[InternalEvent]:
        config = self.merge_config_overrides(
            await asyncio.to_thread(config_store.get_pydantic_ai_engine_config),
            config_overrides,
        )
        model_name = model or config["model"]
        try:
            provider_runtime = await asyncio.to_thread(
                self.resolve_provider_runtime,
                provider_id=config["provider_id"],
                model=model_name,
            )
        except ValueError as exc:
            yield InternalEvent(type="error", data={"message": str(exc)})
            return
        model_name = provider_runtime.model
        provider = await asyncio.to_thread(
            config_store.get_provider, provider_runtime.provider_id
        )
        if provider is None or not provider.get("base_url") or not model_name:
            yield InternalEvent(
                type="error",
                data={"message": "Pydantic AI 尚未配置供应商和模型"},
            )
            return

        supports_multimodal = getattr(config_store, "model_supports_multimodal", None)
        model_accepts_images = (
            await asyncio.to_thread(
                supports_multimodal, self.ENGINE_ID, model_name,
                provider_runtime.provider_id,
            )
            if callable(supports_multimodal)
            else self.supports_vision
        )
        if images and not model_accepts_images:
            prompt = await asyncio.to_thread(render_image_prompt, prompt, images)
            images = None

        self._running = True
        # 进程内 Agent 没有 CLI 会话概念：session_id 作为会话标识（供任务记录
        # 与前端展示，同一对话保持稳定），跨轮上下文由 harness StepPersistence
        # （.workstep/harness_runs.db，按 session_id）承载。
        session_uuid = session_id or str(uuid.uuid4())
        self._active_session_id = session_uuid
        self._interaction_permission_grants.clear()
        self._interaction_permission_rejects.clear()
        yield InternalEvent(type="session_started", data={"session_id": session_uuid})
        yield InternalEvent(type="status", data={"status": "running"})
        agent_task: asyncio.Task | None = None
        try:
            loaded_model = self.build_model(
                provider=provider,
                model_name=model_name,
                protocol=provider_runtime.protocol,
            )
            event_queue: asyncio.Queue[InternalEvent] = asyncio.Queue()
            run_kwargs: dict[str, Any] = {
                "prompt": prompt,
                "cwd": cwd,
                "add_dirs": add_dirs,
                "model": loaded_model,
                "on_event": event_queue.put,
                "live_message_queue": live_message_queue,
                "images": images,
                "session_id": session_uuid,
                "sandbox": str(config.get("sandbox") or "workspace-write"),
            }
            if thinking_effort:
                run_kwargs["thinking_effort"] = thinking_effort
            if system_prompt is not None:
                run_kwargs["system_prompt"] = system_prompt
            if workstep_tools:
                run_kwargs["workstep_tools"] = True
            agent_task = asyncio.create_task(
                self._run_agent(**run_kwargs)
            )
            self._run_task = agent_task
            emitted_text = False
            while not agent_task.done() or not event_queue.empty():
                try:
                    event = await asyncio.wait_for(
                        event_queue.get(),
                        timeout=0.05,
                    )
                except asyncio.TimeoutError:
                    # 执行中插入消息：中断当前 run，携带已有 history 重启
                    if (
                        live_message_queue is not None
                        and not live_message_queue.empty()
                        and not agent_task.done()
                    ):
                        live_items = self._take_live_items(
                            live_message_queue
                        )
                        injected = "\n\n".join(
                            content for _, content in live_items
                        )
                        # 先确认送达：runner 收到 delivered 后封口旧段开新段
                        for message_id, _ in live_items:
                            yield InternalEvent(
                                type="live_message",
                                data={
                                    "message_id": message_id,
                                    "status": "delivered",
                                    "detail": "",
                                },
                            )
                        # 中断当前 run
                        agent_task.cancel()
                        try:
                            await asyncio.gather(
                                agent_task, return_exceptions=True
                            )
                        except asyncio.CancelledError:
                            pass
                        # 用既有上下文 + injected 启动新 run
                        new_kwargs = dict(run_kwargs)
                        new_kwargs["prompt"] = injected
                        event_queue = asyncio.Queue()
                        new_kwargs["on_event"] = event_queue.put
                        agent_task = asyncio.create_task(
                            self._run_agent(**new_kwargs)
                        )
                        self._run_task = agent_task
                        emitted_text = False
                    continue
                if event.type == "agent_message_chunk" and event.data.get("phase") != "commentary":
                    emitted_text = True
                yield event

            result, total_usage = await agent_task
            if not emitted_text:
                output = str(getattr(result, "output", ""))
                if output:
                    yield InternalEvent(
                        type="agent_message_chunk",
                        data={"content": {"text": output}},
                    )

            if total_usage is not None:
                usage_data = normalize_token_usage({
                    "input_tokens": getattr(total_usage, "input_tokens", 0),
                    "output_tokens": getattr(total_usage, "output_tokens", 0),
                    "total_tokens": getattr(total_usage, "total_tokens", 0),
                    "cache_write_tokens": getattr(total_usage, "cache_write_tokens", 0),
                    "cache_read_tokens": getattr(total_usage, "cache_read_tokens", 0),
                })
                usage_data["requests"] = getattr(total_usage, "requests", 0)
                usage_data["provider_id"] = config["provider_id"]
                cost = getattr(total_usage, "cost", None)
                if cost is not None:
                    try:
                        amount = float(cost)
                    except (TypeError, ValueError):
                        amount = 0.0
                    if amount:
                        usage_data["cost"] = {
                            "amount": round(amount, 6),
                            "currency": "USD",
                        }
                usage_data["session_id"] = session_uuid
                context_used, context_size = self._context_usage_snapshot(
                    result,
                    loaded_model,
                )
                yield usage_update_event(
                    usage_data,
                    used=context_used,
                    size=context_size,
                )
            yield InternalEvent(type="status", data={"status": "done"})
        except asyncio.CancelledError:
            yield InternalEvent(type="status", data={"status": "cancelled"})
        except Exception as exc:
            logger.exception("Pydantic AI engine error")
            yield InternalEvent(type="error", data={"message": str(exc)})
        finally:
            if agent_task is not None and not agent_task.done():
                agent_task.cancel()
                await asyncio.gather(agent_task, return_exceptions=True)
            self._running = False
            self._run_task = None
            self._interaction_permission_grants.clear()
        self._interaction_permission_rejects.clear()

    async def stop(self) -> None:
        if self._run_task and not self._run_task.done():
            self._run_task.cancel()
        self._running = False

    async def inject_response(self, tool_use_id: str, content: str) -> None:
        logger.warning("inject_response is not supported by PydanticAIEngine")

    @property
    def supports_live_step_message(self) -> bool:
        return True

    @property
    def supports_message_history(self) -> bool:
        """Cross-turn context is owned by the harness StepPersistence store
        (``.workstep/harness_runs.db``), keyed by ``session_id``; the host does
        not round-trip ``message_history`` / ``engine_state`` for this engine."""
        return False

    @property
    def supports_thinking_effort(self) -> bool:
        """Per-turn effort is provided by Pydantic AI's Thinking capability."""
        return True

    @property
    def supports_resume(self) -> bool:
        # 同一会话标识（engine_session_id）对应一份可恢复的 message_history，
        # 语义上与 CLI 引擎的 resume 等价：跨轮上下文由引擎侧维护。
        return True

    @property
    def supports_interactive(self) -> bool:
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
        "engine_state",
        "compacted",
        "error",
    })

    @property
    def supports_tool_approval(self) -> bool:
        """进程内写文件等工具经 _request_permission 弹窗，原生审批语义。"""
        return True

    async def create_session(
        self,
        cwd: str,
        add_dirs: list[str] | None = None,
        mcp_servers: list | None = None,
    ) -> str | None:
        """进程内 Agent 无 CLI 会话；会话标识在首次 spawn 时生成。"""
        logger.info("PydanticAI create_session: not supported (in-process agent)")
        return None

    async def resume_session(
        self,
        session_id: str,
        cwd: str,
        add_dirs: list[str] | None = None,
        mcp_servers: list | None = None,
    ) -> bool:
        """跨轮上下文由 message_history 承载，不依赖 CLI 会话存储。"""
        return False

    async def close_session(self, session_id: str, cwd: str | None = None) -> None:
        """关闭会话 = 结束当前运行中的 agent 任务。"""
        if self._running:
            await self.stop()

    async def cancel_session(self, session_id: str, cwd: str | None = None) -> None:
        """取消会话 = 结束当前运行中的 agent 任务。"""
        if self._running:
            await self.stop()

    async def set_config_option(
        self,
        config_id: str,
        value: str | bool,
        session_id: str | None = None,
    ) -> None:
        """配置在 spawn 时从 config_store 读取（provider / model）；
        运行中修改无原生入口。"""
        return None

    async def reset_options(self, session_id: str | None = None) -> None:
        """无原生 reset；新会话从全局配置重新读取。"""
        return None

    def build_resume_params(self, session_id: str) -> dict:
        return {"session_id": session_id}
