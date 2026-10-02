"""HermesEngine — JSON-RPC bidirectional communication."""

import asyncio
import json
import logging
import os
import shutil
from typing import AsyncIterator

from acp import schema

from engines.core.acp_base import AcpEngineBase
from engines.core.base import EngineModel, ProviderRuntimeConfig
from engines.core.plans import plan_event
from engines.core.events import (
    InternalEvent,
    acp_raw_event,
    usage_update_event,
)
from engines.core.schema import EngineImage
from engines.core.stream_lines import ChunkedLineReader
from services import providers as provider_service

logger = logging.getLogger(__name__)


class HermesEngine(AcpEngineBase):
    ENGINE_ID = "hermes"

    # Hermes 按 ACP 规范在 session/load 内重播整段历史，不丢弃会被当成
    # 新一轮事件写入新消息正文（旧文复读）。
    DROP_REPLAYED_HISTORY_ON_RESUME = True

    """Hermes ACP engine using JSON-RPC over stdin/stdout.

    Lifecycle: initialize → session/new → session/prompt → stream updates.
    Surfaces ACP permission requests through WorkStep's interaction UI.
    """

    @classmethod
    def supported_provider_protocols(cls) -> set[str]:
        # Hermes 自带供应商配置（~/.hermes/config.yaml），不消费 WorkStep
        # 供应商：协议集置空 → 全链路 supports_provider 为 False，引擎设置、
        # 对话、任务里的供应商选择器自动隐藏（基类与前端均按空集处理，无需
        # 改 core 或前端）。凭据走下面的 build_native_runtime 镜像。
        return set()

    def resolve_provider_id(self, provider_id: str | None = None) -> str:
        # 不接受任何 WorkStep 供应商绑定（显式覆盖、全局 managed 默认、
        # 引擎映射一律忽略）：本引擎凭据只来自 Hermes 自身配置 + native
        # 镜像。忽略而非报错，避免历史残留映射把运行直接炸掉。
        selected = str(provider_id or "").strip()
        if selected:
            logger.debug("Hermes ignores WorkStep provider binding %s", selected)
        return ""

    def build_native_runtime(self, model):
        # 未在 WorkStep 绑定供应商时，Hermes 跑它自己的默认供应商（创建轮
        # 一直如此）。但恢复轮要在新进程里按持久化的裸供应商名
        # （如 "custom"）重建 agent，Hermes 自身解析对局域网地址不读
        # OPENAI_* 回退，裸名会解到无 key 的默认端点导致恢复失败。
        # 这里把 Hermes 默认供应商的 base_url/api_key 镜像成 OPENAI_*
        # 注入子进程：创建轮不受影响（具名解析优先），恢复轮重建时有 key
        # 可用。读的是 Hermes 自己的配置，不引入 WorkStep 侧映射依赖。
        return ProviderRuntimeConfig(
            model=model,
            protocol="openai_chat_completions",
            env=self._hermes_default_provider_env(),
        )

    @staticmethod
    def _hermes_default_provider_env() -> dict:
        """Mirror Hermes' own default custom-provider credentials as env.

        只读 ``~/.hermes/config.yaml`` 的默认供应商条目；任何异常（缺文件、
        格式变化、无 key）都返回空，由上层的 session_fallback 兜底。
        """
        try:
            import yaml
        except Exception:
            return {}
        try:
            with open(
                os.path.join(os.path.expanduser("~"), ".hermes", "config.yaml"),
                encoding="utf-8",
            ) as f:
                config = yaml.safe_load(f) or {}
        except Exception:
            return {}
        try:
            model_cfg = config.get("model") or {}
            provider_ref = (
                str(model_cfg.get("provider") or "").strip().lower()
                if isinstance(model_cfg, dict) else ""
            )
            name = (
                provider_ref.split(":", 1)[1].strip()
                if provider_ref.startswith("custom:") else ""
            )
            if not name:
                return {}
            entries: list = []
            for section in (config.get("custom_providers"), config.get("providers")):
                if isinstance(section, dict):
                    section = [
                        {"name": key, **(value or {})}
                        for key, value in section.items()
                        if isinstance(value, dict)
                    ]
                if isinstance(section, list):
                    entries.extend(e for e in section if isinstance(e, dict))
            match = next(
                (
                    e for e in entries
                    if str(e.get("name") or "").strip().lower() == name
                ),
                None,
            )
            if match is None:
                return {}
            api_key = str(match.get("api_key") or "").strip()
            if not api_key:
                key_env = str(match.get("key_env") or "").strip()
                if key_env:
                    api_key = os.environ.get(key_env, "").strip()
            base_url = str(match.get("base_url") or "").strip()
            env: dict[str, str] = {}
            if api_key:
                env["OPENAI_API_KEY"] = api_key
            if base_url:
                env["OPENAI_BASE_URL"] = base_url
            return env
        except Exception:
            logger.debug("Failed to mirror Hermes default provider env", exc_info=True)
            return {}

    def build_provider_runtime(self, provider, model, protocol=None):
        # 本引擎只消费 OpenAI Chat Completions 协议（protocol 由基类解析）。
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

    def __init__(self):
        super().__init__()
        self._process: asyncio.subprocess.Process | None = None
        self._running = False
        self._request_id = 0
        self._stdout_reader: ChunkedLineReader | None = None

    @staticmethod
    def is_installed() -> bool:
        return HermesEngine.resolve_binary() is not None

    @staticmethod
    def get_version() -> str | None:
        binary = HermesEngine.resolve_binary()
        if not binary:
            return None
        try:
            import subprocess
            out = subprocess.run([binary, "--version"], capture_output=True, text=True, timeout=5)
            return out.stdout.strip() if out.returncode == 0 else None
        except Exception:
            return None

    @staticmethod
    def resolve_binary() -> str | None:
        override = HermesEngine.get_binary_override()
        if override is not None:
            return override if os.path.isfile(override) else None
        env_bin = os.environ.get("HERMES_BIN")
        if env_bin and os.path.isfile(env_bin):
            return env_bin
        return shutil.which("hermes")

    def get_command(self) -> list[str]:
        binary = self.resolve_binary()
        if not binary:
            return []
        return [binary, "acp", "--accept-hooks"]

    # 不再为 hermes 构建 per-project HERMES_HOME：
    # 隔离 home 会在每轮重建时毁掉 hermes 自己的会话持久化（state.db），
    # 导致第二轮 session 恢复失败（hermes 把 session-not-found 误报为
    # stop_reason="refusal"）。让引擎用全局 ~/.hermes 自管会话与技能，
    # WorkStep 只负责把项目目录作为 cwd 传给引擎。

    def get_permission_mode(self) -> str:
        """ACP permissions must be decided by the user, never auto-approved."""
        return "ask"

    def _next_id(self) -> int:
        self._request_id += 1
        return self._request_id

    async def _send_rpc(self, method: str, params: dict | None = None) -> int:
        """Send a JSON-RPC request to stdin. Returns request ID."""
        req_id = self._next_id()
        msg = {
            "jsonrpc": "2.0",
            "id": req_id,
            "method": method,
        }
        if params:
            msg["params"] = params
        data = json.dumps(msg) + "\n"
        self._process.stdin.write(data.encode())
        await self._process.stdin.drain()
        return req_id

    async def _send_response(self, req_id: int, result: dict):
        """Send a JSON-RPC response (for permission approvals)."""
        msg = {"jsonrpc": "2.0", "id": req_id, "result": result}
        data = json.dumps(msg) + "\n"
        self._process.stdin.write(data.encode())
        await self._process.stdin.drain()

    # Hermes 把 load 失败吞掉、随后用 stop_reason="refusal" 冒泡（实测：
    # 服务端 log 报 "load_session: session ... not found" /
    # "prompt: session ... not found"，起因是持久化会话的 provider 凭据在新
    # 进程里解析失败 "No LLM provider configured"）。基类把 refusal 直接判
    # error，且重试仍带同一个坏 session，导致连跪两次。这里识别
    # “resume 轮零内容直接 refusal” 为会话丢失，回退全新会话重跑一次。
    # 有真实内容后才 refusal 的视为模型正常拒答，不回退（避免丢上下文）。
    _RESUME_LOST_REFUSAL_MESSAGE = "ACP Agent 提前停止：refusal"
    _CONTENT_EVENT_TYPES = frozenset({
        "agent_message_chunk",
        "agent_thought_chunk",
        "user_message_chunk",
        "tool_call",
        "tool_call_update",
        "plan",
        "plan_update",
        "usage_update",
        "acp_raw",
    })

    # Hermes 按 ACP 规范在 session/load 请求内把整段历史重播成
    # session/update；不丢弃会被当成新一轮事件写入新消息正文（旧文复读）。
    # 基类在 load 返回后、prompt 发出前 yield session_started，生成器在此
    # 挂起：此时队列里的内容型 update 只能是重播（本轮 prompt 还没发，
    # 不可能有 live 输出），同步丢弃即精准过滤。状态类 update 原样保留。
    _REPLAYED_UPDATE_TYPES: tuple[type, ...] = tuple(
        t for t in (
            getattr(schema, name, None) for name in (
                "AgentMessageChunk",
                "AgentThoughtChunk",
                "UserMessageChunk",
                "ToolCallStart",
                "ToolCallProgress",
                "AgentPlanUpdate",
                "Plan",
                "AgentPlanContentUpdate",
                "AgentPlanRemovedUpdate",
            )
        ) if t is not None
    )

    def _drain_replayed_history(self) -> int:
        """同步丢弃 load 重播进队列的历史内容 update，返回丢弃数。

        必须在基类 yield session_started 的挂起点调用（同步、无 await）：
        load 已返回、prompt 未发出，命中即重播；之后排入的 live 与状态类
        update 不受影响。
        """
        handler = getattr(self, "_handler", None)
        queue = getattr(handler, "updates", None)
        if queue is None:
            return 0
        kept: list = []
        dropped = 0
        while not queue.empty():
            try:
                update = queue.get_nowait()
            except Exception:
                break
            if isinstance(update, self._REPLAYED_UPDATE_TYPES):
                dropped += 1
            else:
                kept.append(update)
        for update in kept:
            queue.put_nowait(update)
        if dropped:
            logger.info("Dropped %d replayed history updates", dropped)
        return dropped

    async def _spawn_once(
        self,
        prompt: str,
        cwd: str,
        model: str | None,
        add_dirs: list[str] | None,
        session_id: str | None,
        images: list[EngineImage] | None,
        live_message_queue: asyncio.Queue | None,
        config_overrides: dict | None,
        thinking_effort: str | None,
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
            if event.type == "error" and (event.data.get("message") or "") == "Internal error":
                # Hermes 服务端把真实原因吞成无意义的 Internal error（实测最常见
                # 的是自身未配置供应商）；转成可行动的提示，而不是让用户干瞪眼。
                event = InternalEvent(type="error", data={
                    **event.data,
                    "message": (
                        "Hermes 内部错误（Internal error）：可能是 Hermes 自身未配置"
                        "可用的模型供应商（与 WorkStep 供应商配置无关），请在终端运行"
                        " `hermes model` 选择供应商，或 `hermes setup` 完成首次配置"
                    ),
                })
            yield event

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
        if not session_id:
            async for event in self._spawn_once(
                prompt=prompt,
                cwd=cwd,
                model=model,
                add_dirs=add_dirs,
                session_id=None,
                images=images,
                live_message_queue=live_message_queue,
                config_overrides=config_overrides,
                thinking_effort=thinking_effort,
            ):
                yield event
            return

        resumed_session_id = session_id
        seen_content = False
        terminal_refusal = False
        replay_drained = False
        async for event in self._spawn_once(
            prompt=prompt,
            cwd=cwd,
            model=model,
            add_dirs=add_dirs,
            session_id=resumed_session_id,
            images=images,
            live_message_queue=live_message_queue,
            config_overrides=config_overrides,
            thinking_effort=thinking_effort,
        ):
            if event.type == "session_started" and not replay_drained:
                # 基类刚从 load 返回、prompt 尚未发出：清掉重播 history。
                replay_drained = True
                self._drain_replayed_history()
            if event.type in self._CONTENT_EVENT_TYPES:
                seen_content = True
            if (
                event.type == "error"
                and not seen_content
                and (event.data.get("message") or "")
                == self._RESUME_LOST_REFUSAL_MESSAGE
            ):
                terminal_refusal = True
                break
            yield event
        if not terminal_refusal:
            return

        logger.warning(
            "Hermes session %s unusable (refusal with no content after load); "
            "falling back to a fresh session",
            resumed_session_id,
        )
        yield InternalEvent(
            type="status",
            data={
                "status": "session_fallback",
                "message": (
                    f"无法恢复之前的会话（{resumed_session_id}），"
                    "已自动开启新会话，本次未携带该会话的历史上下文。"
                ),
            },
        )
        async for event in self._spawn_once(
            prompt=prompt,
            cwd=cwd,
            model=model,
            add_dirs=add_dirs,
            session_id=None,
            images=images,
            live_message_queue=live_message_queue,
            config_overrides=config_overrides,
            thinking_effort=thinking_effort,
        ):
            yield event

    def _stdout_lines(self) -> ChunkedLineReader:
        """返回与当前进程 stdout 绑定的分块行读取器（跨多次调用复用缓冲）。

        Hermes 的 JSON-RPC 单行可能远超 asyncio StreamReader 默认 64KiB limit，
        直接 ``readline()`` 会抛 "Separator is not found, and chunk exceed the limit"
        并清空已缓冲数据。
        """
        stdout = self._process.stdout
        reader = self._stdout_reader
        if reader is None or reader.stream is not stdout:
            reader = ChunkedLineReader(stdout)
            self._stdout_reader = reader
        return reader

    async def _read_until_response(self, target_id: int) -> dict | None:
        """Read lines until we get a response matching target_id."""
        async for line in self._stdout_lines():
            line = line.decode(errors="replace").strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if obj.get("id") == target_id:
                return obj
        return None

    async def _stream_until_prompt_done(self, prompt_id: int) -> AsyncIterator[InternalEvent]:
        """Stream events until prompt response is received."""
        async for line in self._stdout_lines():
            line = line.decode(errors="replace").strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue

            # Check if this is the prompt completion response
            if obj.get("id") == prompt_id:
                return

            # Handle notifications (session/update)
            if obj.get("method") == "session/update":
                params = obj.get("params", {})
                event = self._map_update(params)
                if event:
                    yield event

            # Handle permission requests — auto-approve
            if obj.get("method") == "session/request_permission":
                req_id = obj.get("id")
                if req_id is not None:
                    await self._send_response(req_id, {"decision": "allow_always"})

    def _map_update(self, params: dict) -> InternalEvent | None:
        """Map a ``session/update`` notification to the ACP-vocabulary event.

        与 ``AcpEngineBase._map_notification`` 对齐：全部 session update 类型
        按 ACP 字段形状产出；未知 update 透传 ``acp_raw`` 不再静默丢弃。
        """
        update_type = params.get("type", "")

        if update_type == "agent_message_chunk":
            content = params.get("content", {})
            if isinstance(content, dict) and content.get("type") == "text":
                return InternalEvent(
                    type="agent_message_chunk",
                    data={"content": {"text": content.get("text", "")}},
                )

        if update_type == "agent_thought_chunk":
            content = params.get("content", {})
            if isinstance(content, dict) and content.get("type") == "text":
                return InternalEvent(
                    type="agent_thought_chunk",
                    data={"content": {"text": content.get("text", "")}},
                )

        if update_type == "user_message_chunk":
            content = params.get("content", {})
            if isinstance(content, dict) and content.get("type") == "text":
                return InternalEvent(
                    type="user_message_chunk",
                    data={"content": {"text": content.get("text", "")}},
                )

        if update_type == "tool_call":
            data = {
                "tool_call_id": str(
                    params.get("toolCallId") or params.get("id") or ""
                ),
                "title": str(
                    params.get("title") or params.get("name") or "tool"
                ),
            }
            if params.get("kind"):
                data["kind"] = params["kind"]
            if params.get("rawInput") is not None:
                data["raw_input"] = params["rawInput"]
            elif params.get("input") is not None:
                data["raw_input"] = params["input"]
            return InternalEvent(type="tool_call", data=data)

        if update_type == "tool_call_update":
            data: dict = {
                "tool_call_id": str(
                    params.get("toolCallId") or params.get("id") or ""
                ),
                "status": str(
                    params.get("status")
                    or ("completed" if params.get("output") is not None else "in_progress")
                ),
            }
            if params.get("rawInput") is not None:
                data["raw_input"] = params["rawInput"]
            elif params.get("input") is not None:
                data["raw_input"] = params["input"]
            if params.get("rawOutput") is not None:
                data["raw_output"] = params["rawOutput"]
            elif params.get("output") is not None:
                data["raw_output"] = params["output"]
            if params.get("title"):
                data["title"] = params["title"]
            if params.get("kind"):
                data["kind"] = params["kind"]
            return InternalEvent(type="tool_call_update", data=data)

        if update_type == "plan":
            return plan_event(self._plan_entries(params))

        if update_type == "plan_update":
            data: dict = {"id": str(params.get("id") or "")}
            if params.get("type"):
                data["type"] = params["type"]
            if params.get("content") is not None:
                data["content"] = params["content"]
            elif params.get("uri") is not None:
                data["uri"] = params["uri"]
            elif params.get("entries") is not None:
                data["entries"] = self._plan_entries(params)
            return InternalEvent(type="plan_update", data=data)

        if update_type == "plan_removed":
            return InternalEvent(type="plan_removed", data={"id": str(params.get("id") or "")})

        if update_type == "usage_update":
            return usage_update_event(params)

        if update_type == "session_info_update":
            data: dict = {}
            if params.get("title") is not None:
                data["title"] = params["title"]
            if params.get("updatedAt") is not None:
                data["updated_at"] = params["updatedAt"]
            return InternalEvent(type="session_info_update", data=data)

        if update_type == "available_commands_update":
            return InternalEvent(
                type="available_commands_update",
                data={"available_commands": params.get("availableCommands") or []},
            )

        if update_type == "config_option_update":
            return InternalEvent(
                type="config_option_update",
                data={"config_options": params.get("configOptions") or []},
            )

        if update_type == "current_mode_update":
            return InternalEvent(
                type="current_mode_update",
                data={"current_mode_id": str(params.get("currentModeId") or "")},
            )

        if update_type == "mcp_message":
            data: dict = {
                "connection_id": str(params.get("connectionId") or ""),
                "method": str(params.get("method") or ""),
            }
            if params.get("params") is not None:
                data["params"] = params["params"]
            return InternalEvent(type="mcp_message", data=data)

        if update_type == "elicitation_completed":
            return InternalEvent(
                type="elicitation_completed",
                data={"elicitation_id": str(params.get("elicitationId") or "")},
            )

        return acp_raw_event(params)

    @staticmethod
    def _plan_entries(params: dict) -> list[dict]:
        entries = params.get("entries")
        if not isinstance(entries, list):
            return []
        return [
            {
                "content": str(entry.get("content") or ""),
                "priority": str(entry.get("priority") or "medium"),
                "status": str(entry.get("status") or "pending"),
            }
            for entry in entries
            if isinstance(entry, dict)
        ]

    async def stop(self) -> None:
        if self._process and self._running:
            self._process.stdin.close()
            try:
                await asyncio.wait_for(self._process.wait(), timeout=3)
            except asyncio.TimeoutError:
                self._process.terminate()
                try:
                    await asyncio.wait_for(self._process.wait(), timeout=2)
                except asyncio.TimeoutError:
                    self._process.kill()
            self._running = False

    async def inject_response(self, tool_use_id: str, content: str) -> None:
        logger.warning("inject_response not implemented for Hermes")

    @property
    def supports_resume(self) -> bool:
        return True

    @property
    def supports_thinking_effort(self) -> bool:
        """Best-effort via ACP ``reasoning_effort`` config option."""
        return True

    @property
    def supports_interactive(self) -> bool:
        return True

    def build_resume_params(self, session_id: str) -> dict:
        return {"session_id": session_id}

    @staticmethod
    def _agent_capability(response, name=None, nested=None):
        # Hermes 虽声明 sessionCapabilities.resume，但实测 session/resume
        # 直接报 Internal error；续轮统一走 session/load（实测恢复上下文
        # 且不重播历史），隐藏坏掉的 resume 能力避免基类误入。
        if name == "session_capabilities" and nested == "resume":
            return None
        return AcpEngineBase._agent_capability(response, name, nested)

    async def list_models(self, cwd: str) -> list[EngineModel]:
        # Hermes 自管 provider/模型，session/new 失败（如 provider 未配置
        # 或额度耗尽）时不抛错：配置页降级为仅默认模型，而不是整页报错。
        try:
            return await super().list_models(cwd)
        except Exception as exc:
            logger.warning("hermes list_models 失败，已降级为空列表: %s", exc)
            return []
