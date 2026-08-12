"""BaseLLMEngine — abstract interface for all LLM engines."""

import asyncio
import json
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
from inspect import isawaitable

logger = logging.getLogger(__name__)

from engines.core.events import InternalEvent
from engines.core.interactions import (
    claude_ask_user_request,
    interaction_from_tool_use,
    permission_request,
    permission_signature,
)
from engines.core.plans import NativePlanTracker
from engines.core.schema import EngineConfigField, EngineImage


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

    @abstractmethod
    async def spawn(
        self,
        prompt: str,
        cwd: str,
        model: str | None = None,
        add_dirs: list[str] | None = None,
        session_id: str | None = None,
        images: list[EngineImage] | None = None,
        config_overrides: dict | None = None,
    ) -> AsyncIterator[InternalEvent]:
        """Start subprocess, stream unified internal events.

        ``config_overrides`` carries stage-level configuration overrides as
        ``{key: value}``; keys with empty values fall back to the global
        engine config. Sensitive/password fields are never present.

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
    def supports_live_stage_message(self) -> bool:
        """Whether ordinary user messages can be injected mid-execution."""
        return False

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
        """Whether this engine can load WorkStep internal tools (list/create)."""
        return False

    @property
    def supports_vision(self) -> bool:
        """Whether the engine can accept image content for multimodal models."""
        return False

    def _coordinator_prompt(self, prompt: str) -> str:
        """Apply the read-only coordinator guard plus capability-gated tools."""
        from services.tool_registry import workstep_tools_instruction

        guarded = self.coordinator_guard(prompt)
        if (
            self.capabilities.supports_workstep_tools
            and "WorkStep internal tools" not in guarded
        ):
            guarded = f"{guarded}\n\n{workstep_tools_instruction()}"
        return guarded

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
    ) -> AsyncIterator[InternalEvent]:
        """Run a no-tools coordinator turn through this adapter seam."""
        guarded_prompt = self._coordinator_prompt(prompt)
        if images and not self.capabilities.supports_vision:
            guarded_prompt = self.render_image_prompt(guarded_prompt, images)
        spawn_kwargs: dict[str, Any] = {}
        if self.supports_message_history:
            if message_history is not None:
                spawn_kwargs["message_history"] = message_history
            if report_engine_state:
                spawn_kwargs["report_engine_state"] = True
        if self.capabilities.supports_thinking_effort and thinking_effort:
            spawn_kwargs["thinking_effort"] = thinking_effort
        async for event in self.spawn(
            prompt=guarded_prompt,
            cwd=cwd,
            model=model,
            session_id=session_id,
            images=images,
            **spawn_kwargs,
        ):
            yield event

    @staticmethod
    def coordinator_guard(prompt: str) -> str:
        """Wrap a user prompt with the read-only coordinator instruction."""
        return (
            "You are a read-only task coordinator. Do not call tools, execute "
            "commands, or modify files. Return only the requested JSON.\n\n"
            f"{prompt}"
        )

    @staticmethod
    def render_image_prompt(
        prompt: str,
        images: list[EngineImage] | None,
    ) -> str:
        """Append attached images as markdown references to a text prompt.

        Vision-capable engines embed the references natively; engines without
        vision keep the paths visible to the model as a best-effort fallback.
        """
        if not images:
            return prompt
        lines = [prompt, "", "Attached image(s); analyze them if possible:"]
        for image in images:
            alt = image.description or "attached image"
            lines.append(f"![{alt}]({image.reference})")
        return "\n".join(lines)

    # --- Interaction ---

    def normalize_event(self, event: InternalEvent) -> InternalEvent | None:
        """Normalize provider-native interaction and plan events at the Base seam."""
        interaction = self.normalize_interaction_event(event)
        if interaction is not event:
            return interaction
        tracker = getattr(self, "_native_plan_tracker", None)
        if tracker is None:
            tracker = NativePlanTracker()
            setattr(self, "_native_plan_tracker", tracker)
        if event.type == "subagent":
            # 子代理生命周期事件透传给前端；同时把状态并入 plan 快照，
            # 供后续 plan 工具事件（TaskCreate/TaskUpdate/TaskList）携带。
            tracker.observe(event)
            return event
        return tracker.observe(event) or event

    def normalize_interaction_event(self, event: InternalEvent) -> InternalEvent:
        """Map native ask-user tool aliases to ACP form elicitation."""
        if event.type != "tool_use":
            return event
        interaction = interaction_from_tool_use(
            str(event.data.get("id") or event.data.get("tool_use_id") or ""),
            str(event.data.get("name") or ""),
            event.data.get("input") if isinstance(event.data.get("input"), dict) else {},
        )
        return interaction or event

    async def request_interaction(self, event: InternalEvent, publish) -> dict[str, Any]:
        """Publish and await an interaction from an in-process engine tool.

        CLI/SDK adapters can expose their native pause. In-process engines use
        this broker so their tool coroutine blocks until ``respond_interaction``.
        """
        interaction_id = str(event.data.get("interaction_id") or "")
        if not interaction_id:
            raise ValueError("interaction_request 缺少 interaction_id")
        pending = getattr(self, "_pending_interaction_responses", None)
        if pending is None:
            pending = {}
            setattr(self, "_pending_interaction_responses", pending)
        if interaction_id in pending:
            raise RuntimeError(f"交互请求重复：{interaction_id}")
        future = asyncio.get_running_loop().create_future()
        pending[interaction_id] = future
        try:
            published = publish(event)
            if isawaitable(published):
                await published
            return await future
        finally:
            pending.pop(interaction_id, None)

    async def handle_tool_permission(
        self,
        publish,
        *,
        tool_name: str,
        tool_input: dict[str, Any],
        tool_use_id: str,
        title: str = "",
        session_id: str = "",
    ) -> tuple[bool, dict[str, Any] | None]:
        """Bridge SDK permission callbacks to ACP interaction semantics."""
        if "".join(character for character in tool_name.lower() if character.isalnum()) in {
            "askuser", "askuserquestion", "requestuserinput", "userinput",
        }:
            event = claude_ask_user_request(tool_use_id, tool_input)
            response = await self.request_interaction(event, publish)
            if response.get("action") != "accept":
                return False, None
            content = response.get("content")
            answers: dict[str, Any] = {}
            if isinstance(content, dict):
                for index, question in enumerate(tool_input.get("questions") or []):
                    if not isinstance(question, dict):
                        continue
                    question_text = str(question.get("question") or f"question_{index}")
                    if f"question_{index}" in content:
                        answers[question_text] = content[f"question_{index}"]
            return True, {
                "questions": tool_input.get("questions") or [],
                "answers": answers,
            }

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
            return True, tool_input
        if signature and signature in session_reject:
            return False, tool_input

        event = permission_request(
            interaction_id=tool_use_id,
            session_id=session_id,
            tool_call={
                "tool_call_id": tool_use_id,
                "title": title or tool_name,
                "name": tool_name,
                "raw_input": tool_input,
            },
            options=[
                {"option_id": "allow_once", "name": "允许一次", "kind": "allow_once"},
                {"option_id": "allow_for_session", "name": "允许本次运行", "kind": "allow_for_session"},
                {"option_id": "reject_once", "name": "拒绝", "kind": "reject_once"},
                {"option_id": "reject_for_session", "name": "拒绝本次运行", "kind": "reject_for_session"},
            ],
        )
        response = await self.request_interaction(event, publish)
        outcome = response.get("outcome") or {}
        option_id = str(outcome.get("option_id") or "")
        if option_id == "allow_for_session" and signature:
            session_allow.add(signature)
        elif option_id == "reject_for_session" and signature:
            session_reject.add(signature)
        return option_id in {"allow_once", "allow_for_session"}, tool_input

    @abstractmethod
    async def inject_response(self, tool_use_id: str, content: str) -> None:
        """Inject user response mid-execution (AskUserQuestion / permission)."""

    async def send_live_stage_message(self, content: str) -> bool:
        """Send a plain user message into a running stage execution.

        Return True when the message was accepted by the engine, False when the
        adapter cannot deliver ordinary messages mid-run (permission responses
        go through inject_response instead). Adapters that implement this must
        also advertise ``supports_live_stage_message`` in their capabilities.
        """
        return False

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

    async def approve_tool_option(
        self,
        tool_use_id: str,
        option_id: str | None,
    ) -> None:
        """Resolve a permission request using its ACP option id.

        Adapters with a native option-id protocol override this method. The
        compatibility default maps allow/reject option kinds to ``approve_tool``.
        """
        await self.approve_tool(tool_use_id, approved=bool(option_id))

    async def respond_interaction(
        self,
        request: dict[str, Any],
        response: dict[str, Any],
    ) -> bool:
        """Return a UI response to the adapter using ACP response semantics."""
        interaction_id = str(request.get("interaction_id") or "")
        pending = getattr(self, "_pending_interaction_responses", {})
        future = pending.get(interaction_id)
        if future is not None and not future.done():
            future.set_result(response)
            return True

        method = str(request.get("method") or "")
        if method == "session/request_permission":
            tool_call = request.get("tool_call") or {}
            tool_use_id = str(
                tool_call.get("tool_call_id")
                or tool_call.get("id")
                or request.get("interaction_id")
                or ""
            )
            outcome = response.get("outcome") or {}
            option_id = (
                str(outcome.get("option_id"))
                if outcome.get("outcome") == "selected" and outcome.get("option_id")
                else None
            )
            selected_option = next(
                (
                    option for option in (request.get("options") or [])
                    if str(option.get("option_id") or "") == option_id
                ),
                None,
            )
            if selected_option and str(selected_option.get("kind") or "").startswith(
                "reject"
            ):
                option_id = None
            await self.approve_tool_option(tool_use_id, option_id)
            return True

        if method == "elicitation/create":
            tool_use_id = str(
                request.get("tool_call_id")
                or request.get("interaction_id")
                or ""
            )
            if response.get("action") == "accept":
                content = response.get("content") or {}
            else:
                content = {"action": response.get("action") or "cancel"}
            await self.inject_response(
                tool_use_id,
                json.dumps(content, ensure_ascii=False),
            )
            return True
        return False

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
