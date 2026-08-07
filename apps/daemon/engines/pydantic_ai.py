"""PydanticAIEngine — built-in Python agent powered by Pydantic AI."""

import asyncio
from importlib import metadata, util
import json
import logging
from pathlib import Path
from typing import Any, AsyncIterator, Awaitable, Callable

from engines.api import APIEngine
from engines.base import BaseLLMEngine, EngineModel
from engines.schema import EngineImage
from engines.events import InternalEvent, normalize_token_usage
from engines.schema import (
    EngineConfigField,
    EngineConfigOption,
    validate_api_base_url,
)
from services.config import config_store

logger = logging.getLogger(__name__)


class PydanticAIEngine(BaseLLMEngine):
    """Built-in agent that lets Pydantic AI load the configured provider."""

    # 每轮结束后等待插入消息的窗口，避免任务收尾时消息静默丢失
    _live_message_wait_seconds: float = 1.5

    def __init__(self):
        self._running = False
        self._run_task: asyncio.Task | None = None

    @property
    def supports_vision(self) -> bool:
        """Pydantic AI passes image parts natively to the provider."""
        return True

    @staticmethod
    def is_installed() -> bool:
        return util.find_spec("pydantic_ai") is not None

    @staticmethod
    def is_configured() -> bool:
        config = config_store.get_pydantic_ai_engine_config()
        return bool(config["base_url"] and config["model"])

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
        return [
            EngineConfigField(
                key="provider",
                label="Provider 类型",
                type="select",
                options=(
                    EngineConfigOption("openai", "OpenAI-compatible"),
                    EngineConfigOption("anthropic", "Anthropic Messages"),
                ),
                required=True,
            ),
            EngineConfigField(
                key="base_url",
                label="Provider 地址",
                type="text",
                placeholder="https://api.openai.com/v1",
                required=True,
                help="远程地址必须使用 HTTPS；Ollama 等本机接口可使用 localhost HTTP。",
            ),
            EngineConfigField(
                key="api_key",
                label="API Key",
                type="password",
                placeholder="可选，本地无鉴权接口可留空",
                sensitive=True,
            ),
        ]

    def get_config_values(self) -> dict:
        config = config_store.get_pydantic_ai_engine_config()
        return {
            "provider": config["provider"],
            "base_url": config["base_url"],
            "api_key": "",
        }

    def get_config_secrets(self) -> dict[str, bool]:
        config = config_store.get_pydantic_ai_engine_config()
        return {"api_key": bool(config["api_key"])}

    async def save_config_values(
        self,
        values: dict,
        clear: dict[str, bool] | None = None,
        confirmed: dict[str, bool] | None = None,
    ) -> None:
        current = config_store.get_pydantic_ai_engine_config()
        provider = str(values.get("provider") or current["provider"]).strip().lower()
        if provider not in {"openai", "anthropic"}:
            raise ValueError("不支持的 Provider 类型")
        base_url = str(values.get("base_url") or "").strip().rstrip("/")
        if not base_url:
            raise ValueError("Provider 地址不能为空")
        url_error = validate_api_base_url(base_url)
        if url_error:
            raise ValueError(url_error)

        clear = clear or {}
        api_key: str | None = None
        if clear.get("api_key"):
            api_key = ""
        else:
            new_key = str(values.get("api_key") or "").strip()
            if new_key:
                api_key = new_key

        config_store.set_pydantic_ai_engine_config(
            provider=provider,
            base_url=base_url,
            api_key=api_key,
            model=str(current["model"]),
        )

    def reveal_config_value(self, key: str) -> str | None:
        if key == "api_key":
            return config_store.get_pydantic_ai_engine_config().get("api_key") or None
        return None

    async def list_models(self, cwd: str) -> list[EngineModel]:
        config = config_store.get_pydantic_ai_engine_config()
        return await self.list_models_for_config(
            provider=config["provider"],
            base_url=config["base_url"],
            api_key=config["api_key"],
        )

    async def list_models_for_config(
        self,
        *,
        provider: str,
        base_url: str,
        api_key: str,
    ) -> list[EngineModel]:
        return await APIEngine().list_models_for_config(
            provider=provider,
            base_url=base_url,
            api_key=api_key,
        )

    @staticmethod
    def build_model(
        *,
        provider: str,
        base_url: str,
        api_key: str,
        model_name: str,
    ):
        """Construct the Pydantic AI model and provider from stored BYOK config."""
        if provider == "anthropic":
            from pydantic_ai.models.anthropic import AnthropicModel
            from pydantic_ai.providers.anthropic import AnthropicProvider

            return AnthropicModel(
                model_name,
                provider=AnthropicProvider(
                    base_url=base_url,
                    api_key=api_key or "not-needed",
                ),
            )

        from pydantic_ai.models.openai import OpenAIChatModel
        from pydantic_ai.providers.openai import OpenAIProvider

        return OpenAIChatModel(
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
    ):
        """Run one agent round and forward mapped internal events."""
        kwargs = {}
        if message_history is not None:
            kwargs["message_history"] = message_history
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
    ) -> tuple[Any, Any]:
        """Run the agent, injecting queued live messages between rounds."""
        from pydantic_ai import Agent
        from pydantic_ai_harness import FileSystem, Memory, Skills

        root = Path(cwd).resolve()
        allowed_roots = [root]
        for directory in add_dirs or []:
            resolved = Path(directory).expanduser().resolve()
            if resolved not in allowed_roots:
                allowed_roots.append(resolved)

        file_system = FileSystem(allowed_roots)
        skills = Skills(project_root=root)
        memory = Memory(root / ".workstep" / "MEMORY.md")

        agent = Agent(
            model,
            instructions=self._compose_instructions(root),
        )

        @agent.tool_plain
        def list_files(path: str = ".", recursive: bool = False) -> list[str]:
            """List files below a project directory, capped at 500 entries."""
            return file_system.list_files(path, recursive=recursive)

        @agent.tool_plain
        def read_file(
            path: str,
            start_line: int = 1,
            end_line: int = 400,
        ) -> str:
            """Read a UTF-8 project file within an inclusive line range."""
            return file_system.read(path, start_line=start_line, end_line=end_line)

        @agent.tool_plain
        def search_files(query: str, path: str = ".") -> list[str]:
            """Search text in project files and return up to 100 line matches."""
            return file_system.search(query, path=path)

        @agent.tool_plain
        def write_file(path: str, content: str) -> str:
            """Create or overwrite a UTF-8 project file (creates parent dirs)."""
            return file_system.write(path, content)

        @agent.tool_plain
        def edit_file(
            path: str,
            old_string: str,
            new_string: str,
            replace_all: bool = False,
        ) -> str:
            """Replace old_string with new_string in a project file."""
            return file_system.edit(
                path,
                old_string,
                new_string,
                replace_all=replace_all,
            )

        @agent.tool_plain
        def remember(key: str, value: str) -> str:
            """Store a fact in durable project memory (survives restarts)."""
            memory.set(key, value)
            return f"已保存: {key}"

        @agent.tool_plain
        def recall(key: str) -> str:
            """Read a fact from durable project memory."""
            stored = memory.get(key)
            if stored is None:
                return f"未找到: {key}"
            return json.dumps(stored, ensure_ascii=False)

        @agent.tool_plain
        def list_skills() -> list[str]:
            """List available local skills (SKILL.md in the project .claude/skills / .codex/skills and home skill dirs)."""
            return [f"{skill.name} — {skill.description}" for skill in skills.list_skills()]

        @agent.tool_plain
        def load_skill(name: str) -> str:
            """Load a skill's full instructions (SKILL.md body) by name."""
            return skills.load(name)

        total_usage = None
        async with agent:
            result = await self._stream_agent_run(
                agent,
                prompt=self._build_user_content(prompt, images),
                on_event=on_event,
            )
            total_usage = self._accumulate_usage(total_usage, result)
            while live_message_queue is not None:
                live_items = self._take_live_items(live_message_queue)
                if not live_items:
                    # 轮间等待窗口：任务收尾时刚发出的插入消息不应静默丢失
                    try:
                        first = await asyncio.wait_for(
                            live_message_queue.get(),
                            timeout=self._live_message_wait_seconds,
                        )
                    except asyncio.TimeoutError:
                        for message_id, _ in self._take_live_items(
                            live_message_queue
                        ):
                            await on_event(InternalEvent(type="live_message", data={
                                "message_id": message_id,
                                "status": "error",
                                "detail": "引擎执行已结束，无法接收新消息",
                            }))
                        break
                    live_items = [first]
                    live_items.extend(self._take_live_items(live_message_queue))
                injected = "\n\n".join(content for _, content in live_items)
                result = await self._stream_agent_run(
                    agent,
                    prompt=injected,
                    on_event=on_event,
                    message_history=result.all_messages(),
                )
                total_usage = self._accumulate_usage(total_usage, result)
                for message_id, _ in live_items:
                    await on_event(InternalEvent(type="live_message", data={
                        "message_id": message_id,
                        "status": "delivered",
                        "detail": "",
                    }))
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
            "Project memory lives in .workstep/MEMORY.md — read it before "
            "starting, and keep it updated with remember / recall.",
            "Use list_skills / load_skill for local skills (Claude Code "
            ".claude/skills, Codex .codex/skills — project dirs first, then "
            "~/.claude/skills, ~/.codex/skills, ~/.agents/skills).",
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
                return InternalEvent(type="text_delta", data={"delta": content})
            if part_kind == "thinking" and content:
                return InternalEvent(type="thinking_delta", data={"delta": content})
            if part_kind == "builtin-tool-call":
                return InternalEvent(type="tool_use", data={
                    "id": getattr(part, "tool_call_id", ""),
                    "name": getattr(part, "tool_name", ""),
                    "input": cls._json_safe(getattr(part, "args", {})),
                })
            if part_kind == "builtin-tool-return":
                return InternalEvent(type="tool_result", data={
                    "tool_use_id": getattr(part, "tool_call_id", ""),
                    "content": cls._json_safe(content),
                    "is_error": getattr(part, "outcome", "success") != "success",
                })

        if event_kind == "part_delta":
            delta = event.delta
            delta_kind = getattr(delta, "part_delta_kind", "")
            content = getattr(delta, "content_delta", "")
            if delta_kind == "text" and content:
                return InternalEvent(type="text_delta", data={"delta": content})
            if delta_kind == "thinking" and content:
                return InternalEvent(type="thinking_delta", data={"delta": content})

        if event_kind in {"function_tool_call", "output_tool_call"}:
            part = event.part
            return InternalEvent(type="tool_use", data={
                "id": getattr(part, "tool_call_id", ""),
                "name": getattr(part, "tool_name", ""),
                "input": cls._json_safe(getattr(part, "args", {})),
            })

        if event_kind in {"function_tool_result", "output_tool_result"}:
            part = event.part
            content = getattr(event, "content", None)
            if content is None:
                content = getattr(part, "content", "")
            return InternalEvent(type="tool_result", data={
                "tool_use_id": getattr(part, "tool_call_id", ""),
                "content": cls._json_safe(content),
                "is_error": (
                    getattr(part, "part_kind", "") == "retry-prompt"
                    or getattr(part, "outcome", "success") != "success"
                ),
            })

        return None

    async def spawn(
        self,
        prompt: str,
        cwd: str,
        model: str | None = None,
        add_dirs: list[str] | None = None,
        session_id: str | None = None,
        live_message_queue: asyncio.Queue | None = None,
        images: list[EngineImage] | None = None,
    ) -> AsyncIterator[InternalEvent]:
        config = config_store.get_pydantic_ai_engine_config()
        model_name = model or config["model"]
        if not config["base_url"] or not model_name:
            yield InternalEvent(
                type="error",
                data={"message": "Pydantic AI 尚未配置 Provider 地址和模型"},
            )
            return

        self._running = True
        yield InternalEvent(type="status", data={"status": "running"})
        agent_task: asyncio.Task | None = None
        try:
            loaded_model = self.build_model(
                provider=config["provider"],
                base_url=config["base_url"],
                api_key=config["api_key"],
                model_name=model_name,
            )
            event_queue: asyncio.Queue[InternalEvent] = asyncio.Queue()
            agent_task = asyncio.create_task(
                self._run_agent(
                    prompt=prompt,
                    cwd=cwd,
                    add_dirs=add_dirs,
                    model=loaded_model,
                    on_event=event_queue.put,
                    live_message_queue=live_message_queue,
                    images=images,
                )
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
                if event.type == "text_delta":
                    emitted_text = True
                yield event

            result, total_usage = await agent_task
            if not emitted_text:
                output = str(getattr(result, "output", ""))
                if output:
                    yield InternalEvent(type="text_delta", data={"delta": output})

            if total_usage is not None:
                usage_data = normalize_token_usage({
                    "input_tokens": getattr(total_usage, "input_tokens", 0),
                    "output_tokens": getattr(total_usage, "output_tokens", 0),
                    "total_tokens": getattr(total_usage, "total_tokens", 0),
                    "cache_write_tokens": getattr(total_usage, "cache_write_tokens", 0),
                    "cache_read_tokens": getattr(total_usage, "cache_read_tokens", 0),
                })
                usage_data["requests"] = getattr(total_usage, "requests", 0)
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
                yield InternalEvent(type="usage", data=usage_data)
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
    def supports_resume(self) -> bool:
        return False

    @property
    def supports_interactive(self) -> bool:
        return False

    def build_resume_params(self, session_id: str) -> dict:
        return {}
