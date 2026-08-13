"""BaseLLMEngine — 引擎自定义函数基类（部署 / 工具 / 能力声明）。

所有引擎继承 ``AcpEngineBase``（ACP 协议基类，见 ``acp_base.py``）；本类承载与协议无关的自定义函数：安装、版本、配置表单、模型枚举、能力声明等。新接入引擎必须实现本类的抽象方法（is_installed / get_version / resolve_binary）。"""

import asyncio
import logging
import shutil
import sys
import time
from abc import ABC, abstractmethod
from contextlib import suppress
from dataclasses import dataclass
import importlib.util
from collections.abc import Awaitable, Callable
from typing import Any, AsyncIterator, ClassVar

logger = logging.getLogger(__name__)

from engines.core.events import InternalEvent
from engines.core.schema import EngineConfigField, EngineImage


# WorkStep thinking-effort values. ``"auto"`` means "let the engine decide":
# no per-turn effort is sent, and engine-config effort defaults are ignored so
# the model/provider picks. The remaining levels map to each engine's own
# supported set (engines without a level map to the closest one, e.g. Claude
# ``minimal -> low``, pydantic-ai ``xhigh -> high`` on providers without it).
THINKING_EFFORT_LEVELS = ("minimal", "low", "medium", "high", "xhigh")
THINKING_EFFORT_VALUES = ("auto",) + THINKING_EFFORT_LEVELS


def resolve_thinking_effort(
    value: str | None,
    engine_default: str | None = None,
) -> str | None:
    """Resolve one thinking-effort value into the engine-level override.

    - ``"auto"`` → ``None``: never send a forced level (model decides).
    - ``""`` / ``None`` → falls back to ``engine_default`` (follow engine
      config); an unusable default also resolves to ``None``.
    - ``minimal/low/medium/high/xhigh`` → that level, passed through.
    - anything else → ``engine_default`` (defensive; validation upstream
      already rejects unknown values).
    """
    value = (value or "").strip().lower()
    if value == "auto":
        return None
    if value in THINKING_EFFORT_LEVELS:
        return value
    default = (engine_default or "").strip().lower()
    if default == "auto":
        return None
    return default if default in THINKING_EFFORT_LEVELS else None


async def sdk_turn_watchdog(
    turn_ended: asyncio.Event,
    on_idle: Callable[[], None],
    disconnect: Callable[[], Awaitable[None]] | None = None,
    stream_closed: asyncio.Event | None = None,
    escalate_seconds: float = 15.0,
    pending_injection: Callable[[], bool] | None = None,
) -> None:
    """End an SDK turn deterministically; only a pending insert queue keeps the
    session open.

    SDK engines (Claude / Qoder) keep the session open after responding, so a
    finished stage would hang forever waiting for a stream-end event. After a
    turn's ``result`` arrives, the watchdog closes the session immediately
    (``on_idle()`` → stdin EOF → CLI exits gracefully → stream-end frame →
    stage finalizes) **unless** the live insert queue still has pending
    messages (``pending_injection()``). A pending message is consumed into a
    follow-up turn; the watchdog waits for that turn's ``result`` and
    re-evaluates. No grace window is applied: a finished reply ends the stage
    regardless of whether the turn carried an injection, and long follow-up
    turns are never killed (only the runner's stage-level idle watchdog bounds
    them).

    If ``stream_closed`` is provided, the watchdog waits for the stream to
    actually close (up to ``escalate_seconds``) and only then falls back to
    ``disconnect()``; without it, ``disconnect()`` runs after ``on_idle()`` as
    before.
    """

    async def _close() -> None:
        on_idle()
        if disconnect is None:
            return
        if stream_closed is not None:
            try:
                # 优雅收尾优先：等流真正关闭，超时才强制 disconnect，
                # 避免 disconnect 抢在 stdin EOF 收尾前执行。
                await asyncio.wait_for(
                    stream_closed.wait(), timeout=escalate_seconds
                )
                return
            except asyncio.TimeoutError:
                pass
        try:
            await asyncio.wait_for(disconnect(), timeout=escalate_seconds)
        except asyncio.TimeoutError:
            logger.warning(
                "SDK session did not close after turn grace window"
            )

    while True:
        await turn_ended.wait()
        turn_ended.clear()
        if pending_injection is None or not pending_injection():
            # 插入队列已空：回复即结尾，立即收尾（不论本回合是否插入过消息，
            # 也不等待任何宽限期）。
            await _close()
            return
        # 队列还有待注入消息：保持会话，等它被消费后产生的新回合结束再评估。
        await turn_ended.wait()


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
    supports_vision: bool = False
    supports_workstep_tools: bool = False
    supports_thinking_effort: bool = False


@dataclass(frozen=True)
class EngineInstallResult:
    """Outcome of an engine runtime install (CLI binary / Python SDK)."""

    success: bool
    message: str
    already_installed: bool = False


async def run_install_command(
    cmd: list[str],
    *,
    timeout: float = 600,
) -> tuple[int, str]:
    """Run an install command, returning ``(exit_code, output)``."""
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    try:
        output, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise RuntimeError(f"安装超时（超过 {timeout:g} 秒）") from None
    return proc.returncode, output.decode(errors="replace").strip()


async def install_with_command(
    cmd: list[str],
    *,
    display: str,
) -> EngineInstallResult:
    """Run an engine install command, mapping failures to a readable result."""
    if not shutil.which(cmd[0]):
        return EngineInstallResult(
            success=False,
            message=f"未找到 {cmd[0]}，请先安装对应运行时后重试",
        )
    try:
        code, output = await run_install_command(cmd)
    except RuntimeError as exc:
        return EngineInstallResult(success=False, message=str(exc))
    if code == 0:
        return EngineInstallResult(
            success=True,
            message=f"{display} 安装完成，请重新扫描引擎",
        )
    tail = output[-2000:].strip()
    detail = f"\n{tail}" if tail else ""
    return EngineInstallResult(
        success=False,
        message=f"{display} 安装失败（exit {code}）{detail}",
    )


def _has_pip() -> bool:
    try:
        return importlib.util.find_spec("pip") is not None
    except Exception:
        return False


async def install_python_package(package: str) -> EngineInstallResult:
    """Install a Python SDK package into the running daemon environment.

    uv 管理的虚拟环境通常没有 pip，优先用 ``uv pip install``（以当前解释器
    为目标），否则回退到 ``python -m pip install``。
    """
    if shutil.which("uv"):
        return await install_with_command(
            ["uv", "pip", "install", "--python", sys.executable, package],
            display=package,
        )
    if _has_pip():
        return await install_with_command(
            [sys.executable, "-m", "pip", "install", package],
            display=package,
        )
    return EngineInstallResult(
        success=False,
        message="未找到 uv 或 pip，无法安装 Python SDK 包",
    )


class BaseLLMEngine(ABC):
    """引擎自定义函数基类：安装、版本、配置、能力声明。

    协议执行（spawn / session / interaction / approval）由子类
    ``AcpEngineBase`` 提供；上层调用方只按 ACP 风格接口使用引擎。
    """

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

    # --- Install (runtime bootstrap) ---


    @staticmethod
    def install_command() -> str | None:
        """Human-readable install command for this engine.

        Returns ``None`` when the engine cannot bootstrap itself (built-in /
        API engines, placeholder backends, or engines that require a manual
        install). The settings page shows an install button only for engines
        that return a command here.
        """
        return None


    async def install(self) -> EngineInstallResult:
        """Install the engine's required runtime (CLI binary / Python SDK).

        Runs locally and may download packages. Engines that can bootstrap
        themselves override this; the base default reports nothing to install.
        """
        return EngineInstallResult(
            success=True,
            already_installed=True,
            message="该引擎无需安装",
        )


    async def inspect_capabilities(
        self,
        project_root: str | None = None,
    ) -> dict | None:
        """Return what the engine loads for a project (skills / MCP, ...).

        Returns ``None`` when the engine has nothing to inspect. The settings
        page uses this to show loaded skills and MCP servers per engine.
        """
        return None

    # --- Execution ---


    async def list_models(self, cwd: str) -> list[EngineModel]:
        """Return models selectable for this adapter.

        An empty list means the adapter only exposes its own configured default.
        """
        return []

    # --- Config schema (backend-defined settings forms) ---


    @classmethod
    def config_schema(cls) -> list[EngineConfigField]:
        """Declarative form template rendered by the settings UI.

        An empty list means the engine has no engine-specific configuration;
        only the generic binary path / default model settings apply.
        """
        return []


    @classmethod
    def stage_config_schema(cls) -> list[EngineConfigField]:
        """Config template usable at the stage level.

        Excludes sensitive fields and password types so secrets stay in the
        settings page and are never written into workflow definitions.
        """
        return [
            field
            for field in cls.config_schema()
            if not field.sensitive and field.type != "password"
        ]


    @staticmethod
    def merge_config_overrides(
        global_config: dict[str, Any],
        config_overrides: dict | None,
    ) -> dict[str, Any]:
        """Merge stage-level overrides onto the global engine config.

        Empty override values fall back to the global value; the override
        wins otherwise. A standalone ``model`` override is ignored here so
        callers can keep the explicit ``spawn(model=...)`` argument priority.
        """
        effective = dict(global_config)
        for key, value in (config_overrides or {}).items():
            if key == "model":
                continue
            if value is None or value == "":
                continue
            effective[key] = value
        return effective


    def get_config_values(self) -> dict[str, Any]:
        """Current config values; sensitive fields are masked as empty strings."""
        return {}


    def get_config_secrets(self) -> dict[str, bool]:
        """Which sensitive fields currently have a stored value."""
        return {}


    async def save_config_values(
        self,
        values: dict[str, Any],
        clear: dict[str, bool] | None = None,
        confirmed: dict[str, bool] | None = None,
    ) -> None:
        """Persist config values.

        Raise ValueError with a user-facing message when input is invalid.
        Sensitive keys keep their stored value unless replaced or listed in
        ``clear``.
        """


    def reveal_config_value(self, key: str) -> str | None:
        """Return a stored secret for the reveal action, or None."""
        return None

    @property
    def supports_message_history(self) -> bool:
        """Whether the engine can rebuild context from serialized message history.

        Engines that manage their own conversation context (resume by session
        id) return False here because context lives engine-side; in-process
        engines like Pydantic AI return True and accept ``message_history``
        plus ``report_engine_state`` in :meth:`spawn`.
        """
        return False


    @property
    def supports_thinking_effort(self) -> bool:
        """Whether ``spawn`` accepts a per-turn thinking effort override."""
        return False


    @property
    def capabilities(self) -> EngineCapabilities:
        return EngineCapabilities(
            supports_coordinator=self.is_configured(),
            supports_resume=self.supports_resume,
            supports_tool_disable=True,
            supports_native_schema=False,
            supports_live_stage_message=self.supports_live_stage_message,
            supports_sessions=self.supports_sessions,
            supports_tool_approval=self.supports_tool_approval,
            supports_vision=self.supports_vision,
            supports_workstep_tools=self.supports_workstep_tools,
            supports_thinking_effort=self.supports_thinking_effort,
        )


    @property
    def supports_workstep_tools(self) -> bool:
        """Whether this engine can host the native ``workstep_call`` tool.

        This is a transport mechanism only: whether an assistant loads the
        WorkStep internal tools is decided by assistant config, not here.
        """
        return False


    @property
    def supports_vision(self) -> bool:
        """Whether the engine can accept image content for multimodal models."""
        return False
