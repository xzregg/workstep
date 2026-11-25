"""Official Antigravity ACP: preserve the host CLI's sign-in and settings.

The CLI owns keyring access. WorkStep neither reads IDE credential databases
nor copies tokens; account models arrive through ACP session configuration.
"""
import os
import shutil
import sys
import asyncio
from contextlib import aclosing
from pathlib import Path

from engines.core.acp_base import AcpEngineBase
from engines.core.base import EngineConfigField, EngineConfigOption
from engines.core.packages import RuntimePackage
from engines.core.permissions import EnginePermissionPolicy
from services import antigravity_runtime
from services.config import config_store


class AntigravityEngine(AcpEngineBase):
    ENGINE_ID = "antigravity"
    SUPPORTS_QUOTA = True
    PERMISSION_MODES = {"default", "auto", "accept-edits", "plan", "bypassPermissions"}
    COMMAND = ["agy", "acp"]
    RUNTIME_PACKAGE = RuntimePackage("antigravity-cli", "native")
    PERMISSION_POLICY = EnginePermissionPolicy(
        overrides={"ask": {"permission_mode": "default"},
                   "danger-full-access": {"permission_mode": "bypassPermissions"}},
        plan_overrides={"permission_mode": "plan"},
        consent_key="permission_mode", consent_default="default",
        consent_values={"default": None, "bypassPermissions": True},
    )
    # session/load replays historical content; WorkStep already owns that history.
    DROP_REPLAYED_HISTORY_ON_RESUME = True
    QUOTA_TIMEOUT_SECONDS = 12

    async def get_quota(self, cwd=""):
        from engines.core.antigravity_quota import read_quota
        binary = await asyncio.to_thread(self.resolve_binary)
        return await read_quota(binary, cwd, self.QUOTA_TIMEOUT_SECONDS) if binary else None

    @classmethod
    def get_binary_override(cls):
        return super().get_binary_override() or os.getenv("ANTIGRAVITY_BIN") or None

    @staticmethod
    def resolve_binary():
        override = AntigravityEngine.get_binary_override()
        if override is not None:
            return override if os.path.isfile(override) else None
        managed = antigravity_runtime.managed_binary()
        if managed.is_file():
            return str(managed)
        binary = shutil.which("agy")
        if binary:
            return binary
        candidates = [Path.home() / ".local" / "bin" / "agy"]
        if sys.platform == "win32":
            candidates.insert(0, Path(os.getenv("LOCALAPPDATA") or Path.home() / "AppData" / "Local") / "agy" / "bin" / "agy.exe")
        return next((str(path) for path in candidates if path.is_file()), None)

    @staticmethod
    def is_installed():
        return AntigravityEngine.resolve_binary() is not None

    @staticmethod
    def is_configured():
        # Cached OAuth/keyring/API/enterprise credentials belong to the CLI.
        # The normal connection test verifies that authentication actually works.
        return AntigravityEngine.is_installed()

    @staticmethod
    def get_version():
        binary = AntigravityEngine.resolve_binary()
        if not binary:
            return None
        return antigravity_runtime.binary_version(Path(binary))

    def get_command(self):
        binary = self.resolve_binary()
        if not binary:
            return []
        command = [binary, "acp"]
        if self.get_permission_mode() == "auto":
            command.append("--dangerously-skip-permissions")
        return command

    def get_permission_mode(self):
        config = getattr(self, "_active_permission_config", None)
        if config is None:
            config = self._permission_config()
        return "auto" if config["permission_mode"] == "bypassPermissions" else "ask"

    def runtime_permission_decision(self):
        config = getattr(self, "_active_permission_config", None)
        if config is not None:
            return self.configured_permission_decision(config)
        return super().runtime_permission_decision()

    @classmethod
    def config_schema(cls):
        return [EngineConfigField(
            key="permission_mode", label="权限模式", type="select", category="mode",
            options=(EngineConfigOption("default", "跟随 Antigravity 规则"),
                     EngineConfigOption("auto", "自动审核"),
                     EngineConfigOption("accept-edits", "自动编辑"),
                     EngineConfigOption("plan", "计划模式"),
                     EngineConfigOption("bypassPermissions", "全权限（免审批）")),
            default="default", required=True, confirm_values=("bypassPermissions",),
            help="自动审核由引擎判断安全操作；自动编辑仅放行工作区编辑；计划模式由聊天计划开关控制；全权限免审批。",
        )]

    def get_config_values(self):
        mode = config_store.get("antigravity_permission_mode", "default")
        return {"permission_mode": mode if mode in self.PERMISSION_MODES else "default"}

    async def save_config_values(self, values, clear=None, confirmed=None):
        if "permission_mode" not in values and not (clear or {}).get("permission_mode"):
            return
        mode = "default" if (clear or {}).get("permission_mode") else values["permission_mode"]
        if mode not in self.PERMISSION_MODES:
            raise ValueError("Unsupported Antigravity permission mode")
        if mode == "bypassPermissions" and not (confirmed or {}).get("permission_mode"):
            raise ValueError("Full access requires explicit risk confirmation")
        await asyncio.to_thread(config_store.set, "antigravity_permission_mode", mode)
        self.configure_interaction_policy({"permission_mode": mode})

    def _permission_config(self, overrides=None):
        config = self.get_config_values()
        config.update(self.permission_config_overrides(self.runtime_permission_mode() or ""))
        config = self.merge_config_overrides(config, overrides)
        if config["permission_mode"] not in self.PERMISSION_MODES:
            raise ValueError("Unsupported Antigravity permission mode")
        return config

    async def spawn(self, *args, config_overrides=None, plan_mode=None, **kwargs):
        # Resolve disk-backed defaults off-loop. Step > session > engine default.
        config = await asyncio.to_thread(self._permission_config, config_overrides)
        if plan_mode is True:
            config["permission_mode"] = "plan"
        elif plan_mode is False and config["permission_mode"] == "plan":
            config["permission_mode"] = "default"
        if getattr(self, "_engine_run_active", False):
            raise RuntimeError("A same engine instance is already running")
        previous = getattr(self, "_active_permission_config", None)
        previous_decision = getattr(self, "_interaction_policy_decision", None)
        previous_interaction = getattr(self, "_interaction_effective_config", None)
        self._active_permission_config = config
        self.configure_interaction_policy(config)
        try:
            async with aclosing(super().spawn(*args, config_overrides=config_overrides, plan_mode=plan_mode, **kwargs)) as stream:
                async for event in stream:
                    yield event
        finally:
            self._active_permission_config = previous
            self._interaction_policy_decision = previous_decision
            self._interaction_effective_config = previous_interaction

    async def _configure_session_mode(self, client, session_id, plan_mode):
        mode = self._active_permission_config["permission_mode"]
        # ACP ignores the CLI's global --mode. Set the native session option on
        # every turn, so reused/restored sessions cannot retain a previous plan.
        # Fail visibly if the agent rejects the mode; never run with stale policy.
        await client.set_config_option(
            config_id="mode", session_id=session_id,
            value="default" if mode == "bypassPermissions" else mode,
        )

    @property
    def supports_plan_mode(self):
        return True

    @property
    def supports_session_fork(self):
        return False

