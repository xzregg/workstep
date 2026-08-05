"""BaseLLMEngine — abstract interface for all LLM engines."""

import asyncio
import time
from abc import ABC, abstractmethod
from contextlib import suppress
from dataclasses import dataclass
from typing import AsyncIterator, ClassVar

from engines.events import InternalEvent


@dataclass(frozen=True)
class EngineTestResult:
    """Result returned by the common engine connectivity test."""

    success: bool
    message: str
    duration_ms: int


@dataclass(frozen=True)
class EngineModel:
    """A model exposed by an engine adapter."""

    id: str
    label: str
    description: str | None = None


@dataclass(frozen=True)
class EngineCapabilities:
    """Capabilities consumed by coordinator and workflow callers."""

    supports_coordinator: bool
    supports_resume: bool
    supports_tool_disable: bool
    supports_native_schema: bool
    supports_live_stage_message: bool


class BaseLLMEngine(ABC):
    """Abstract base class for all LLM engine implementations.

    Each engine (Claude Code, Codex, Hermes, etc.) implements this interface.
    Adding a new engine = creating one file that implements these methods.
    """

    _binary_override: ClassVar[str | None] = None

    # --- Engine discovery ---

    @classmethod
    def set_binary_override(cls, path: str | None) -> None:
        cls._binary_override = path or None

    @classmethod
    def get_binary_override(cls) -> str | None:
        return cls._binary_override

    @staticmethod
    @abstractmethod
    def is_installed() -> bool:
        """Check if the CLI binary is installed locally."""

    @staticmethod
    @abstractmethod
    def get_version() -> str | None:
        """Get installed version string, or None if not installed."""

    @staticmethod
    @abstractmethod
    def resolve_binary() -> str | None:
        """Resolve the actual binary path (env var → PATH → fallback)."""

    @staticmethod
    def is_configured() -> bool:
        """Whether this installed adapter has enough configuration to run."""
        return True

    # --- Execution ---

    @abstractmethod
    async def spawn(
        self,
        prompt: str,
        cwd: str,
        model: str | None = None,
        add_dirs: list[str] | None = None,
        session_id: str | None = None,
    ) -> AsyncIterator[InternalEvent]:
        """Start subprocess, stream unified internal events.

        Yields InternalEvent objects as the engine produces output.
        """

    @abstractmethod
    async def stop(self) -> None:
        """Terminate the running subprocess."""

    async def test_connection(
        self,
        cwd: str,
        timeout_seconds: float = 30,
    ) -> EngineTestResult:
        """Run a harmless minimal conversation through this engine.

        Adapters with a cheaper native health check may override this method.
        """
        started = time.monotonic()
        text_parts: list[str] = []
        errors: list[str] = []

        async def collect_events():
            async for event in self.spawn(
                prompt=(
                    "Reply with WORKSTEP_ENGINE_OK only. "
                    "Do not use tools and do not modify files."
                ),
                cwd=cwd,
            ):
                if event.type == "text_delta":
                    text_parts.append(str(event.data.get("delta", "")))
                elif event.type == "error":
                    errors.append(
                        str(
                            event.data.get("message")
                            or event.data.get("error")
                            or "引擎返回错误"
                        )
                    )

        try:
            await asyncio.wait_for(collect_events(), timeout=timeout_seconds)
        except asyncio.TimeoutError:
            with suppress(Exception):
                await self.stop()
            return EngineTestResult(
                success=False,
                message=f"测试超时（{timeout_seconds:g} 秒）",
                duration_ms=round((time.monotonic() - started) * 1000),
            )
        except Exception as exc:
            with suppress(Exception):
                await self.stop()
            return EngineTestResult(
                success=False,
                message=str(exc) or "引擎启动失败",
                duration_ms=round((time.monotonic() - started) * 1000),
            )

        duration_ms = round((time.monotonic() - started) * 1000)
        if errors:
            return EngineTestResult(False, errors[0], duration_ms)
        if not "".join(text_parts).strip():
            return EngineTestResult(False, "引擎未返回文本", duration_ms)
        return EngineTestResult(True, "连接和对话测试通过", duration_ms)

    async def list_models(self, cwd: str) -> list[EngineModel]:
        """Return models selectable for this adapter.

        An empty list means the adapter only exposes its own configured default.
        """
        return []

    @property
    def capabilities(self) -> EngineCapabilities:
        return EngineCapabilities(
            supports_coordinator=self.is_configured(),
            supports_resume=self.supports_resume,
            supports_tool_disable=True,
            supports_native_schema=False,
            supports_live_stage_message=False,
        )

    async def spawn_coordinator(
        self,
        prompt: str,
        cwd: str,
        model: str | None = None,
        session_id: str | None = None,
    ) -> AsyncIterator[InternalEvent]:
        """Run a no-tools coordinator turn through this adapter seam."""
        guarded_prompt = (
            "You are a read-only task coordinator. Do not call tools, execute "
            "commands, or modify files. Return only the requested JSON.\n\n"
            f"{prompt}"
        )
        async for event in self.spawn(
            prompt=guarded_prompt,
            cwd=cwd,
            model=model,
            session_id=session_id,
        ):
            yield event

    # --- Interaction ---

    @abstractmethod
    async def inject_response(self, tool_use_id: str, content: str) -> None:
        """Inject user response mid-execution (AskUserQuestion / permission)."""

    # --- Session resume ---

    @property
    @abstractmethod
    def supports_resume(self) -> bool:
        """Whether this engine supports session resume."""

    @property
    @abstractmethod
    def supports_interactive(self) -> bool:
        """Whether this engine supports mid-execution interaction."""

    @abstractmethod
    def build_resume_params(self, session_id: str) -> dict:
        """Build parameters for session resume."""
