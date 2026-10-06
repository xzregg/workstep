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

import acp
from settings import settings
from engines.core.acp_base import AcpEngineBase
from engines.core.acp_streaming_client import ACPStreamingClient as _StreamingClient
from engines.core.base import (
    EngineConfigField,
    EngineConfigOption,
    EngineModel,
    ProviderRuntimeConfig,
    resolve_thinking_effort,
)
from engines.core.events import InternalEvent, compacted_event
from engines.core.packages import RuntimePackage
from engines.core.plans import subagent_event
from engines.core.subagents import delegation_prompt
from engines.core.schema import EngineImage
from engines.core.stream_lines import ChunkedLineReader
from services import providers as provider_service
from services.config import config_store
from services.engine_config_rules import OPENCODE_PERMISSION_MODES

logger = logging.getLogger(__name__)

#: opencode `task` 委托工具（子代理语义来源）：命中即提升为 `subagent`。
_SUBAGENT_TOOL_NAMES = frozenset({"task", "subagent", "spawnagent", "background"})


def _is_subagent_tool(title: str | None, kind: str | None, raw: object) -> bool:
    candidates = [str(title or ""), str(kind or "")]
    if isinstance(raw, dict):
        if any(raw.get(key) not in (None, "") for key in ("subagent_type", "task_id", "background")):
            return True
        candidates.append(str(raw.get("name") or ""))
    text = " ".join(candidates).lower()
    return any(name in text for name in _SUBAGENT_TOOL_NAMES)


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

    #: ACP 原生全量词汇 + 子代理提升（`task` 委托工具 → `subagent`）。
    acp_events: ClassVar[frozenset] = frozenset(AcpEngineBase.acp_events)

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

    @property
    def supports_plan_mode(self) -> bool:
        # session configOptions 原生 `mode`(build/plan)：基类经
        # session/set_config_option 切换，无需提示词注入。
        return self._is_acp_native

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

    def _map_notification(self, update) -> InternalEvent | None:
        event = super()._map_notification(update)
        if event is None:
            return None
        if event.type == "tool_call":
            data = event.data
            if _is_subagent_tool(data.get("title"), data.get("kind"), data.get("raw_input")):
                frame = subagent_event(
                    task_id=str(data.get("tool_call_id")),
                    status="running",
                    stage="started",
                    description=str(data.get("title") or "task"),
                    tool_use_id=str(data.get("tool_call_id")),
                    prompt=delegation_prompt(data.get("raw_input")),
                )
                frame.data["event"] = event.to_dict()
                return frame
        elif event.type == "tool_call_update":
            data = event.data
            if _is_subagent_tool(data.get("title"), data.get("kind"), data.get("raw_input")):
                status = str(data.get("status") or "")
                terminal = status if status in {"completed", "failed"} else None
                frame = subagent_event(
                    task_id=str(data.get("tool_call_id")),
                    status=terminal or "running",
                    stage="notification" if terminal else "progress",
                    description=str(data.get("title") or "task"),
                    tool_use_id=str(data.get("tool_call_id")),
                    summary=str(data.get("raw_output"))[:500] if terminal and data.get("raw_output") is not None else None,
                )
                frame.data["event"] = event.to_dict()
                return frame
        return event

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
        plan_mode: bool | None = None,
        goal_action: str | None = None,
    ) -> AsyncIterator[InternalEvent]:
        """opencode 本地 spawn：基类 ACP 流程 + 运行中插入即打断。

        与其它 ACP 引擎不同：等待 prompt 时轮询插入队列，有新消息就
        ``session/cancel`` 打断本轮（Codex CLI 终止重开的 ACP 等价），
        cancelled 且队列非空时不收尾，直接用新消息重开一轮；
        cancel 失败则回退为等整轮结束。其它引擎仍走基类实现。
        """
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
            async for event in self._spawn_with_live_interrupt(
                prompt=prompt,
                cwd=cwd,
                model=model,
                add_dirs=add_dirs,
                session_id=session_id,
                images=images,
                live_message_queue=live_message_queue,
                config_overrides=config_overrides,
                thinking_effort=thinking_effort,
                plan_mode=plan_mode,
                goal_action=goal_action,
            ):
                yield event
        finally:
            await self.set_permission_mode(previous or "")

    async def _spawn_with_live_interrupt(
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
        plan_mode: bool | None = None,
        goal_action: str | None = None,
    ) -> AsyncIterator[InternalEvent]:
        """ACP 标准建连/恢复/配置流程；仅 prompt 等待与插入消费为打断语义."""
        if goal_action and not self.supports_goal_mode:
            yield InternalEvent(type="error", data={
                "message": f"当前引擎不支持目标模式：{self.ENGINE_ID}",
            })
            return
        if prompt.strip() == "/compact":
            if not session_id:
                yield InternalEvent(type="error", data={
                    "message": "没有可压缩的 ACP 会话",
                })
                return
            commands = await self._inspect_acp_commands(cwd)
            if not any(command["name"] == "compact" for command in commands):
                yield InternalEvent(type="error", data={
                    "message": "ACP 引擎未声明 /compact 命令",
                })
                return

        def prepare_spawn():
            provider_runtime = self.resolve_provider_runtime(
                provider_id=str((config_overrides or {}).get("provider_id") or ""),
                model=model,
            )
            return (
                provider_runtime,
                self.project_skill_env(cwd),
                self.get_command(),
                self.get_permission_mode(),
            )

        provider_runtime, skill_env, cmd, permission_mode = await asyncio.to_thread(
            prepare_spawn
        )
        model = provider_runtime.model
        if not cmd:
            yield InternalEvent(type="error", data={"message": f"{self.ENGINE_ID}: no command configured"})
            return

        if self.REQUIRES_PERMISSION_MODE and not permission_mode:
            yield InternalEvent(type="error", data={
                "message": "Claude Code 权限模式尚未确认，请先在设置中选择权限模式",
            })
            return

        logger.info("ACP spawn: %s (cwd=%s)", " ".join(cmd), cwd)
        yield InternalEvent(type="status", data={"status": "initializing"})

        handler = _StreamingClient(self.runtime_permission_mode() or permission_mode)
        self._handler = handler
        self._last_cwd = cwd
        try:
            process_env = (
                provider_runtime.child_env()
                if provider_runtime.provider_id or provider_runtime.env
                else dict(os.environ)
            )
            process_env.update(skill_env)
            async with acp.spawn_agent_process(
                handler,
                cmd[0],
                *cmd[1:],
                cwd=cwd,
                env=process_env,
            ) as (client, process):
                self._process = process
                self._running = True

                init_resp = await client.initialize(
                    protocol_version=acp.PROTOCOL_VERSION,
                    client_capabilities=self._client_capabilities(),
                    client_info={"name": "WorkStep", "version": settings.version},
                )
                self._initialize_response = init_resp
                logger.info("ACP initialized: %s", init_resp)

                if (
                    init_resp is not None
                    and getattr(init_resp, "protocol_version", acp.PROTOCOL_VERSION)
                    != acp.PROTOCOL_VERSION
                ):
                    raise RuntimeError(
                        "ACP 协议版本不兼容："
                        f"客户端={acp.PROTOCOL_VERSION}，Agent={init_resp.protocol_version}"
                    )

                mcp_servers = list(
                    (config_overrides or {}).get("mcp_servers") or []
                )
                self._validate_session_inputs(
                    init_resp, add_dirs or [], mcp_servers
                )

                if session_id:
                    try:
                        if self._agent_capability(
                            init_resp, "load_session"
                        ):
                            await client.load_session(
                                cwd=cwd,
                                session_id=session_id,
                                mcp_servers=mcp_servers,
                                additional_directories=add_dirs or [],
                            )
                        elif self._agent_capability(
                            init_resp, "session_capabilities", "resume"
                        ):
                            await client.resume_session(
                                cwd=cwd,
                                session_id=session_id,
                                mcp_servers=mcp_servers,
                                additional_directories=add_dirs or [],
                            )
                        else:
                            raise RuntimeError(
                                "ACP Agent 未声明 session/load 或 session/resume 支持"
                            )
                        active_session_id = session_id
                    except Exception as exc:
                        logger.warning("Failed to load session %s: %s", session_id, exc)
                        yield InternalEvent(type="error", data={
                            "message": f"无法恢复 ACP 会话 {session_id}: {exc}",
                            "session_id": session_id,
                        })
                        return
                else:
                    session = await client.new_session(
                        cwd=cwd,
                        additional_directories=add_dirs or [],
                        mcp_servers=mcp_servers,
                    )
                    active_session_id = session.session_id

                yield InternalEvent(
                    type="session_started",
                    data={"session_id": active_session_id},
                )

                if model:
                    try:
                        await client.set_config_option(
                            config_id="model",
                            session_id=active_session_id,
                            value=model,
                        )
                    except Exception:
                        logger.warning("Failed to set model %s", model)

                if plan_mode is not None and self.supports_plan_mode:
                    # 原生计划模式：经 session config `mode` 切换
                    #（opencode 的 build/plan）；不支持的 agent 忽略。
                    try:
                        await client.set_config_option(
                            config_id="mode",
                            session_id=active_session_id,
                            value="plan" if plan_mode else "build",
                        )
                    except Exception:
                        logger.warning("Failed to set plan_mode %s", plan_mode)

                effort = resolve_thinking_effort(thinking_effort)
                if effort:
                    # 思考强度不是 ACP 协议固定字段：按常见 configId
                    # 尽力设置，不支持时忽略。
                    try:
                        await client.set_config_option(
                            config_id="reasoning_effort",
                            session_id=active_session_id,
                            value=effort,
                        )
                    except Exception:
                        logger.warning(
                            "ACP agent does not accept reasoning_effort=%s",
                            effort,
                        )

                yield InternalEvent(type="status", data={"status": "running"})
                if images and not self._agent_capability(
                    init_resp, "prompt_capabilities", "image"
                ):
                    raise RuntimeError("ACP Agent 未声明图片 Prompt 支持")
                prompt_blocks = await asyncio.to_thread(
                    self._acp_prompt_blocks, prompt, images
                )
                interrupt_state = {"requested": False}

                async def _drain_prompt(
                    task: asyncio.Task,
                ) -> AsyncIterator[InternalEvent]:
                    """消费一轮 prompt 的实时 update；轮询间隙检查插入队列，
                    有新消息就 session/cancel 打断本轮（失败则回退等待）."""
                    while not task.done() or not handler.updates.empty():
                        try:
                            update = await asyncio.wait_for(
                                handler.updates.get(),
                                timeout=0.1,
                            )
                        except asyncio.TimeoutError:
                            if (
                                live_message_queue is not None
                                and not interrupt_state["requested"]
                                and not live_message_queue.empty()
                            ):
                                interrupt_state["requested"] = True
                                try:
                                    await client.cancel(
                                        session_id=active_session_id,
                                    )
                                    logger.info(
                                        "opencode prompt interrupted by live message"
                                    )
                                except Exception:
                                    logger.warning(
                                        "opencode session/cancel failed, fallback to waiting",
                                        exc_info=True,
                                    )
                            continue
                        event = self._map_notification(update)
                        if event:
                            yield event

                interrupt_state["requested"] = False
                prompt_task = asyncio.create_task(
                    client.prompt(
                        session_id=active_session_id,
                        prompt=prompt_blocks,
                    )
                )
                async for event in _drain_prompt(prompt_task):
                    yield event

                prompt_response = await prompt_task
                usage_event = self._map_prompt_response_usage(prompt_response)
                if usage_event:
                    yield usage_event
                stop_reason = str(
                    getattr(prompt_response, "stop_reason", "end_turn")
                    or "end_turn"
                )
                if stop_reason == "cancelled":
                    if (
                        interrupt_state["requested"]
                        and live_message_queue is not None
                        and not live_message_queue.empty()
                    ):
                        # 插入打断：不收尾，落入下方插入队列处理，
                        # 用新消息重开一轮。
                        logger.info("opencode prompt cancelled, re-prompting")
                    else:
                        yield InternalEvent(type="status", data={"status": "stopped"})
                        return
                if stop_reason in {"max_tokens", "max_turn_requests", "refusal"}:
                    yield InternalEvent(type="error", data={
                        "message": f"ACP Agent 提前停止：{stop_reason}",
                        "stop_reason": stop_reason,
                    })
                    return
                if prompt.strip() == "/compact":
                    # The advertised ACP command has finished successfully.
                    yield compacted_event()
                    yield InternalEvent(type="status", data={"status": "done"})
                    return

                if live_message_queue is not None:
                    while True:
                        live_items: list[tuple[str, str]] = []
                        while not live_message_queue.empty():
                            live_items.append(live_message_queue.get_nowait())
                        if not live_items:
                            # 插入队列已空：回复即收尾，不等待未来消息。
                            break
                        injected = "\n\n".join(
                            content for _, content in live_items
                        )
                        # 会话层收到 delivered 才封口旧回复并创建新回复。
                        # 必须在新 prompt 产出任何事件前切段，不能等它结束。
                        for message_id, _ in live_items:
                            yield InternalEvent(type="live_message", data={
                                "message_id": message_id,
                                "status": "delivered",
                                "detail": "",
                            })
                        interrupt_state["requested"] = False
                        prompt_task = asyncio.create_task(
                            client.prompt(
                                session_id=active_session_id,
                                prompt=[acp.text_block(injected)],
                            )
                        )
                        async for event in _drain_prompt(prompt_task):
                            yield event
                        prompt_response = await prompt_task
                        usage_event = self._map_prompt_response_usage(prompt_response)
                        if usage_event:
                            yield usage_event
                        stop_reason = str(
                            getattr(prompt_response, "stop_reason", "end_turn")
                            or "end_turn"
                        )
                        if stop_reason == "cancelled" and not (
                            interrupt_state["requested"]
                            and not live_message_queue.empty()
                        ):
                            yield InternalEvent(type="status", data={"status": "stopped"})
                            return
                        if stop_reason in {"max_tokens", "max_turn_requests", "refusal"}:
                            yield InternalEvent(type="error", data={
                                "message": f"ACP Agent 提前停止：{stop_reason}",
                                "stop_reason": stop_reason,
                            })
                            return

                yield InternalEvent(type="status", data={"status": "done"})

        except Exception as e:
            logger.exception("ACP session error")
            yield InternalEvent(type="error", data={"message": str(e)})
        finally:
            self._running = False
            self._process = None
            self._handler = None

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
