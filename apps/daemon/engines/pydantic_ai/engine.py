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

from engines.core.acp_base import AcpEngineBase
from engines.core.base import EngineModel, resolve_thinking_effort
from engines.core.schema import EngineImage
from engines.core.events import (
    InternalEvent,
    compacted_event,
    normalize_token_usage,
    tool_call_event,
    tool_call_update_event,
    usage_update_event,
)
from engines.core.interactions import elicitation_request, permission_request
from engines.core.plans import plan_event
from engines.core.schema import EngineConfigField, EngineConfigOption
from engines.pydantic_ai.skills import Skills, project_skill_directories
from services import providers as provider_service
from services.config import config_store
from services.tool_registry import WorkstepClient, workstep_tools_instruction

logger = logging.getLogger(__name__)


class PydanticAIEngine(AcpEngineBase):
    ENGINE_ID = "pydantic_ai"

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
    async def run_simple(cls, prompt: str) -> str:
        """One-shot, context-free completion via the configured provider.

        无工具、无项目上下文、无会话记忆：仅用于轻量单轮改写等快速场景。
        """
        if not cls.is_installed():
            raise RuntimeError("Pydantic AI 未安装")
        get_config = getattr(config_store, "get_pydantic_ai_engine_config", None)
        if get_config is None:
            raise RuntimeError("Pydantic AI 尚未配置")
        config = get_config()
        model_name = str(config.get("model") or "")
        try:
            runtime = cls().resolve_provider_runtime(
                provider_id=str(config.get("provider_id") or ""),
                model=model_name,
            )
        except ValueError as exc:
            raise RuntimeError(str(exc)) from exc
        provider = config_store.get_provider(runtime.provider_id)
        if provider is None or not provider.get("base_url") or not model_name:
            raise RuntimeError("Pydantic AI 尚未配置供应商和模型")
        loaded_model = cls.build_model(provider=provider, model_name=model_name)
        from pydantic_ai import Agent

        agent = Agent(loaded_model)
        result = await agent.run(prompt)
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
        ]

    def get_config_values(self) -> dict:
        config = config_store.get_pydantic_ai_engine_config()
        return {
            "provider_id": config["provider_id"],
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
        provider = config_store.get_provider(provider_id)
        if provider is None or not provider.get("enabled", True):
            raise ValueError("所选供应商不存在或已停用")
        current = config_store.get_pydantic_ai_engine_config()
        config_store.set_pydantic_ai_engine_config(
            provider_id=provider_id,
            model=str(current["model"]),
            mcp_servers=current["mcp_servers"],
            # harness 扩展始终自动：已安装 pydantic-ai-harness 时挂载
            # 压缩与会话持久化，否则回退 message_history，不由用户选择。
            harness="auto",
        )

    async def inspect_capabilities(
        self,
        project_root: str | None = None,
    ) -> dict:
        """Return the project skills and MCP servers the engine loads."""
        skills: list[dict] = []
        resolved_root: Path | None = None
        if project_root:
            resolved_root = Path(project_root).expanduser().resolve()
            registry = Skills(
                directories=project_skill_directories(resolved_root, "pydantic_ai"),
            )
            skills = [
                {
                    "name": skill.name,
                    "description": skill.description,
                    "source_dir": str(skill.skill_dir),
                }
                for skill in registry.list_skills()
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
        config = config_store.get_pydantic_ai_engine_config()
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
        config = config_store.get_pydantic_ai_engine_config()
        provider = config_store.get_provider(provider_id or config["provider_id"])
        if provider is None:
            return []
        entry = config_store.get_provider_models(provider["id"])
        if not refresh and entry:
            return provider_service.saved_models(provider["id"])
        return await provider_service.fetch_and_save_models(provider)

    @staticmethod
    def build_model(*, provider: dict, model_name: str):
        """Construct the Pydantic AI model from a stored provider record."""
        provider_type = str(provider.get("type") or "custom")
        protocol = provider_service.normalize_provider_protocol(
            str(provider.get("protocol") or ""), provider_type
        )
        base_url = str(provider.get("base_url") or "").rstrip("/")
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
        kwargs = {}
        if message_history is not None:
            kwargs["message_history"] = message_history
        if model_settings:
            kwargs["model_settings"] = model_settings
        if conversation_id:
            kwargs["conversation_id"] = conversation_id
        async with agent.run_stream_events(prompt, **kwargs) as stream:
            result = None
            async for event in stream:
                if getattr(event, "event_kind", "") == "agent_run_result":
                    result = event.result
                    continue
                internal = self._map_stream_event(event)
                if internal is not None:
                    await on_event(internal)
            if result is None:
                raise RuntimeError("Pydantic AI 未返回执行结果")
            return result

    @staticmethod
    def _accumulate_usage(total, result):
        usage_attr = getattr(result, "usage", None)
        usage = usage_attr() if callable(usage_attr) else usage_attr
        if usage is None:
            return total
        return usage if total is None else total + usage

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
        message_history: list | None = None,
        thinking_effort: str | None = None,
        workstep_tools: bool = False,
        session_id: str | None = None,
    ) -> tuple[Any, Any]:
        """Run the agent, injecting queued live messages between rounds."""
        from pydantic_ai import Agent
        from engines.pydantic_ai.filesystem import FileSystem
        from engines.pydantic_ai.skills import Skills

        root = Path(cwd).resolve()
        allowed_roots = [root]
        for directory in add_dirs or []:
            resolved = Path(directory).expanduser().resolve()
            if resolved not in allowed_roots:
                allowed_roots.append(resolved)

        file_system = FileSystem(allowed_roots)
        skills = Skills(project_root=root)

        harness_capabilities = self._harness_capabilities(root, session_id)
        agent = Agent(
            model,
            instructions=self._compose_instructions(root),
            capabilities=harness_capabilities or [],
        )

        def guard_plain(return_type):
            """Wrap a plain tool so failures become model-visible error values."""
            def decorate(func):
                @functools.wraps(func)
                def wrapped(*args, **kwargs):
                    try:
                        return func(*args, **kwargs)
                    except Exception as exc:
                        return self._tool_error_value(return_type, exc)
                return wrapped
            return decorate

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

        @agent.tool_plain
        @guard_plain(list[str])
        def list_files(path: str = ".", recursive: bool = False) -> list[str]:
            """List files below a project directory, capped at 500 entries."""
            return file_system.list_files(path, recursive=recursive)

        @agent.tool_plain
        @guard_plain(str)
        def read_file(
            path: str,
            start_line: int = 1,
            end_line: int = 400,
        ) -> str:
            """Read a UTF-8 project file within an inclusive line range."""
            return file_system.read(path, start_line=start_line, end_line=end_line)

        @agent.tool_plain
        @guard_plain(list[str])
        def search_files(query: str, path: str = ".") -> list[str]:
            """Search text in project files and return up to 100 line matches."""
            return file_system.search(query, path=path)

        @agent.tool_plain
        @guard_async(str)
        async def write_file(path: str, content: str) -> str:
            """Create or overwrite a UTF-8 project file (creates parent dirs)."""
            allowed = await self._request_permission(
                on_event,
                tool_name="write_file",
                title=f"写入 {path}",
                kind="edit",
                tool_input={"path": path},
            )
            if not allowed:
                return "用户拒绝写入文件"
            return file_system.write(path, content)

        @agent.tool_plain
        @guard_async(str)
        async def edit_file(
            path: str,
            old_string: str,
            new_string: str,
            replace_all: bool = False,
        ) -> str:
            """Replace old_string with new_string in a project file."""
            allowed = await self._request_permission(
                on_event,
                tool_name="edit_file",
                title=f"编辑 {path}",
                kind="edit",
                tool_input={"path": path, "replace_all": replace_all},
            )
            if not allowed:
                return "用户拒绝编辑文件"
            return file_system.edit(
                path,
                old_string,
                new_string,
                replace_all=replace_all,
            )

        @agent.tool_plain
        @guard_plain(list[str])
        def list_skills() -> list[str]:
            """List available project skills (SKILL.md in .claude/skills / .codex/skills / .workstep/skills under the project root)."""
            return [f"{skill.name} — {skill.description}" for skill in skills.list_skills()]

        @agent.tool_plain
        @guard_plain(str)
        def load_skill(name: str) -> str:
            """Load a skill's full instructions (SKILL.md body) by name."""
            return skills.load(name)

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
            options: list[str] | None = None,
            multiple: bool = False,
            allow_input: bool = True,
        ) -> dict[str, Any]:
            """Ask the user a required question and wait for their response.

            Use options for suggested choices, multiple for multi-select, and
            allow_input when the user may enter a custom answer.
            """
            return await self._ask_user(
                on_event,
                question=question,
                options=options,
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
                seeded_history = (
                    await self._harness_continue_history(root, session_id)
                    if harness_capabilities
                    else None
                )
                if seeded_history is None and message_history is not None:
                    seeded_history = message_history
                if seeded_history is not None:
                    stream_kwargs["message_history"] = seeded_history
                effort = resolve_thinking_effort(thinking_effort)
                if effort:
                    stream_kwargs["model_settings"] = {"thinking": effort}
                result = await self._stream_agent_run(
                    agent,
                    prompt=self._build_user_content(prompt, images),
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
                            **(
                                {"model_settings": {"thinking": effort}}
                                if effort
                                else {}
                            ),
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
        from pydantic_ai.messages import ImageUrl, TextPart

        parts = [TextPart(content=prompt)]
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
    def _compose_instructions(root: Path) -> str:
        """Build agent instructions: role, capability list, project agents.md."""
        parts = [
            "You are the built-in WorkStep agent.",
            f"The active project directory is {root}.",
            "You can read, search, and MODIFY code inside the project with "
            "list_files / read_file / search_files / write_file / edit_file.",
            "Project memory from .workstep/MEMORY.md has been injected into "
            "the prompt — treat it as read-only and do not modify the file.",
            "Use list_skills / load_skill for project skills — SKILL.md under "
            "the active project's .claude/skills, .codex/skills and .workstep/skills.",
            "When required information is missing, call ask_user and wait for "
            "the user's structured response instead of guessing.",
            "For multi-step work, call update_plan with the complete task list "
            "and update it whenever a task starts, completes, is added, or is removed.",
            "Return a concise final result when the request is complete.",
        ]
        for candidate in (root / "agents.md", root / "AGENTS.md"):
            if candidate.is_file():
                content = candidate.read_text(encoding="utf-8", errors="replace")
                parts.append(
                    f"--- Project instructions ({candidate.name}) ---\n"
                    f"{content[:50_000]}"
                )
                break
        return "\n\n".join(parts)

    @staticmethod
    def _json_safe(value: Any) -> Any:
        try:
            return json.loads(json.dumps(value, ensure_ascii=False, default=str))
        except (TypeError, ValueError):
            return str(value)

    @classmethod
    def _map_stream_event(cls, event) -> InternalEvent | None:
        """Map Pydantic AI agent events without duplicating completed parts."""
        event_kind = getattr(event, "event_kind", "")

        if event_kind == "part_start":
            part = event.part
            part_kind = getattr(part, "part_kind", "")
            content = getattr(part, "content", "")
            if part_kind == "text" and content:
                return InternalEvent(
                    type="agent_message_chunk",
                    data={"content": {"text": content}},
                )
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
                return InternalEvent(
                    type="agent_message_chunk",
                    data={"content": {"text": content}},
                )
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

    # --- pydantic-ai-harness 扩展（上下文压缩 / 会话持久化） ---

    @staticmethod
    def _harness_enabled() -> bool:
        """Whether the harness extension is on (config auto + installed)."""
        config = config_store.get_pydantic_ai_engine_config()
        if str(config.get("harness") or "auto") == "off":
            return False
        try:
            import pydantic_ai_harness  # noqa: F401

            return True
        except Exception:
            return False

    @staticmethod
    def _harness_store(root: Path):
        """SQLite StepPersistence store under the project .workstep dir."""
        from pydantic_ai_harness.step_persistence import SqliteStepStore

        workstep_dir = root / ".workstep"
        workstep_dir.mkdir(parents=True, exist_ok=True)
        return SqliteStepStore(database=workstep_dir / "harness_runs.db")

    @classmethod
    def _harness_capabilities(
        cls,
        root: Path,
        session_id: str | None,
    ) -> list | None:
        """Harness capabilities for this run, or None when disabled."""
        if not cls._harness_enabled() or root is None or not root.is_dir():
            return None
        try:
            from pydantic_ai_harness.compaction import (
                ClearToolResults,
                SummarizingCompaction,
                TieredCompaction,
                WarnNearLimits,
            )
            from pydantic_ai_harness.step_persistence import StepPersistence
        except Exception:
            return None
        return [
            TieredCompaction(
                target_fraction=0.9,
                tiers=[
                    ClearToolResults(max_messages=200, keep_pairs=10),
                    SummarizingCompaction(
                        max_messages=120,
                        keep_messages=30,
                        receipts=True,
                    ),
                ],
            ),
            WarnNearLimits(max_context_fraction=0.85),
            StepPersistence(
                store=cls._harness_store(root),
                agent_name="workstep",
            ),
        ]

    @classmethod
    async def _harness_continue_history(
        cls,
        root: Path,
        session_id: str | None,
    ) -> list | None:
        """Load the persisted snapshot for this session, when available."""
        if (
            not session_id
            or not cls._harness_enabled()
            or root is None
            or not root.is_dir()
        ):
            return None
        try:
            from pydantic_ai_harness.step_persistence import continue_run

            store = cls._harness_store(root)
            runs = await store.list_runs(conversation_id=session_id)
            if not runs:
                return None
            return list(await continue_run(store, run_id=runs[-1].run_id))
        except Exception:
            return None

    @staticmethod
    def _open_receipt_scope(enabled: bool):
        """Open a compaction-receipt scope for the run (None when disabled)."""
        if not enabled:
            return None
        try:
            from pydantic_ai_harness.compaction._receipts import open_receipt_scope

            return open_receipt_scope()
        except Exception:
            return None

    @staticmethod
    async def _drain_compaction_receipts(scope, on_event) -> None:
        """Emit ``compacted`` events for receipts recorded during the run."""
        if scope is None:
            return
        try:
            from pydantic_ai_harness.compaction._receipts import (
                drain_receipts,
                reset_receipt_scope,
            )

            receipts = []
            try:
                receipts = drain_receipts()
            finally:
                reset_receipt_scope(scope)
            for receipt in receipts:
                await on_event(compacted_event(summary=(
                    f"{receipt.strategy} 压缩：丢弃 {receipt.dropped_messages} "
                    f"条消息、约 {receipt.dropped_tokens} tokens"
                )))
        except Exception:
            logger.exception("Failed to drain compaction receipts")

    async def spawn(
        self,
        prompt: str,
        cwd: str,
        model: str | None = None,
        add_dirs: list[str] | None = None,
        session_id: str | None = None,
        live_message_queue: asyncio.Queue | None = None,
        images: list[EngineImage] | None = None,
        message_history: list | None = None,
        report_engine_state: bool = False,
        thinking_effort: str | None = None,
        config_overrides: dict | None = None,
        workstep_tools: bool = False,
    ) -> AsyncIterator[InternalEvent]:
        config = self.merge_config_overrides(
            config_store.get_pydantic_ai_engine_config(), config_overrides
        )
        model_name = model or config["model"]
        try:
            provider_runtime = self.resolve_provider_runtime(
                provider_id=config["provider_id"], model=model_name
            )
        except ValueError as exc:
            yield InternalEvent(type="error", data={"message": str(exc)})
            return
        model_name = provider_runtime.model
        provider = config_store.get_provider(provider_runtime.provider_id)
        if provider is None or not provider.get("base_url") or not model_name:
            yield InternalEvent(
                type="error",
                data={"message": "Pydantic AI 尚未配置供应商和模型"},
            )
            return

        self._running = True
        # 进程内 Agent 没有 CLI 会话概念：session_id 作为会话标识（供任务记录
        # 与前端展示，同一对话保持稳定），跨轮上下文由 message_history 承载。
        session_uuid = session_id or str(uuid.uuid4())
        self._active_session_id = session_uuid
        self._interaction_permission_grants.clear()
        self._interaction_permission_rejects.clear()
        yield InternalEvent(type="session_started", data={"session_id": session_uuid})
        yield InternalEvent(type="status", data={"status": "running"})
        seeded_history: list | None = None
        if message_history:
            try:
                from pydantic_ai.messages import ModelMessagesTypeAdapter

                seeded_history = ModelMessagesTypeAdapter.validate_python(
                    message_history
                )
            except Exception:
                logger.exception(
                    "Failed to restore Pydantic AI message history; "
                    "starting a fresh context"
                )
        agent_task: asyncio.Task | None = None
        try:
            loaded_model = self.build_model(
                provider=provider,
                model_name=model_name,
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
            }
            if thinking_effort:
                run_kwargs["thinking_effort"] = thinking_effort
            if workstep_tools:
                run_kwargs["workstep_tools"] = True
            if seeded_history is not None:
                run_kwargs["message_history"] = seeded_history
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
                    continue
                if event.type == "agent_message_chunk":
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

            if report_engine_state:
                state = None
                try:
                    from pydantic_ai.messages import ModelMessagesTypeAdapter

                    state = ModelMessagesTypeAdapter.dump_python(
                        result.all_messages(),
                        mode="json",
                    )
                except Exception:
                    logger.exception(
                        "Failed to serialize Pydantic AI message history"
                    )
                if state is not None:
                    yield InternalEvent(
                        type="engine_state",
                        data={"state": state},
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
                yield usage_update_event(usage_data)
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
    def supports_live_stage_message(self) -> bool:
        return True

    @property
    def supports_message_history(self) -> bool:
        """The in-process agent rebuilds context from serialized messages."""
        return True

    @property
    def supports_thinking_effort(self) -> bool:
        """``model_settings.thinking`` maps to a per-turn reasoning effort."""
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
