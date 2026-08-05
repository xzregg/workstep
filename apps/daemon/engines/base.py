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
    supports_sessions: bool = False
    supports_tool_approval: bool = False


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
            supports_sessions=self.supports_sessions,
            supports_tool_approval=self.supports_tool_approval,
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

    # --- ACP-aligned session lifecycle (session/new, load, list, resume, ...) ---

    @property
    def supports_sessions(self) -> bool:
        """Whether this engine exposes ACP-style persistent sessions.

        Engines backed by the ACP protocol (session/new, session/load,
        session/resume, ...) return True here.
        """
        return False

    async def create_session(
        self,
        cwd: str,
        add_dirs: list[str] | None = None,
        mcp_servers: list | None = None,
    ) -> str | None:
        """session/new — create a fresh session, return its session id.

        Returns None when the engine has no session concept.
        """
        return None

    async def load_session(
        self,
        session_id: str,
        cwd: str,
        add_dirs: list[str] | None = None,
        mcp_servers: list | None = None,
    ) -> bool:
        """session/load — restore a persisted session's context/memory/config."""
        return False

    async def list_sessions(self, cwd: str | None = None) -> list[str]:
        """session/list — list local archived session ids."""
        return []

    async def resume_session(
        self,
        session_id: str,
        cwd: str,
        add_dirs: list[str] | None = None,
        mcp_servers: list | None = None,
    ) -> bool:
        """session/resume — restore a session and replay its history."""
        return False

    async def close_session(self, session_id: str, cwd: str | None = None) -> None:
        """session/close — close a session and release its resources."""
        return None

    async def cancel_session(self, session_id: str, cwd: str | None = None) -> None:
        """session/cancel — force-stop current reasoning / tool execution."""
        return None

    async def set_config_option(
        self,
        config_id: str,
        value: str | bool,
        session_id: str | None = None,
    ) -> None:
        """session/set_config_option — change model / cwd / max turns / permission mode."""
        return None

    async def reset_options(self, session_id: str | None = None) -> None:
        """session/reset-options — restore process-global defaults."""
        return None

    # --- Tool approval (tool_call → tool_approve → tool_result) ---

    @property
    def supports_tool_approval(self) -> bool:
        """Whether pending tool calls can be approved/rejected via approve_tool."""
        return False

    async def approve_tool(self, tool_use_id: str, approved: bool = True) -> None:
        """tool_approve — accept or reject a pending tool_call (request_permission)."""
        return None

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
