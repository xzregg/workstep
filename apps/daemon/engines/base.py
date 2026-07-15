"""BaseLLMEngine — abstract interface for all LLM engines."""

from abc import ABC, abstractmethod
from typing import AsyncIterator

from engines.events import InternalEvent


class BaseLLMEngine(ABC):
    """Abstract base class for all LLM engine implementations.

    Each engine (Claude Code, Codex, Hermes, etc.) implements this interface.
    Adding a new engine = creating one file that implements these methods.
    """

    # --- Engine discovery ---

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
    def resolve_binary() -> str:
        """Resolve the actual binary path (env var → PATH → fallback)."""

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
