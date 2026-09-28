"""BaseLLMEngine — 引擎自定义函数基类（部署 / 工具 / 能力声明）。

所有引擎继承 ``AcpEngineBase``（ACP 协议基类，见 ``acp_base.py``）；本类承载与协议无关的自定义函数：安装、版本、配置表单、模型枚举、能力声明等。新接入引擎必须实现本类的抽象方法（is_installed / get_version / resolve_binary）。"""

import asyncio
import json
import logging
import os
import shutil
import sys
import time
from abc import ABC, abstractmethod
from contextlib import suppress
from dataclasses import dataclass, field
from enum import Enum
import importlib.util
from pathlib import Path
from collections.abc import Awaitable, Callable
from typing import Any, AsyncIterator, ClassVar

logger = logging.getLogger(__name__)

from engines.core.packages import RuntimePackage
from engines.core.events import InternalEvent
from engines.core.schema import EngineConfigField, EngineConfigOption, EngineImage


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
    escalate_seconds: float = 15.0,
    pending_injection: Callable[[], bool] | None = None,
) -> None:
    """End an SDK turn deterministically; only a pending insert queue keeps the
    session open.

    SDK engines (Claude / Qoder) keep the session open after responding, so a
    finished step would hang forever waiting for a stream-end event. After a
    turn's ``result`` arrives, the watchdog closes the session immediately
    (``on_idle()`` → stdin EOF → CLI exits gracefully → stream-end frame →
    step finalizes) **unless** the live insert queue still has pending
    messages (``pending_injection()``). A pending message is consumed into a
    follow-up turn; the watchdog waits for that turn's ``result`` and
    re-evaluates. No grace window is applied: a finished reply ends the step
    regardless of whether the turn carried an injection, and long follow-up
    turns are never killed (only the runner's step-level idle watchdog bounds
    them).

    ``disconnect()`` runs immediately after ``on_idle()``.  Persistent SDK
    message iterators do not necessarily end at a result message, so waiting
    for the stream before disconnecting would turn the shutdown timeout into
    a user-visible delay on every completed reply.
    """

    async def _close() -> None:
        on_idle()
        if disconnect is None:
            return
        try:
            await asyncio.wait_for(disconnect(), timeout=escalate_seconds)
        except asyncio.TimeoutError:
            logger.warning(
                "SDK session disconnect timed out after completed turn"
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
    supports_live_step_message: bool
    supports_sessions: bool = False
    supports_session_fork: bool = False
    supports_tool_approval: bool = False
    supports_vision: bool = False
    supports_workstep_tools: bool = False
    supports_thinking_effort: bool = False
    supports_plan_mode: bool = False
    supports_goal_mode: bool = False


class EngineSkillPolicy(str, Enum):
    """How an adapter enforces WorkStep's project skill whitelist."""

    CODEX_CONFIG = "codex_config"
    CLAUDE_PLUGIN = "claude_plugin"
    QODER_PLUGIN = "qoder_plugin"
    HERMES_PROFILE = "hermes_profile"
    OPENCLAW_CONFIG = "openclaw_config"
    FILESYSTEM_PROVIDER = "filesystem_provider"
    PROJECT_REGISTRY = "project_registry"
    UNSUPPORTED = "unsupported"


@dataclass(frozen=True)
class EngineInstallResult:
    """Outcome of an engine runtime install (CLI binary / Python SDK)."""

    success: bool
    message: str
    already_installed: bool = False


#: 线协议 → Codex ``wire_api`` 取值（Codex CLI/SDK 的配置词汇）。
WIRE_API_BY_PROTOCOL = {
    "openai_responses": "responses",
    "openai_chat_completions": "chat",
}


@dataclass(frozen=True)
class ProviderRuntimeConfig:
    """Resolved provider material for one engine run, with secrets isolated."""

    provider_id: str = ""
    model: str | None = None
    protocol: str = ""
    env: dict[str, str] = field(default_factory=dict)
    unset_env: set[str] = field(default_factory=set)
    engine_config: tuple[str, ...] = ()

    @property
    def safe_summary(self) -> str:
        return json.dumps({
            "provider_id": self.provider_id,
            "model": self.model,
            "protocol": self.protocol,
            "env_keys": sorted(self.env),
            "unset_env": sorted(self.unset_env),
            "engine_config": list(self.engine_config),
        }, ensure_ascii=False)

    def child_env(self) -> dict[str, str]:
        env = dict(os.environ)
        for key in self.unset_env:
            env.pop(key, None)
        env.update(self.env)
        return env


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
        limit=1024 * 256,
    )
    try:
        output, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except (asyncio.TimeoutError, asyncio.CancelledError) as exc:
        if proc.returncode is None:
            proc.kill()
        await proc.wait()
        if isinstance(exc, asyncio.CancelledError):
            raise
        raise RuntimeError(f"安装超时（超过 {timeout:g} 秒）") from None
    return proc.returncode, output.decode(errors="replace").strip()


async def install_with_command(
    cmd: list[str],
    *,
    display: str,
    action: str = "安装",
    success_hint: str = "请重新扫描引擎",
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
            message=f"{display} {action}完成，{success_hint}",
        )
    tail = output[-2000:].strip()
    detail = f"\n{tail}" if tail else ""
    return EngineInstallResult(
        success=False,
        message=f"{display} {action}失败（exit {code}）{detail}",
    )


def _has_pip() -> bool:
    try:
        return importlib.util.find_spec("pip") is not None
    except Exception:
        return False


async def install_python_package(
    package: str,
    *,
    upgrade: bool = False,
) -> EngineInstallResult:
    """Install a Python SDK package into the running daemon environment.

    uv 管理的虚拟环境通常没有 pip，优先用 ``uv pip install``（以当前解释器
    为目标），否则回退到 ``python -m pip install``。
    """
    action = "更新" if upgrade else "安装"
    success_hint = "请重启 daemon 后重新扫描引擎" if upgrade else "请重新扫描引擎"
    package_dir = os.environ.get("WORKSTEP_ENGINE_PACKAGE_DIR", "").strip()
    if package_dir:
        await asyncio.to_thread(os.makedirs, package_dir, exist_ok=True)
        if await asyncio.to_thread(_has_pip):
            cmd = [sys.executable, "-m", "pip", "install"]
        elif await asyncio.to_thread(shutil.which, "uv"):
            cmd = ["uv", "pip", "install"]
        else:
            return EngineInstallResult(
                success=False,
                message="未找到 uv 或 pip，无法安装 Python SDK 包",
            )
        if upgrade:
            cmd.append("--upgrade")
        cmd.extend(["--target", package_dir, package])
        return await install_with_command(
            cmd,
            display=package,
            action=action,
            success_hint=success_hint,
        )
    if await asyncio.to_thread(shutil.which, "uv"):
        cmd = ["uv", "pip", "install"]
        if upgrade:
            cmd.append("--upgrade")
        cmd.extend(["--python", sys.executable, package])
        return await install_with_command(
            cmd,
            display=package,
            action=action,
            success_hint=success_hint,
        )
    if await asyncio.to_thread(_has_pip):
        cmd = [sys.executable, "-m", "pip", "install"]
        if upgrade:
            cmd.append("--upgrade")
        cmd.append(package)
        return await install_with_command(
            cmd,
            display=package,
            action=action,
            success_hint=success_hint,
        )
    return EngineInstallResult(
        success=False,
        message=f"未找到 uv 或 pip，无法{action} Python SDK 包",
    )


class BaseLLMEngine(ABC):
    """引擎自定义函数基类：安装、版本、配置、能力声明。

    协议执行（spawn / session / interaction / approval）由子类
    ``AcpEngineBase`` 提供；上层调用方只按 ACP 风格接口使用引擎。
    """

    @classmethod
    def set_binary_override(cls, path: str | None) -> None:
        cls._binary_override = path or None

    async def set_permission_mode(self, mode: str) -> None:
        """Apply a unified permission mode to the current engine run."""
        self._runtime_permission_mode = mode or None

    def runtime_permission_mode(self) -> str | None:
        """Return the live per-run permission override, when one is active."""
        return getattr(self, "_runtime_permission_mode", None)


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

    @classmethod
    def supported_provider_protocols(cls) -> set[str]:
        """Provider wire protocols this adapter can safely consume."""
        return set()

    @classmethod
    def provider_required(cls) -> bool:
        """Whether this adapter requires a WorkStep-managed provider."""
        return False

    @classmethod
    def provider_config_store(cls):
        """Return the adapter's config store (also supports isolated test stores)."""
        from services.config import ConfigStore, config_store

        module = sys.modules.get(cls.__module__)
        adapter_store = getattr(module, "config_store", config_store) if module else config_store
        if adapter_store is config_store:
            return config_store
        if not isinstance(adapter_store, ConfigStore) and isinstance(
            config_store, ConfigStore
        ):
            return adapter_store
        return config_store

    @classmethod
    def provider_protocols(cls, provider: dict[str, Any]) -> list[str]:
        """The provider's wire protocols, normalized (ordered, deduped)."""
        from services.config import PROVIDER_PROTOCOLS, default_provider_protocol

        result: list[str] = []
        raw = provider.get("protocols")
        if isinstance(raw, (list, tuple)):
            for value in raw:
                value = str(value or "").strip()
                if value in PROVIDER_PROTOCOLS and value not in result:
                    result.append(value)
        if result:
            return result
        legacy = str(provider.get("protocol") or "").strip()
        if legacy in PROVIDER_PROTOCOLS:
            return [legacy]
        return [default_provider_protocol(str(provider.get("type") or "custom"))]

    @classmethod
    def supports_provider(cls, provider: dict[str, Any]) -> bool:
        """供应商协议集合与本引擎支持的协议有交集即兼容。"""
        return bool(
            set(cls.provider_protocols(provider))
            & cls.supported_provider_protocols()
        )

    @classmethod
    def pick_protocol(cls, provider: dict[str, Any]) -> str:
        """Pick the wire protocol this engine will use for the provider.

        供应商列表顺序优先（用户可表达偏好），其次按引擎声明顺序。
        """
        supported = cls.supported_provider_protocols()
        if not supported:
            return ""
        protocols = cls.provider_protocols(provider)
        for value in protocols:
            if value in supported:
                return value
        for value in supported:
            if value in protocols:
                return value
        return ""

    def build_provider_runtime(
        self,
        provider: dict[str, Any],
        model: str | None,
        protocol: str | None = None,
    ) -> ProviderRuntimeConfig:
        return ProviderRuntimeConfig(
            provider_id=str(provider.get("id") or ""),
            model=model,
            protocol=str(protocol or ""),
        )

    def build_native_runtime(self, model: str | None) -> ProviderRuntimeConfig:
        """Runtime when no provider is bound — engines may still inject own env.

        未绑定供应商不代表没有可注入的东西：Claude 系引擎的模型映射属于引擎自身
        配置，即使用户走 CLI 原生登录也必须生效，所以这里留一个可覆写的钩子。
        """
        return ProviderRuntimeConfig(model=model)

    def resolve_provider_runtime(
        self,
        provider_id: str | None = None,
        model: str | None = None,
    ) -> ProviderRuntimeConfig:
        """Resolve turn override before engine default and validate it."""
        config_store = self.provider_config_store()
        selected = self.resolve_provider_id(provider_id)
        if not model:
            model = config_store.get_engine_default_model(self.ENGINE_ID) or None
        if not selected:
            if self.provider_required():
                raise ValueError("该引擎需要先选择供应商")
            return self.build_native_runtime(model)
        provider = config_store.get_provider(selected)
        if provider is None:
            raise ValueError("供应商不存在")
        if not provider.get("enabled", True):
            raise ValueError("所选供应商已停用")
        if not self.supports_provider(provider):
            raise ValueError("所选供应商协议与该引擎不兼容")
        if provider.get("managed") and (
            not model or model not in provider.get("models", [])
        ):
            raise ValueError("所选模型未获平台供应商授权")
        protocol = self.pick_protocol(provider)
        return self.build_provider_runtime(provider, model, protocol)

    def resolve_provider_id(self, provider_id: str | None = None) -> str:
        """Resolve an explicit provider override against the engine default."""
        selected = str(provider_id or "").strip()
        if not selected:
            config_store = self.provider_config_store()
            get_managed_default = getattr(config_store, "get_managed_default_provider", None)
            if callable(get_managed_default):
                selected = str(get_managed_default() or "").strip()
        if not selected:
            selected = str(
                self.get_config_values().get("provider_id") or ""
            ).strip()
        if selected:
            return selected
        config_store = self.provider_config_store()
        get_engine_provider = getattr(config_store, "get_engine_provider", None)
        return (
            str(get_engine_provider(self.ENGINE_ID) or "").strip()
            if callable(get_engine_provider)
            else ""
        )

    @classmethod
    def provider_config_field(cls) -> EngineConfigField | None:
        protocols = cls.supported_provider_protocols()
        if not protocols:
            return None
        config_store = cls.provider_config_store()

        options = tuple(
            EngineConfigOption(
                value=str(provider.get("id") or ""),
                label=str(provider.get("name") or provider.get("id") or ""),
            )
            for provider in config_store.get_providers()
            if provider.get("enabled", True)
            and bool(set(cls.provider_protocols(provider)) & protocols)
        )
        return EngineConfigField(
            key="provider_id",
            label="供应商",
            type="select",
            options=options,
            required=cls.provider_required(),
            placeholder="沿用引擎本机配置",
            help="复用供应商的 API 地址、密钥和模型列表。",
        )

    @classmethod
    def full_config_schema(cls) -> list[EngineConfigField]:
        fields = list(cls.config_schema())
        if any(field.key == "provider_id" for field in fields):
            return fields
        provider_field = cls.provider_config_field()
        if provider_field is not None:
            fields.insert(0, provider_field)
        return fields

    @classmethod
    def full_step_config_schema(cls) -> list[EngineConfigField]:
        return [
            field
            for field in cls.full_config_schema()
            if not field.sensitive
            and field.type != "password"
            and not field.step_hidden
        ]

    def get_full_config_values(self) -> dict[str, Any]:
        values = dict(self.get_config_values())
        if self.supported_provider_protocols():
            config_store = self.provider_config_store()
            get_managed_default = getattr(config_store, "get_managed_default_provider", None)
            managed_default = get_managed_default() if callable(get_managed_default) else ""
            if managed_default:
                values["provider_id"] = managed_default
            elif "provider_id" not in values:
                values["provider_id"] = config_store.get_engine_provider(self.ENGINE_ID)
        return values

    def clear_provider_default_model(self) -> None:
        """Clear an engine model that is invalid for a newly bound provider."""
        self.provider_config_store().set_engine_default_model(self.ENGINE_ID, "")

    async def save_full_config_values(
        self,
        values: dict[str, Any],
        clear: dict[str, bool] | None = None,
        confirmed: dict[str, bool] | None = None,
    ) -> None:
        own_provider_field = any(
            field.key == "provider_id" for field in self.config_schema()
        )
        provider_id = str(values.get("provider_id") or "").strip()

        def prepare() -> str:
            previous_provider_id = str(
                self.get_config_values().get("provider_id") or ""
            ).strip()
            if self.supported_provider_protocols():
                config_store = self.provider_config_store()
                if not own_provider_field:
                    previous_provider_id = config_store.get_engine_provider(
                        self.ENGINE_ID
                    )
                if provider_id:
                    self.resolve_provider_runtime(provider_id=provider_id)
            return previous_provider_id

        previous_provider_id = await asyncio.to_thread(prepare)
        await self.save_config_values(values, clear, confirmed)

        def finish() -> None:
            config_store = self.provider_config_store()
            if self.supported_provider_protocols() and not own_provider_field:
                config_store.set_engine_provider(self.ENGINE_ID, provider_id)
            if provider_id and provider_id != previous_provider_id:
                default_model = config_store.get_engine_default_model(self.ENGINE_ID)
                cached = config_store.get_provider_models(provider_id)
                model_ids = {
                    str(item.get("id") or "")
                    for item in cached.get("models", [])
                    if isinstance(item, dict)
                }
                if default_model and default_model not in model_ids:
                    self.clear_provider_default_model()

        await asyncio.to_thread(finish)

    # --- Install (runtime bootstrap) ---

    RUNTIME_PACKAGE: ClassVar[RuntimePackage | None] = None
    UPDATE_PACKAGE: ClassVar[str | None] = None


    @staticmethod
    def install_command() -> str | None:
        """Human-readable install command for this engine.

        Returns ``None`` when the engine cannot bootstrap itself (built-in /
        API engines, placeholder backends, or engines that require a manual
        install). The settings page shows an install button only for engines
        that return a command here.
        """
        return None

    @staticmethod
    def third_party_terms_url() -> str | None:
        """Terms a user must review before installing a third-party runtime."""
        return None

    @staticmethod
    def requires_third_party_terms_acceptance() -> bool:
        return False


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

    @classmethod
    def update_command(cls) -> str | None:
        """Human-readable update command for an updateable SDK runtime."""
        return f"pip install --upgrade {cls.UPDATE_PACKAGE}" if cls.UPDATE_PACKAGE else None

    async def update(self) -> EngineInstallResult:
        """Update an SDK package in the running daemon environment."""
        if not self.UPDATE_PACKAGE:
            return EngineInstallResult(success=False, message="该引擎不支持自动更新")
        return await install_python_package(self.UPDATE_PACKAGE, upgrade=True)


    async def inspect_capabilities(
        self,
        project_root: str | None = None,
    ) -> dict | None:
        """Return what the engine loads for a project (skills / MCP, ...).

        Returns ``None`` when the engine has nothing to inspect. The settings
        page uses this to show loaded skills and MCP servers per engine.
        """
        from services.skill_center import skill_center

        resolved_root = (
            await asyncio.to_thread(Path(project_root).expanduser().resolve)
            if project_root
            else None
        )
        skills = []
        if resolved_root is not None:
            selection = await asyncio.to_thread(
                skill_center.runtime_selection, resolved_root
            )
            skills = [
                {
                    "name": skill.name,
                    "description": skill.description,
                    "source_dir": str(skill.runtime_path),
                }
                for skill in selection.enabled
            ]
        input_items = [dict(item) for item in self.input_commands()]
        known_names = {str(item.get("name") or "") for item in input_items}
        for skill in skills:
            if skill["name"] in known_names:
                continue
            input_items.append({
                "kind": "skill",
                "name": skill["name"],
                "description": skill["description"],
                "insert_text": f"{self.skill_invocation_prefix}{skill['name']} ",
                "action": "prompt",
            })
        return {
            "engine_id": self.ENGINE_ID,
            "project_root": str(resolved_root) if resolved_root else None,
            "skills": skills,
            "input_items": input_items,
            "mcp_servers": [],
            "mcp_supported": False,
            "mcp_error": None,
            "skill_policy": self.skill_policy.value,
            "supports_controlled_skills": self.supports_controlled_skills,
        }

    @property
    def skill_policy(self) -> EngineSkillPolicy:
        policies = {
            "codex": EngineSkillPolicy.CODEX_CONFIG,
            "codex_sdk": EngineSkillPolicy.CODEX_CONFIG,
            "claude": EngineSkillPolicy.CLAUDE_PLUGIN,
            "claude_agent_sdk": EngineSkillPolicy.CLAUDE_PLUGIN,
            "qoder_sdk": EngineSkillPolicy.QODER_PLUGIN,
            "hermes": EngineSkillPolicy.HERMES_PROFILE,
            "openclaw": EngineSkillPolicy.OPENCLAW_CONFIG,
            "deepseek_harness": EngineSkillPolicy.FILESYSTEM_PROVIDER,
            "pydantic_ai": EngineSkillPolicy.PROJECT_REGISTRY,
        }
        return policies.get(self.ENGINE_ID, EngineSkillPolicy.UNSUPPORTED)

    @property
    def supports_controlled_skills(self) -> bool:
        return self.skill_policy is not EngineSkillPolicy.UNSUPPORTED

    def project_skills(self, cwd: str):
        """Resolve and refresh the project whitelist immediately before spawn."""
        from services.skill_center import ProjectSkillSelection, skill_center

        root = Path(cwd).expanduser().resolve()
        if not root.is_dir():
            return ProjectSkillSelection(
                project_root=root,
                skills=(),
                enabled=(),
                disabled_source_paths=(),
            )
        return skill_center.runtime_selection(root)

    def project_skill_env(self, cwd: str) -> dict[str, str]:
        """Environment additions for adapters that isolate skills by profile."""
        return {}

    @property
    def skill_invocation_prefix(self) -> str:
        return "/"

    def input_commands(self) -> list[dict[str, str]]:
        """Return executable input commands owned by this adapter."""
        from engines.core.input_items import (
            NO_MANUAL_COMPACTION,
            workstep_input_commands,
        )

        commands = workstep_input_commands(goal=self.supports_goal_mode)
        if self.ENGINE_ID in NO_MANUAL_COMPACTION:
            return [item for item in commands if item["name"] != "compact"]
        return commands

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
    def step_config_schema(cls) -> list[EngineConfigField]:
        """Config template usable at the step level.

        Excludes sensitive fields and password types so secrets stay in the
        settings page and are never written into workflow definitions.
        """
        return [
            field
            for field in cls.config_schema()
            if not field.sensitive
            and field.type != "password"
            and not field.step_hidden
        ]


    @staticmethod
    def merge_config_overrides(
        global_config: dict[str, Any],
        config_overrides: dict | None,
    ) -> dict[str, Any]:
        """Merge step-level overrides onto the global engine config.

        Empty override values fall back to the global value; the override
        wins otherwise. A standalone ``model`` override is ignored here so
        callers can keep the explicit ``spawn(model=...)`` argument priority.
        """
        effective = dict(global_config)
        clear_keys = set((config_overrides or {}).get("__workstep_clear_keys__") or [])
        for key in clear_keys:
            effective[str(key)] = ""
        for key, value in (config_overrides or {}).items():
            if key in {"model", "__workstep_clear_keys__"}:
                continue
            if key in clear_keys:
                effective[key] = ""
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
        """Whether the host should round-trip serialized ``message_history``
        and request an ``engine_state`` report for this engine.

        Engines that manage their own conversation context (resume by session
        id, or an in-process persistence store such as the Pydantic AI harness
        StepPersistence) return False: context lives engine-side, so the host
        passes neither ``message_history`` nor ``report_engine_state``.
        """
        return False


    @property
    def supports_thinking_effort(self) -> bool:
        """Whether ``spawn`` accepts a per-turn thinking effort override."""
        return False

    @property
    def supports_plan_mode(self) -> bool:
        """Whether ``spawn`` accepts the engine's native plan-mode switch."""
        return False

    @property
    def supports_goal_mode(self) -> bool:
        """Whether ``spawn`` implements native goal lifecycle commands."""
        return False


    @property
    def capabilities(self) -> EngineCapabilities:
        return EngineCapabilities(
            supports_coordinator=self.is_configured(),
            supports_resume=self.supports_resume,
            supports_tool_disable=True,
            supports_native_schema=False,
            supports_live_step_message=self.supports_live_step_message,
            supports_sessions=self.supports_sessions,
            supports_session_fork=self.supports_session_fork,
            supports_tool_approval=self.supports_tool_approval,
            supports_vision=self.supports_vision,
            supports_workstep_tools=self.supports_workstep_tools,
            supports_thinking_effort=self.supports_thinking_effort,
            supports_plan_mode=self.supports_plan_mode,
            supports_goal_mode=self.supports_goal_mode,
        )

    @property
    def supports_session_fork(self) -> bool:
        """Whether the engine can create an independent native session fork."""
        return False


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
