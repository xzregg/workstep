"""OpencodeEngine — OpenCode ACP 原生引擎（``opencode acp``，stdio JSON-RPC）。

OpenCode（opencode.ai）原生支持 Agent Client Protocol v1：
``opencode acp`` 作为子进程经 stdin/stdout 交换 JSON-RPC 消息。
初始化能力实测（v1.18.32）：

- ``loadSession: true``，``sessionCapabilities: close/fork/list/resume``
- ``promptCapabilities: image / embeddedContext``
- session 返回 ``model`` / ``mode``(build/plan) configOptions
- ``usage_update`` 携带 ``used/size/cost`` 当前上下文快照
- ``permission: ask`` 时经 ``session/request_permission`` 请求用户确认

WorkStep 通过 ``OPENCODE_CONFIG`` 环境变量（**文件路径**，env JSON 字符串
不生效）注入权限配置：读取用户全局 ``~/.config/opencode/opencode.json``
（保留其 provider / auth 配置）并覆盖 ``permission`` 为 ``ask``，写入
``~/.workstep/engines/opencode/opencode.json`` 后指给子进程。
"""

import asyncio
import json
import logging
import os
import shutil
import subprocess
from typing import AsyncIterator, ClassVar

from engines.core.acp_base import AcpEngineBase
from engines.core.base import EngineModel, ProviderRuntimeConfig
from engines.core.events import InternalEvent
from engines.core.packages import RuntimePackage
from engines.core.schema import EngineImage
from engines.core.stream_lines import ChunkedLineReader
from services import providers as provider_service

logger = logging.getLogger(__name__)

#: 权限固定为 ask：ACP 审批必须由用户决定，绝不自动通过。
_PERMISSIONS = {"edit": "ask", "bash": "ask", "webfetch": "ask"}

_GLOBAL_CONFIG_PATH = os.path.expanduser("~/.config/opencode/opencode.json")


def _managed_config_path() -> str:
    return os.path.expanduser("~/.workstep/engines/opencode/opencode.json")


def _ensure_permission_config() -> str:
    """生成 WorkStep 管理的 opencode 配置（全局配置 + permission=ask 覆盖）。

    合并用户全局配置以保留其 provider / auth 设置；无法写入权限配置时
    阻止启动，避免回退到未受控的默认权限。
    """
    merged: dict = {}
    try:
        if os.path.isfile(_GLOBAL_CONFIG_PATH):
            with open(_GLOBAL_CONFIG_PATH, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            if isinstance(data, dict):
                merged.update(data)
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("读取 opencode 全局配置失败，使用最小配置: %s", exc)
    merged["permission"] = dict(_PERMISSIONS)
    path = _managed_config_path()
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(merged, fh, ensure_ascii=False, indent=2)
        return path
    except OSError as exc:
        raise RuntimeError("无法写入 OpenCode 权限配置，已阻止启动") from exc


class OpencodeEngine(AcpEngineBase):
    ENGINE_ID = "opencode"

    RUNTIME_PACKAGE: ClassVar[RuntimePackage] = RuntimePackage(
        "opencode-ai", "npm", "0", None
    )

    @classmethod
    def supported_provider_protocols(cls) -> set[str]:
        # 尽力注入 OPENAI_BASE_URL / OPENAI_API_KEY；OpenCode 配置优先于
        # 环境变量，未生效时回退到 OpenCode 自身鉴权（免费模型开箱即用）。
        return {"openai_chat_completions"}

    def build_provider_runtime(self, provider, model, protocol=None):
        selected_protocol = str(protocol or "openai_chat_completions")
        return ProviderRuntimeConfig(
            provider_id=str(provider.get("id") or ""),
            model=model,
            protocol=selected_protocol,
            env={
                "OPENAI_BASE_URL": provider_service.provider_runtime_base_url(
                    provider, selected_protocol
                ),
                "OPENAI_API_KEY": str(provider.get("api_key") or ""),
            },
        )

    # ------------------------------------------------------------------ 发现

    @staticmethod
    def is_installed() -> bool:
        return OpencodeEngine.resolve_binary() is not None

    @staticmethod
    def get_version() -> str | None:
        binary = OpencodeEngine.resolve_binary()
        if not binary:
            return None
        try:
            out = subprocess.run(
                [binary, "--version"], capture_output=True, text=True, timeout=5
            )
            return out.stdout.strip() if out.returncode == 0 else None
        except Exception:
            return None

    @staticmethod
    def resolve_binary() -> str | None:
        override = OpencodeEngine.get_binary_override()
        if override is not None:
            return override if os.path.isfile(override) else None
        env_bin = os.environ.get("OPENCODE_BIN")
        if env_bin and os.path.isfile(env_bin):
            return env_bin
        return shutil.which("opencode")

    def get_command(self) -> list[str]:
        binary = self.resolve_binary()
        if not binary:
            return []
        return [binary, "acp"]

    def get_permission_mode(self) -> str:
        """ACP 审批必须由用户决定，绝不自动通过。"""
        return "ask"

    def project_skill_env(self, cwd: str) -> dict[str, str]:
        path = _ensure_permission_config()
        return {"OPENCODE_CONFIG": path}

    # ---------------------------------------------------------------- 能力

    @property
    def supports_resume(self) -> bool:
        return self._is_acp_native and True  # loadSession 实测为 true

    @property
    def supports_tool_approval(self) -> bool:
        # permission=ask 时 request_permission 实测触发（approval 注册表可用）。
        return self._is_acp_native

    @property
    def supports_vision(self) -> bool:
        # promptCapabilities.image 实测为 true；基类按协商能力门控。
        return self._is_acp_native

    @property
    def supports_thinking_effort(self) -> bool:
        # configOptions 仅 model / mode，无 reasoning_effort 入口，如实声明。
        return False

    def build_resume_params(self, session_id: str) -> dict:
        return {"session_id": session_id}

    # ---------------------------------------------------------------- 执行

    async def spawn(
        self,
        prompt: str,
        cwd: str,
        model: str | None = None,
        add_dirs: list[str] | None = None,
        session_id: str | None = None,
        images: list[EngineImage] | None = None,
        live_message_queue: asyncio.Queue | None = None,
        config_overrides: dict | None = None,
        thinking_effort: str | None = None,
    ) -> AsyncIterator[InternalEvent]:
        async for event in super().spawn(
            prompt=prompt,
            cwd=cwd,
            model=model,
            add_dirs=add_dirs,
            session_id=session_id,
            images=images,
            live_message_queue=live_message_queue,
            config_overrides=config_overrides,
            thinking_effort=thinking_effort,
        ):
            yield event

    async def list_models(self, cwd: str | None = None) -> list[EngineModel]:
        """经 ACP session configOptions 读取真实模型列表（按需，带超时）。"""
        binary = self.resolve_binary()
        if not binary:
            return []
        workdir = cwd or os.getcwd()
        proc = None
        try:
            proc = await asyncio.create_subprocess_exec(
                binary, "acp",
                cwd=workdir,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            assert proc.stdin is not None and proc.stdout is not None
            reader = ChunkedLineReader(proc.stdout)

            def rpc(req_id: int, method: str, params: dict) -> bytes:
                return (json.dumps({"jsonrpc": "2.0", "id": req_id,
                                    "method": method, "params": params}) + "\n").encode()

            async def request(req_id: int, method: str, params: dict) -> dict:
                proc.stdin.write(rpc(req_id, method, params))
                await proc.stdin.drain()
                async with asyncio.timeout(15):
                    while line := await reader.readline():
                        response = json.loads(line.decode(errors="replace"))
                        if response.get("id") == req_id:
                            return response
                return {}

            init_resp = await request(1, "initialize", {
                "protocolVersion": 1, "clientCapabilities": {},
                "clientInfo": {"name": "workstep", "version": "0"},
            })
            if "result" not in init_resp:
                return []
            session_resp = await request(2, "session/new", {
                "cwd": workdir, "mcpServers": [],
            })
            result = session_resp.get("result") or {}
            models: list[EngineModel] = []
            for option in result.get("configOptions") or []:
                if option.get("id") != "model":
                    continue
                for item in option.get("options") or []:
                    models.append(EngineModel(
                        id=str(item.get("value") or ""),
                        label=str(item.get("name") or item.get("value") or ""),
                        description=option.get("name") or "",
                    ))
            return models
        except Exception as exc:
            logger.warning("opencode list_models 失败: %s", exc)
            return []
        finally:
            if proc is not None:
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass
                await proc.wait()
