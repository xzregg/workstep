"""PydanticAIEngine — built-in Python agent powered by Pydantic AI."""

import asyncio
from importlib import metadata, util
import json
import logging
from pathlib import Path
from typing import Any, AsyncIterator, Awaitable, Callable

from engines.api import APIEngine
from engines.base import BaseLLMEngine, EngineModel
from engines.events import InternalEvent, normalize_token_usage
from services.config import config_store

logger = logging.getLogger(__name__)


class PydanticAIEngine(BaseLLMEngine):
    """Built-in agent that lets Pydantic AI load the configured provider."""

    def __init__(self):
        self._running = False
        self._run_task: asyncio.Task | None = None

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

    async def _run_agent(
        self,
        *,
        prompt: str,
        cwd: str,
        add_dirs: list[str] | None,
        model,
        on_event: Callable[[InternalEvent], Awaitable[None]],
    ):
        from pydantic_ai import Agent

        root = Path(cwd).resolve()
        allowed_roots = [root]
        for directory in add_dirs or []:
            resolved = Path(directory).expanduser().resolve()
            if resolved not in allowed_roots:
                allowed_roots.append(resolved)

        def resolve_path(raw_path: str) -> Path:
            requested = Path(raw_path).expanduser()
            candidates = (
                [requested.resolve()]
                if requested.is_absolute()
                else [(root / requested).resolve()]
            )
            for candidate in candidates:
                if any(candidate.is_relative_to(item) for item in allowed_roots):
                    return candidate
            raise ValueError("路径不在允许读取的项目目录中")

        agent = Agent(
            model,
            instructions=(
                "You are the built-in WorkStep agent. "
                f"The active project directory is {root}. "
                "Follow the user's request and return a concise final result."
            ),
        )

        @agent.tool_plain
        def list_files(path: str = ".", recursive: bool = False) -> list[str]:
            """List files below a project directory, capped at 500 entries."""
            directory = resolve_path(path)
            if not directory.is_dir():
                raise ValueError(f"目录不存在: {path}")
            iterator = directory.rglob("*") if recursive else directory.iterdir()
            files = []
            for item in iterator:
                if item.is_file():
                    files.append(str(item.relative_to(root) if item.is_relative_to(root) else item))
                if len(files) >= 500:
                    break
            return sorted(files)

        @agent.tool_plain
        def read_file(
            path: str,
            start_line: int = 1,
            end_line: int = 400,
        ) -> str:
            """Read a UTF-8 project file within an inclusive line range."""
            file_path = resolve_path(path)
            if not file_path.is_file():
                raise ValueError(f"文件不存在: {path}")
            if file_path.stat().st_size > 2_000_000:
                raise ValueError("文件超过 2 MB，请缩小读取范围或使用搜索工具")
            if start_line < 1 or end_line < start_line:
                raise ValueError("行号范围无效")
            lines = file_path.read_text(encoding="utf-8").splitlines()
            return "\n".join(lines[start_line - 1:end_line])

        @agent.tool_plain
        def search_files(query: str, path: str = ".") -> list[str]:
            """Search text in project files and return up to 100 line matches."""
            directory = resolve_path(path)
            if not directory.is_dir():
                raise ValueError(f"目录不存在: {path}")
            matches = []
            for file_path in directory.rglob("*"):
                if not file_path.is_file() or file_path.stat().st_size > 1_000_000:
                    continue
                try:
                    lines = file_path.read_text(encoding="utf-8").splitlines()
                except (OSError, UnicodeDecodeError):
                    continue
                for line_number, line in enumerate(lines, 1):
                    if query in line:
                        display_path = (
                            file_path.relative_to(root)
                            if file_path.is_relative_to(root)
                            else file_path
                        )
                        matches.append(f"{display_path}:{line_number}: {line[:500]}")
                        if len(matches) >= 100:
                            return matches
            return matches

        async with agent:
            async with agent.run_stream_events(prompt) as stream:
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

            result = await agent_task
            if not emitted_text:
                output = str(getattr(result, "output", ""))
                if output:
                    yield InternalEvent(type="text_delta", data={"delta": output})

            usage_attr = getattr(result, "usage", None)
            usage = usage_attr() if callable(usage_attr) else usage_attr
            if usage is not None:
                usage_data = normalize_token_usage({
                    "input_tokens": getattr(usage, "input_tokens", 0),
                    "output_tokens": getattr(usage, "output_tokens", 0),
                    "total_tokens": getattr(usage, "total_tokens", 0),
                    "cache_write_tokens": getattr(usage, "cache_write_tokens", 0),
                    "cache_read_tokens": getattr(usage, "cache_read_tokens", 0),
                })
                usage_data["requests"] = getattr(usage, "requests", 0)
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
    def supports_resume(self) -> bool:
        return False

    @property
    def supports_interactive(self) -> bool:
        return False

    def build_resume_params(self, session_id: str) -> dict:
        return {}
