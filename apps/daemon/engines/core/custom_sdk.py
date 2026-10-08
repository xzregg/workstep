"""Versioned adapter helpers for isolated, user-installed engines.

Import dependencies lazily. install() runs in a worker with its own target.
"""
from dataclasses import dataclass
import asyncio
import os
import platform
import shutil
from pathlib import Path
import sys
from typing import Any

from engines.core.acp_base import AcpEngineBase
from services.config import config_store

CUSTOM_ENGINE_API_VERSION = 1


@dataclass(frozen=True)
class InstallContext:
    target_dir: Path
    cache_dir: Path
    engine_dir: Path
    system: str
    architecture: str
    python_version: str
    python_executable: str

    @classmethod
    def current(cls):
        root = Path(os.environ["WORKSTEP_CUSTOM_ENGINE_DIR"])
        return cls(
            Path(os.environ.get("WORKSTEP_CUSTOM_DEPENDENCIES", str(root / "dependencies"))),
            root / "cache", root, platform.system(), platform.machine(),
            platform.python_version(), sys.executable,
        )


def raw_config(engine_id: str) -> dict:
    values = config_store.get("custom_engine_config", {})
    return dict(values.get(engine_id, {})) if isinstance(values, dict) else {}


class CustomEngineBase(AcpEngineBase):
    """Optional base providing generic, masked configuration storage."""

    workstep_events = frozenset()

    @property
    def install_context(self) -> InstallContext:
        return InstallContext.current()

    async def install_python_dependencies(self, *requirements: str):
        """Install into this engine's staged site directory, never daemon's site."""
        from engines.core.base import run_install_command, EngineInstallResult, _has_pip
        target = self.install_context.target_dir / "python"
        await asyncio.to_thread(target.mkdir, parents=True, exist_ok=True)
        if await asyncio.to_thread(_has_pip):
            command = [sys.executable, "-m", "pip", "install"]
        elif await asyncio.to_thread(shutil.which, "uv"):
            command = ["uv", "pip", "install", "--python", sys.executable]
        else:
            return EngineInstallResult(False, "未找到 uv 或 pip，无法安装自定义 Python SDK")
        code, output = await run_install_command([
            *command, "--upgrade", "--target", str(target), *requirements,
        ])
        return EngineInstallResult(code == 0, output)

    async def install_node_dependencies(self, *packages: str):
        from engines.core.base import run_install_command, EngineInstallResult
        code, output = await run_install_command(["npm", "install", "--global", *packages])
        return EngineInstallResult(code == 0, output)

    def get_config_values(self) -> dict[str, Any]:
        values = raw_config(self.ENGINE_ID)
        return {
            field.key: "" if field.sensitive or field.type == "password"
            else values.get(field.key, field.default)
            for field in self.config_schema()
        }

    def get_config_secrets(self) -> dict[str, bool]:
        values = raw_config(self.ENGINE_ID)
        return {field.key: bool(values.get(field.key)) for field in self.config_schema()
                if field.sensitive or field.type == "password"}

    def reveal_config_value(self, key: str) -> str | None:
        return raw_config(self.ENGINE_ID).get(key)

    async def save_config_values(self, values, clear=None, confirmed=None) -> None:
        # Main-process proxies persist generic configuration; worker adapters
        # should read it, never persist a stale worker snapshot.
        raise RuntimeError("自定义引擎配置必须通过 WorkStep 配置接口保存")

    @property
    def supports_resume(self) -> bool:
        return False

    @property
    def supports_sessions(self) -> bool:
        return False

    @property
    def supports_tool_approval(self) -> bool:
        return False
