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
（保留其 provider / auth 配置）并覆盖 ``permission``，写入
``~/.workstep/engines/opencode/opencode.json`` 后指给子进程。

权限来源优先级：单次 ``config_overrides["permission_mode"]`` >
运行时 ``set_permission_mode``（会话聊天权限选择器）> 引擎配置页 >
默认 ``ask``。
"""

import asyncio
import json
import logging
import os
import shutil
import subprocess
from typing import AsyncIterator, ClassVar

from engines.core.acp_base import AcpEngineBase
from engines.core.base import (
    EngineConfigField,
    EngineConfigOption,
    EngineModel,
    ProviderRuntimeConfig,
)
from engines.core.events import InternalEvent
from engines.core.packages import RuntimePackage
from engines.core.schema import EngineImage
from engines.core.stream_lines import ChunkedLineReader
from services import providers as provider_service
from services.config import config_store
from services.engine_config_rules import OPENCODE_PERMISSION_MODES

logger = logging.getLogger(__name__)

#: opencode 原生 permission 取值：ask（每次确认）/ allow（自动放行）/ deny。
#: 写入 managed config 的 edit/bash/webfetch 三项。
_OPENCODE_ALLOW = {"edit": "allow", "bash": "allow", "webfetch": "allow"}
_OPENCODE_ASK = {"edit": "ask", "bash": "ask", "webfetch": "ask"}
_OPENCODE_DENY = {"edit": "deny", "bash": "deny", "webfetch": "deny"}

#: 运行时（ACP 审批桥）可识别的模式：allow 系自动通过。
_RUNTIME_AUTO_MODES = {"allow", "auto", "bypassPermissions", "workspace-write", "danger-full-access"}

#: opencode 原生词汇 → 审批桥（ACPStreamingClient）词汇。引擎配置页与
#: OPENCODE_CONFIG 文件用 opencode 词汇（ask/allow/deny）；但审批桥只认识
#: auto/bypassPermissions/workspace-write/danger-full-access（自动放行）、
#: ask（挂起等用户确认）、read-only/plan（只放行只读工具），其它一律拒绝。
#: 不翻译的话，引擎默认 allow 时漏网的 request_permission 会被全部拒绝，
#: 表现为“已设 allow 但有时候还是权限不足”。
_BRIDGE_PERMISSION_MODES = {"allow": "auto", "deny": "read-only", "ask": "ask"}

_GLOBAL_CONFIG_PATH = os.path.expanduser("~/.config/opencode/opencode.json")


def _resolve_opencode_mode(config_overrides: dict | None = None) -> str:
    """按 overrides > runtime > 引擎配置 > ask 解析生效的权限模式。"""
    override = str(((config_overrides or {}).get("permission_mode") or "")).strip()
    if override in OPENCODE_PERMISSION_MODES:
        return override
    return config_store.get_opencode_config().get("permission_mode") or "ask"


def _permissions_for(mode: str) -> dict[str, str]:
    if mode == "allow":
        return dict(_OPENCODE_ALLOW)
    if mode == "deny":
        return dict(_OPENCODE_DENY)
    return dict(_OPENCODE_ASK)


def _managed_config_path() -> str:
    return os.path.expanduser("~/.workstep/engines/opencode/opencode.json")


def _ensure_permission_config(mode: str = "ask") -> str:
    """生成 WorkStep 管理的 opencode 配置（全局配置 + permission 覆盖）。

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
    merged["permission"] = _permissions_for(mode)
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
        """审批桥看到的权限模式（桥接层词汇）。

        单次调用可经 overrides/runtime 覆盖；引擎配置页的默认值在这里翻
        译成桥接层词汇，OPENCODE_CONFIG 文件仍由 ``project_skill_env`` 按
        opencode 原生词汇写入，两边各走各的词汇表。
        """
        return _BRIDGE_PERMISSION_MODES.get(_resolve_opencode_mode(), "ask")

    def project_skill_env(self, cwd: str) -> dict[str, str]:
        runtime = (self.runtime_permission_mode() or "").strip()
        if runtime in _RUNTIME_AUTO_MODES:
            mode = "allow"
        elif runtime in OPENCODE_PERMISSION_MODES:
            mode = runtime
        else:
            mode = _resolve_opencode_mode()
        path = _ensure_permission_config(mode)
        return {"OPENCODE_CONFIG": path}

    # ---------------------------------------------------------------- 配置

    @classmethod
    def config_schema(cls) -> list[EngineConfigField]:
        return [
            EngineConfigField(
                key="permission_mode",
                label="权限模式",
                type="select",
                options=tuple(
                    EngineConfigOption(mode, mode)
                    for mode in sorted(OPENCODE_PERMISSION_MODES)
                ),
                default="ask",
                required=True,
                confirm_values=("allow",),
                help="ask 每次弹窗确认；allow 自动放行 edit/bash/webfetch；deny 一律拒绝。",
            ),
        ]

    def get_config_values(self) -> dict:
        return dict(config_store.get_opencode_config())

    async def save_config_values(
        self,
        values: dict,
        clear: dict[str, bool] | None = None,
        confirmed: dict[str, bool] | None = None,
    ) -> None:
        mode = str(values.get("permission_mode") or "ask").strip()
        if mode not in OPENCODE_PERMISSION_MODES:
            raise ValueError("不支持的 OpenCode 权限模式")
        if mode == "allow" and not (confirmed or {}).get("permission_mode"):
            raise ValueError("allow 需要明确确认风险")
        await asyncio.to_thread(config_store.set_opencode_config, mode)

    # ---------------------------------------------------------------- 能力

    @property
    def supports_resume(self) -> bool:
        # loadSession/resume 均为 true；续轮走 resume（load 会重播历史）。
        return self._is_acp_native and True

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

    async def get_quota(self, cwd: str = "") -> dict | None:
        """opencode 暂无账户额度原生接口：如实返回 None。

        ACP 只给上下文用量快照（usage_update 的 used/size/cost），没有订阅
        余额/配额端点；显式声明避免上层误判为“支持但查不到”。
        """
        return None

    @staticmethod
    def _agent_capability(response, name=None, nested=None):
        # opencode 的 session/load 会把整段历史当实时 update 重播，
        # 旧正文混入新回复；隐藏该能力让基类改走 session/resume
        #（实测恢复上下文且不重播）。
        if name == "load_session":
            return False
        return AcpEngineBase._agent_capability(response, name, nested)

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
        effective = self.merge_config_overrides(
            {"permission_mode": _resolve_opencode_mode()},
            config_overrides,
        )["permission_mode"]
        if effective not in OPENCODE_PERMISSION_MODES:
            effective = "ask"
        runtime_map = {"allow": "auto", "deny": "read-only", "ask": "ask"}
        previous = self.runtime_permission_mode()
        # 单次 overrides 优先于会话级 runtime：临时提升 runtime，
        # 让基类 prepare_spawn（permission_mode + OPENCODE_CONFIG +
        # 审批桥 handler）三处一致。
        override_runtime = str(((config_overrides or {}).get("permission_mode") or "")).strip()
        if override_runtime in OPENCODE_PERMISSION_MODES:
            await self.set_permission_mode(runtime_map[override_runtime])
        try:
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
        finally:
            await self.set_permission_mode(previous or "")

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
