"""DeepSeekHarnessEngine — DeepSeek official Harness Python SDK adapter."""

import asyncio
import hashlib
import importlib.metadata
import importlib.util
import inspect
import itertools
import json
import logging
import os
import re
import threading
import time
import uuid
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, AsyncIterator

from engines.core.acp_base import AcpEngineBase
from engines.core.packages import RuntimePackage
from engines.core.base import (
    EngineCapabilities,
    EngineInstallResult,
    EngineModel,
    install_python_package,
)
from engines.core.events import (
    InternalEvent,
    acp_raw_event,
    agent_message_chunk,
    agent_thought_chunk,
    compacted_event,
    tool_call_event,
    tool_call_update_event,
    usage_update_event,
)
from engines.core.plans import plan_event, subagent_event
from engines.core.schema import EngineConfigField, EngineConfigOption, EngineImage
from services import providers as provider_service
from services.config import config_store

logger = logging.getLogger(__name__)

# SDK JSON-RPC 服务端在跨进程恢复已持久化会话失败时，以 JSON-RPC
# Internal error（code -32603）上报，且 message 精确为
# ``session "<id>" already exists``（SDK 0.1.5rc1 实测：persistence.create
# 抛 SessionAlreadyExistsError）。只认“结构化信号”（code + 身份正则，或
# SDK 异常类型名），不做裸字符串匹配——turn 内错误（如工具返回
# "file not found"）绝不能误判为会话丢失。
_SESSION_EXISTS_CODE = -32603
# 只认 session 身份重复 create 的报错，避免把文件已存在等无关错误误判为会话丢失。
_SESSION_EXISTS_RE = re.compile(r'session\s+"[^"]+"\s+already\s+exists')
# 无 code 属性的老世代 SDK（0.1.0rc7）回退：只认持久化层冲突原文，
# 不认裸 "not found"（resume 缺席由服务端内部消化，冒泡出来的 not found
# 另有所指；之前把 turn 内 "file not found" 误判为会话丢失即源于此）。
_LEGACY_SESSION_CONFLICT_MARKERS = (
    "id collision",
    "already has a persisted log",
)


def _is_session_exists_error(exc: BaseException) -> bool:
    """Return True when the SDK error means resume collided with a stored log."""
    code = getattr(exc, "code", None)
    if code is not None:
        return code == _SESSION_EXISTS_CODE and bool(
            _SESSION_EXISTS_RE.search(str(exc))
        )
    name = type(exc).__name__
    if "SessionAlreadyExists" in name:
        return True
    text = f"{name}: {exc}".lower()
    if _SESSION_EXISTS_RE.search(text):
        return True
    return any(marker in text for marker in _LEGACY_SESSION_CONFLICT_MARKERS)


@dataclass
class _PooledHarness:
    harness: Any
    fingerprint: str
    inflight: set[int] = field(default_factory=set)
    last_used: float = field(default_factory=time.monotonic)


class DeepSeekHarnessEngine(AcpEngineBase):
    """Run the official local DeepSeek Harness composition through its SDK."""

    ENGINE_ID = "deepseek_harness"
    # minimum 保留 rc7：适配器通过运行时签名同时兼容两代 SDK；
    # default_version 跟随最新版（0.1.5rc1 起参数改为 dsh_home/patches/dsh_bin）。
    RUNTIME_PACKAGE = RuntimePackage('deepseek-harness-sdk', 'pypi', '0.1.0rc7', '0.1.5rc1')
    UPDATE_PACKAGE = "deepseek-harness-sdk"

    @classmethod
    def supported_provider_protocols(cls) -> set[str]:
        return {"openai_chat_completions"}

    @classmethod
    def provider_required(cls) -> bool:
        return True

    @classmethod
    def supports_provider(cls, provider: dict) -> bool:
        return (
            super().supports_provider(provider)
            and str(provider.get("type") or "") == "deepseek"
        )
    SDK_PACKAGE = "deepseek-harness-sdk==0.1.5rc1"
    DEFAULT_PRESET = "standard"
    # 0.1.0rc7 世代：完整 Cordis 组合（``cordis`` / DSH_CORDIS_CONFIG 环境变量）。
    PRESET_COMPOSITIONS = {
        "standard": (
            Path(__file__).resolve().parent.parent
            / "data"
            / "deepseek-harness"
            / "standard.cordis.yml"
        ),
    }
    # >= 0.1.5rc1 世代：``--profile sdk --patch`` 叠加在 profile 基础树上的补丁列表。
    PRESET_PATCHES = {
        "standard": (
            Path(__file__).resolve().parent.parent
            / "data"
            / "deepseek-harness"
            / "standard.workstep.patch.yml"
        ),
    }

    # 同项目 + 同配置复用同一个 SDK server 进程：server 把已创建会话缓存在
    # 进程内（getOrCreateSession），同进程内同 session_id 的第二轮 prompt
    # 直接命中内存记录、无需跨进程 resume。SDK 0.1.5rc1 的跨进程 resume
    # 已实测损坏（resume 报 not found → 回退 create → AlreadyExists），
    # 每轮 spawn 新建进程即必丢记忆，故必须池化。
    _POOL: dict[str, _PooledHarness] = {}
    _POOL_GUARD = threading.Lock()
    _POOL_IDLE_TTL = 30 * 60.0

    def __init__(self):
        super().__init__()
        self._running = False
        self._harness = None
        self._pool_key: str | None = None
        self._pool_token = -1
        self._run_task: asyncio.Task | None = None
        self._streamed_blocks: set[tuple[int, int, str]] = set()
        self._turn_error_emitted = False
        self._result_discarded = False

    @classmethod
    def _pool_fingerprint(
        cls,
        *,
        project_root: str,
        provider: dict,
        model: str,
        max_tokens: int | None,
        preset: str,
    ) -> str:
        try:
            sdk_version = importlib.metadata.version("deepseek-harness-sdk") or "?"
        except importlib.metadata.PackageNotFoundError:
            sdk_version = "?"
        base_patch = cls.PRESET_PATCHES.get(preset)
        base_composition = cls.PRESET_COMPOSITIONS.get(preset)
        seed = "|".join([
            project_root,
            str(provider.get("base_url") or ""),
            hashlib.sha256(str(provider.get("api_key") or "").encode()).hexdigest()[:16],
            model,
            "" if max_tokens is None else str(max_tokens),
            preset,
            sdk_version,
            cls.get_binary_override() or "",
            str(cls._file_tag(base_patch)),
            str(cls._file_tag(base_composition)),
        ])
        return hashlib.sha256(seed.encode()).hexdigest()[:32]

    @staticmethod
    def _file_tag(path: Path | None) -> str:
        if path is None:
            return "-"
        try:
            stat = path.stat()
            return f"{stat.st_mtime_ns}:{stat.st_size}"
        except OSError:
            return "?"

    @classmethod
    def _acquire_pooled(cls, key: str, fingerprint: str, build) -> tuple[Any, int]:
        """Return (harness, owner_token) for key, building on fingerprint miss."""
        with cls._POOL_GUARD:
            entry = cls._POOL.get(key)
            now = time.monotonic()
            if entry is not None and entry.fingerprint != fingerprint:
                if not entry.inflight:
                    cls._close_entry(key, entry)
                    entry = None
                # 有在途 run 时保留旧实例：本轮仍用旧配置跑完，
                # 新指纹的实例下次 acquire 时再建。
            if entry is None:
                # 顺手回收过期空闲实例，避免配置/项目删减后堆积子进程。
                for stale_key, stale in list(cls._POOL.items()):
                    if not stale.inflight and now - stale.last_used > cls._POOL_IDLE_TTL:
                        cls._close_entry(stale_key, stale)
                entry = _PooledHarness(harness=build(), fingerprint=fingerprint)
                cls._POOL[key] = entry
            entry.last_used = now
            token = next(cls._POOL_TOKEN_SEQ)
            entry.inflight.add(token)
            return entry.harness, token

    _POOL_TOKEN_SEQ = itertools.count(1)

    @classmethod
    def _release_pooled(cls, key: str, token: int, *, close_idle: bool) -> None:
        with cls._POOL_GUARD:
            entry = cls._POOL.get(key)
            if entry is None:
                return
            entry.inflight.discard(token)
            entry.last_used = time.monotonic()
            if close_idle and not entry.inflight:
                cls._close_entry(key, entry)

    @classmethod
    def _close_entry(cls, key: str, entry: _PooledHarness) -> None:
        cls._POOL.pop(key, None)
        harness, entry.harness = entry.harness, None
        if harness is not None:
            try:
                harness.close()
            except Exception:
                logger.warning("DeepSeek Harness pooled runtime close failed", exc_info=True)

    @classmethod
    def shutdown_pool(cls) -> None:
        """Close every pooled runtime (daemon lifespan shutdown)."""
        with cls._POOL_GUARD:
            entries = list(cls._POOL.items())
            cls._POOL.clear()
        for _, entry in entries:
            harness, entry.harness = entry.harness, None
            if harness is None:
                continue
            try:
                harness.close()
            except Exception:
                logger.warning("DeepSeek Harness pooled runtime close failed", exc_info=True)

    @staticmethod
    def is_installed() -> bool:
        try:
            sdk_available = importlib.util.find_spec("deepseek_harness") is not None
        except (ImportError, ValueError):
            sdk_available = False
        return sdk_available and DeepSeekHarnessEngine.resolve_binary() is not None

    @staticmethod
    def is_configured() -> bool:
        config = config_store.get_deepseek_harness_config()
        provider = config_store.get_provider(config.get("provider_id") or "")
        return bool(
            config.get("model")
            and provider
            and provider.get("type") == "deepseek"
            and DeepSeekHarnessEngine.supports_provider(provider)
            and provider.get("enabled", True)
            and str(provider.get("base_url") or "").strip()
            and str(provider.get("api_key") or "").strip()
        )

    @staticmethod
    def get_version() -> str | None:
        try:
            return importlib.metadata.version("deepseek-harness-sdk")
        except importlib.metadata.PackageNotFoundError:
            return None

    @staticmethod
    def resolve_binary() -> str | None:
        override = DeepSeekHarnessEngine.get_binary_override()
        if override is not None:
            return override if os.path.isfile(override) else None
        try:
            from deepseek_harness_runtime import bundled_runtime_path

            path = bundled_runtime_path()
            return str(path) if path else None
        except Exception:
            return None

    @staticmethod
    def install_command() -> str:
        return f"pip install {DeepSeekHarnessEngine.SDK_PACKAGE}"

    async def install(self) -> EngineInstallResult:
        return await install_python_package(self.SDK_PACKAGE)

    @classmethod
    def config_schema(cls) -> list[EngineConfigField]:
        options = tuple(
            EngineConfigOption(str(item["id"]), str(item["name"]))
            for item in config_store.get_providers()
            if item.get("enabled", True) and item.get("type") == "deepseek"
        )
        return [
            EngineConfigField(
                key="provider_id",
                label="DeepSeek 供应商",
                type="select",
                options=options or (EngineConfigOption("", "暂无已启用的 DeepSeek 供应商"),),
                required=True,
                help="复用设置 → 供应商中的 DeepSeek API 地址与密钥。",
            ),
            EngineConfigField(
                key="max_tokens",
                label="最大输出 Token",
                type="number",
                placeholder="留空使用 Harness 默认值",
            ),
            EngineConfigField(
                key="preset",
                label="Agent 预设",
                type="select",
                options=(EngineConfigOption("standard", "标准（推荐）"),),
                required=True,
                help=(
                    "SDK 标准组合：命令、文件、技能、后台任务、子代理、Todo、"
                    "会话恢复与上下文压缩。"
                ),
            ),
        ]

    def get_config_values(self) -> dict:
        config = config_store.get_deepseek_harness_config()
        return {
            "provider_id": config["provider_id"],
            "max_tokens": config["max_tokens"],
            "preset": config.get("preset") or self.DEFAULT_PRESET,
        }

    async def save_config_values(
        self,
        values: dict,
        clear: dict[str, bool] | None = None,
        confirmed: dict[str, bool] | None = None,
    ) -> None:
        provider_id = str(values.get("provider_id") or "").strip()
        provider = await asyncio.to_thread(config_store.get_provider, provider_id)
        if not provider_id:
            raise ValueError("请选择 DeepSeek 供应商")
        if (
            provider is None
            or provider.get("type") != "deepseek"
            or not provider.get("enabled", True)
        ):
            raise ValueError("所选 DeepSeek 供应商不存在或已停用")
        current = await asyncio.to_thread(config_store.get_deepseek_harness_config)
        preset = str(
            values.get("preset", current.get("preset") or self.DEFAULT_PRESET) or ""
        ).strip()
        if preset not in self.PRESET_COMPOSITIONS:
            raise ValueError("DeepSeek Harness preset 不受支持")
        max_tokens = str(values.get("max_tokens", current["max_tokens"]) or "").strip()
        if max_tokens:
            try:
                if int(max_tokens) <= 0:
                    raise ValueError
            except ValueError:
                raise ValueError("最大输出 Token 必须是正整数") from None
        await asyncio.to_thread(
            config_store.set_deepseek_harness_config,
            provider_id=provider_id,
            model=str(current["model"] or "deepseek-v4-flash"),
            max_tokens=max_tokens,
            preset=preset,
        )

    async def list_models(
        self,
        cwd: str,
        provider_id: str | None = None,
        refresh: bool = False,
    ) -> list[EngineModel]:
        config = await asyncio.to_thread(config_store.get_deepseek_harness_config)
        provider = await asyncio.to_thread(
            config_store.get_provider, provider_id or config["provider_id"]
        )
        if provider is None or provider.get("type") != "deepseek":
            return []
        protocol = self.pick_protocol(provider)
        entry = await asyncio.to_thread(
            config_store.get_provider_models, provider["id"], protocol
        )
        if entry and not refresh:
            return await asyncio.to_thread(
                provider_service.saved_models, provider["id"], protocol
            )
        return await provider_service.fetch_and_save_models(
            provider, protocol=protocol
        )

    def _build_harness(
        self,
        *,
        cwd: str,
        provider: dict,
        model: str,
        max_tokens: int | None,
        preset: str,
    ):
        base_composition = self.PRESET_COMPOSITIONS.get(preset)
        base_patch = self.PRESET_PATCHES.get(preset)
        if base_composition is None or base_patch is None:
            raise ValueError(f"Unsupported DeepSeek Harness preset: {preset}")
        if not base_composition.is_file():
            raise FileNotFoundError(
                f"DeepSeek Harness composition not found: {base_composition}"
            )
        if not base_patch.is_file():
            raise FileNotFoundError(f"DeepSeek Harness patch not found: {base_patch}")

        from deepseek_harness import DeepSeekHarness, DeepSeekHarnessConfig

        project_root = Path(cwd).expanduser().resolve()
        controlled_skills = self.project_skills(str(project_root))
        # 两代 SDK 的 config 参数完全不同（0.1.0rc7 用 session_root/cordis/
        # runtime_bin；>= 0.1.5rc1 用 dsh_home/patches/dsh_bin），按已安装
        # SDK 的签名选择世代，避免新版抛 unexpected keyword argument。
        params = inspect.signature(DeepSeekHarnessConfig.__init__).parameters
        kwargs: dict[str, Any] = {
            "provider": "deepseek-official",
            "model": model,
            "max_tokens": max_tokens,
            "cwd": str(project_root),
            "runtime_cwd": str(project_root),
            "base_url": provider_service.provider_runtime_base_url(
                provider, "openai_chat_completions"
            ),
            "api_key": str(provider.get("api_key") or ""),
        }
        if "session_root" in params:
            # 0.1.0rc7 世代：完整组合经 DSH_CORDIS_CONFIG 注入，
            # 会话 JSONL 落在 DSH_SESSION_ROOT 下。
            from services.skill_runtime import prepare_deepseek_composition

            composition = prepare_deepseek_composition(
                controlled_skills, base_composition
            )
            session_root = project_root / ".workstep" / "deepseek-harness" / "sessions"
            session_root.mkdir(parents=True, exist_ok=True)
            kwargs["session_root"] = str(session_root)
            kwargs["cordis"] = str(composition)
            binary_key = "runtime_bin"
        elif "dsh_home" in params:
            # >= 0.1.5rc1 世代：运行时要求显式 DSH_HOME（会话落在
            # ``<dsh_home>/sessions``），组合改为 --patch 叠加层。
            from services.skill_runtime import prepare_deepseek_patch

            patch = prepare_deepseek_patch(controlled_skills, base_patch)
            harness_home = project_root / ".workstep" / "deepseek-harness"
            harness_home.mkdir(parents=True, exist_ok=True)
            kwargs["dsh_home"] = str(harness_home)
            kwargs["patches"] = (str(patch),)
            binary_key = "dsh_bin"
        else:
            try:
                version = importlib.metadata.version("deepseek-harness-sdk")
            except importlib.metadata.PackageNotFoundError:
                version = "unknown"
            raise RuntimeError(
                f"Unsupported DeepSeek Harness SDK signature ({version}); "
                "cannot map WorkStep's session and skill configuration."
            )
        override = self.get_binary_override()
        if override:
            kwargs[binary_key] = override
        return DeepSeekHarness(**kwargs)

    @staticmethod
    def _text_content(blocks: Any) -> str:
        if not isinstance(blocks, list):
            return ""
        parts: list[str] = []
        for block in blocks:
            if not isinstance(block, Mapping):
                continue
            if block.get("type") == "text":
                parts.append(str(block.get("text") or ""))
            elif block.get("type") == "tool-result":
                parts.append(DeepSeekHarnessEngine._text_content(block.get("content")))
        return "".join(parts)

    @staticmethod
    def _tool_input(raw: Any) -> Any:
        if not isinstance(raw, str):
            return raw
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return raw

    def _map_notification(self, notification, root_session_id):
        payload = getattr(notification, "payload", {})
        method = getattr(notification, "method", "")
        if not isinstance(payload, Mapping):
            return self._map_notification_content(notification, root_session_id)
        children = self.__dict__.setdefault("_child_streamed_blocks", {})
        if method == "subagent.started" and payload.get("parentSessionId") == root_session_id:
            children.setdefault(str(payload.get("childSessionId")), set())
        child_id = str(payload.get("sessionId") or "")
        if method == "session.event" and child_id != root_session_id and child_id in children:
            parent_blocks = self._streamed_blocks
            try:
                self._streamed_blocks = children[child_id]
                events = self._map_notification_content(notification, child_id)
            finally:
                self._streamed_blocks = parent_blocks
            frames = []
            for event in events:
                frame = subagent_event(task_id=child_id, status="running", stage="progress")
                frame.data["event"] = event.to_dict()
                frames.append(frame)
            return frames
        return self._map_notification_content(notification, root_session_id)

    def _map_notification_content(
        self,
        notification: Any,
        root_session_id: str,
    ) -> list[InternalEvent]:
        """Map one official SDK notification without leaking child text."""
        method = str(getattr(notification, "method", "") or "")
        payload = getattr(notification, "payload", {})
        if not isinstance(payload, Mapping):
            return [acp_raw_event({"method": method, "payload": payload})]

        if method in {"subagent.started", "subagent.finished"}:
            parent_id = str(payload.get("parentSessionId") or "")
            child_id = str(payload.get("childSessionId") or "")
            if not child_id or (parent_id != root_session_id and child_id == root_session_id):
                return []
            if method == "subagent.started":
                return [subagent_event(
                    task_id=child_id,
                    status="running",
                    stage="started",
                    description=f"DeepSeek Harness 子代理 {child_id}",
                )]
            status = "completed" if payload.get("status") == "ok" else "failed"
            return [subagent_event(
                task_id=child_id,
                status=status,
                stage="finished",
                description=f"DeepSeek Harness 子代理 {child_id}",
                summary=self._text_content(payload.get("lastAssistantMessage")) or None,
            )]

        if method == "session.status":
            if payload.get("sessionId") != root_session_id:
                return []
            status = str(payload.get("status") or "")
            return [InternalEvent(type="status", data={"status": status})]

        if method != "session.event":
            return [acp_raw_event({"method": method, "payload": dict(payload)})]
        if payload.get("sessionId") != root_session_id:
            return []
        event = payload.get("event")
        if not isinstance(event, Mapping):
            return [acp_raw_event({"method": method, "payload": dict(payload)})]
        event_type = str(event.get("type") or "")
        data = event.get("data")
        data = data if isinstance(data, Mapping) else {}

        if event_type == "turn/start":
            self._streamed_blocks.clear()
            return []
        if event_type == "assistant/chunk":
            chunk = data.get("chunk")
            if not isinstance(chunk, Mapping):
                return [acp_raw_event(event)]
            chunk_type = str(chunk.get("type") or "")
            text = str(chunk.get("text") or "")
            if chunk_type in {"text-delta", "reasoning-delta"} and text:
                key = (
                    int(data.get("turn") or 0),
                    int(data.get("step") or 0),
                    chunk_type,
                )
                self._streamed_blocks.add(key)
                factory = (
                    agent_message_chunk
                    if chunk_type == "text-delta"
                    else agent_thought_chunk
                )
                return [factory(text)]
            if chunk_type in {"block-start", "block-end", "tool-call-delta"}:
                return []
            return [acp_raw_event(event)]
        if event_type == "assistant/message":
            result: list[InternalEvent] = []
            turn = int(data.get("turn") or 0)
            step = int(data.get("step") or 0)
            message = data.get("message")
            message = message if isinstance(message, Mapping) else data
            for block in message.get("content", []) if isinstance(message, Mapping) else []:
                if not isinstance(block, Mapping):
                    continue
                block_type = str(block.get("type") or "")
                text = str(block.get("text") or "")
                stream_type = {
                    "text": "text-delta",
                    "reasoning": "reasoning-delta",
                }.get(block_type)
                if not text or stream_type is None:
                    continue
                if (turn, step, stream_type) in self._streamed_blocks:
                    continue
                factory = (
                    agent_message_chunk
                    if block_type == "text"
                    else agent_thought_chunk
                )
                result.append(factory(text))
            usage = data.get("usage")
            if isinstance(usage, Mapping):
                normalized = {
                    "input_tokens": usage.get("inputTokens", usage.get("input_tokens", 0)),
                    "output_tokens": usage.get("outputTokens", usage.get("output_tokens", 0)),
                    "cache_read_input_tokens": usage.get(
                        "cacheReadInputTokens",
                        usage.get("cache_read_input_tokens", 0),
                    ),
                    "cache_creation_input_tokens": usage.get(
                        "cacheCreationInputTokens",
                        usage.get("cache_creation_input_tokens", 0),
                    ),
                }
                result.append(usage_update_event(normalized))
            return result
        if event_type == "tool/call":
            return [tool_call_event(
                tool_call_id=str(data.get("callId") or ""),
                title=str(data.get("name") or "tool"),
                kind="other",
                raw_input=self._tool_input(data.get("arguments")),
            )]
        if event_type == "tool/result":
            message = data.get("message")
            message = message if isinstance(message, Mapping) else data
            source = message.get("source") if isinstance(message, Mapping) else {}
            source = source if isinstance(source, Mapping) else {}
            blocks = message.get("content") if isinstance(message, Mapping) else []
            is_error = bool(data.get("isError"))
            if isinstance(blocks, list):
                for block in blocks:
                    if isinstance(block, Mapping) and block.get("type") == "tool-result":
                        is_error = bool(block.get("isError"))
            return [tool_call_update_event(
                tool_call_id=str(source.get("callId") or data.get("callId") or ""),
                status="failed" if is_error else "completed",
                raw_output=self._text_content(blocks),
            )]
        if event_type == "todo/write":
            todos = data.get("todos")
            return [plan_event(
                item for item in (todos if isinstance(todos, list) else [])
                if isinstance(item, Mapping)
            )]
        if event_type == "compaction/summary":
            return [compacted_event(self._text_content(data.get("summary")) or None)]
        if event_type == "turn/end":
            reason = data.get("reason")
            reason = reason if isinstance(reason, Mapping) else {}
            if reason.get("kind") != "error":
                return []
            failure = reason.get("error") or reason.get("failure")
            failure = failure if isinstance(failure, Mapping) else {}
            message = str(
                failure.get("message")
                or reason.get("message")
                or "DeepSeek Harness 执行失败"
            )
            error_data = {"message": message}
            code = failure.get("code") or reason.get("code")
            if code:
                error_data["code"] = str(code)
            self._turn_error_emitted = True
            return [InternalEvent(type="error", data=error_data)]
        if event_type in {
            "agent/inbox/spliced", "user/message", "step/start", "step/end",
        }:
            return []
        return [acp_raw_event(event)]

    @property
    def capabilities(self) -> EngineCapabilities:
        return EngineCapabilities(
            supports_coordinator=self.is_configured(),
            supports_resume=True,
            supports_tool_disable=False,
            supports_native_schema=False,
            supports_live_step_message=True,
            supports_sessions=True,
            supports_tool_approval=False,
            supports_vision=False,
            supports_workstep_tools=False,
            supports_thinking_effort=False,
        )

    @property
    def supports_sessions(self) -> bool:
        return True

    @property
    def supports_live_step_message(self) -> bool:
        # 轮间续跑：本轮结束后用队列内容在同一会话上再跑一轮。
        return True

    @property
    def supports_resume(self) -> bool:
        return True

    async def spawn(
        self,
        prompt: str,
        cwd: str,
        model: str | None = None,
        session_id: str | None = None,
        images: list[EngineImage] | None = None,
        live_message_queue: asyncio.Queue | None = None,
        **kwargs,
    ) -> AsyncIterator[InternalEvent]:
        """Run the harness, chaining queued live messages as follow-up turns.

        deepseek-harness-sdk 的 ``harness.run`` 是同步阻塞调用，没有运行中
        注入协议。当 ``live_message_queue`` 中出现待插入消息时，本轮结束后
        用合并后的内容在同一会话上再跑一轮（resume 同 session），从而延续
        完整上下文继续作答。
        """
        yield InternalEvent(type="status", data={"status": "initializing"})
        if images:
            yield InternalEvent(
                type="error",
                data={"message": "DeepSeek Harness 当前不支持图片输入"},
            )
            return
        if not await asyncio.to_thread(self.is_installed):
            yield InternalEvent(
                type="error",
                data={"message": "deepseek-harness-sdk 未安装"},
            )
            return

        config = self.merge_config_overrides(
            await asyncio.to_thread(config_store.get_deepseek_harness_config),
            kwargs.get("config_overrides"),
        )
        selected_model = str(
            model
            or await asyncio.to_thread(
                config_store.get_engine_default_model, self.ENGINE_ID
            )
            or config.get("model")
            or "deepseek-v4-flash"
        )
        try:
            provider_runtime = self.resolve_provider_runtime(
                provider_id=str(config.get("provider_id") or ""),
                model=selected_model,
            )
        except ValueError as exc:
            yield InternalEvent(type="error", data={"message": str(exc)})
            return
        provider = await asyncio.to_thread(
            config_store.get_provider, provider_runtime.provider_id
        )
        if (
            provider is None
            or not provider.get("base_url")
            or not provider.get("api_key")
        ):
            yield InternalEvent(
                type="error",
                data={"message": "请先配置可用的 DeepSeek 供应商"},
            )
            return
        raw_max_tokens = str(config.get("max_tokens") or "").strip()
        max_tokens = int(raw_max_tokens) if raw_max_tokens else None
        preset = str(config.get("preset") or self.DEFAULT_PRESET)
        root_session_id = str(session_id or f"session-{uuid.uuid4().hex}")
        event_queue: asyncio.Queue[tuple[str, Any]] = asyncio.Queue()
        loop = asyncio.get_running_loop()
        harness = None
        pool_key: str | None = None
        pool_token = -1

        try:
            project_root = str(Path(cwd).expanduser().resolve())
            fingerprint = self._pool_fingerprint(
                project_root=project_root,
                provider=provider,
                model=selected_model,
                max_tokens=max_tokens,
                preset=preset,
            )
            pool_key = project_root
            build_kwargs = {
                "cwd": cwd,
                "provider": provider,
                "model": selected_model,
                "max_tokens": max_tokens,
                "preset": preset,
            }

            def _build():
                return self._build_harness(**build_kwargs)

            harness, pool_token = await asyncio.to_thread(
                self._acquire_pooled, pool_key, fingerprint, _build
            )
            self._pool_key = pool_key
            self._pool_token = pool_token
            self._harness = harness
            self._running = True
            self._result_discarded = False
            self._streamed_blocks.clear()
            self.__dict__.setdefault("_child_streamed_blocks", {}).clear()
            self._turn_error_emitted = False
            yield InternalEvent(
                type="session_started",
                data={"session_id": root_session_id},
            )
            yield InternalEvent(type="status", data={"status": "running"})

            def on_notification(notification: Any) -> None:
                loop.call_soon_threadsafe(
                    event_queue.put_nowait,
                    ("notification", notification),
                )

            run_session_id = root_session_id
            resumed = session_id is not None
            retried = False
            session_lost_in_stream = False

            async def run_sdk(sid: str, current_prompt: str) -> None:
                try:
                    result = await asyncio.to_thread(
                        harness.run,
                        current_prompt,
                        session_id=sid,
                        on_notification=on_notification,
                    )
                    if self._result_discarded:
                        return
                    await event_queue.put(("result", result))
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    if self._result_discarded:
                        return
                    await event_queue.put(("error", exc))

            current_prompt = prompt
            self._run_task = asyncio.create_task(run_sdk(run_session_id, current_prompt))
            finish_reason: str | None = None
            while True:
                item_type, value = await event_queue.get()
                if item_type == "notification":
                    for event in self._map_notification(value, run_session_id):
                        # The adapter owns top-level lifecycle events. SDK idle/running
                        # notifications only delimit its synchronous run internally.
                        if event.type != "status":
                            yield event
                        if event.type == "error" and _is_session_exists_error(
                            RuntimeError(str(event.data.get("message") or ""))
                        ):
                            session_lost_in_stream = True
                    continue
                if item_type == "error":
                    if resumed and not retried and _is_session_exists_error(value):
                        # 池化后跨进程 resume 已极少发生（仅 daemon 重启后的
                        # 首轮）；此时仍回退全新会话并明示用户。
                        retried = True
                        run_session_id = f"session-{uuid.uuid4().hex}"
                        logger.warning(
                            "DeepSeek Harness failed to restore session %s (%s); "
                            "falling back to a fresh session %s",
                            root_session_id, value, run_session_id,
                        )
                        yield InternalEvent(
                            type="status",
                            data={
                                "status": "session_fallback",
                                "message": (
                                    f"无法恢复之前的会话（{root_session_id}），"
                                    "已自动开启新会话，本次未携带该会话的历史上下文。"
                                ),
                            },
                        )
                        yield InternalEvent(
                            type="session_started",
                            data={"session_id": run_session_id},
                        )
                        self._run_task = asyncio.create_task(run_sdk(run_session_id, current_prompt))
                        continue
                    raise value
                finish_reason = str(getattr(value, "finish_reason", "") or "")
                if (
                    resumed and not retried
                    and session_lost_in_stream and self._turn_error_emitted
                ):
                    # SDK 把会话失效作为流内错误报告（而非抛出异常）：
                    # 同样回退到全新会话重跑，不终止本轮。
                    retried = True
                    session_lost_in_stream = False
                    run_session_id = f"session-{uuid.uuid4().hex}"
                    logger.warning(
                        "DeepSeek Harness session %s unusable (in-stream error); "
                        "falling back to a fresh session %s",
                        root_session_id, run_session_id,
                    )
                    yield InternalEvent(
                        type="status",
                        data={
                            "status": "session_fallback",
                            "message": (
                                f"无法恢复之前的会话（{root_session_id}），"
                                "已自动开启新会话，本次未携带该会话的历史上下文。"
                            ),
                        },
                    )
                    yield InternalEvent(
                        type="session_started",
                        data={"session_id": run_session_id},
                    )
                    self._run_task = asyncio.create_task(run_sdk(run_session_id, current_prompt))
                    continue
                break

            await self._run_task
            if finish_reason in {"aborted", "disposed", "interrupted", "cancelled"}:
                yield InternalEvent(type="status", data={"status": "cancelled"})
            elif finish_reason == "error":
                if not self._turn_error_emitted:
                    yield InternalEvent(
                        type="error",
                        data={"message": "DeepSeek Harness 执行失败"},
                    )
            else:
                # 本轮结束：有待插入消息时在同一会话上续跑一轮（轮间续跑，
                # 非运行中打断；语义与 codex exec 的 resume 重启一致）。
                pending: list[str] = []
                if live_message_queue is not None:
                    while not live_message_queue.empty():
                        try:
                            item = live_message_queue.get_nowait()
                        except asyncio.QueueEmpty:
                            break
                        content = item[1] if isinstance(item, tuple) else item
                        text = str(content or "").strip()
                        if text:
                            pending.append(text)
                if pending:
                    current_prompt = "\n\n".join(pending)
                    resumed = True
                    self._run_task = asyncio.create_task(
                        run_sdk(run_session_id, current_prompt)
                    )
                    finish_reason = None
                    while True:
                        item_type, value = await event_queue.get()
                        if item_type == "notification":
                            for event in self._map_notification(value, run_session_id):
                                if event.type != "status":
                                    yield event
                            continue
                        if item_type == "error":
                            raise value
                        finish_reason = str(getattr(value, "finish_reason", "") or "")
                        break
                    await self._run_task
                    # 续跑轮只处理一批：再有新的插入留给上层下一轮调度。
                    while live_message_queue is not None and not live_message_queue.empty():
                        try:
                            live_message_queue.get_nowait()
                        except asyncio.QueueEmpty:
                            break
                        yield InternalEvent(
                            type="status",
                            data={
                                "status": "live_message_deferred",
                                "message": "本轮已有续跑插入，新的插入消息请在下一轮发送",
                            },
                        )
                        break
                yield InternalEvent(type="status", data={"status": "done"})
        except asyncio.CancelledError:
            yield InternalEvent(type="status", data={"status": "cancelled"})
        except Exception as exc:
            logger.exception("DeepSeekHarnessEngine spawn error")
            yield InternalEvent(type="error", data={"message": str(exc)})
        finally:
            task, self._run_task = self._run_task, None
            if task is not None and not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            # 正常结束只归还租约、保留池化实例给下一轮（同进程 resume 即记忆）。
            # 主动 stop()/cancel 走 _detach_pooled 关闭空闲实例。
            if pool_key is not None and pool_token >= 0:
                await asyncio.to_thread(
                    self._release_pooled, pool_key, pool_token, close_idle=False
                )
            self._harness = None
            self._pool_key = None
            self._pool_token = -1
            self._running = False

    async def stop(self) -> None:
        self._running = False
        self._result_discarded = True
        task, self._run_task = self._run_task, None
        if task is not None and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        pool_key, self._pool_key = self._pool_key, None
        pool_token, self._pool_token = self._pool_token, -1
        harness, self._harness = self._harness, None
        if pool_key is None or harness is None:
            return
        # SDK server 没有单会话 cancel 接口：先归还本轮租约，只有当池实例
        # 上没有其它在途 run 时才关闭它，否则仅摘除本轮（后台线程跑完后
        # 结果直接丢弃），避免把同项目其它会话的 server 进程一起杀掉。
        await asyncio.to_thread(
            self._release_pooled, pool_key, pool_token, close_idle=True
        )

    async def create_session(
        self,
        cwd: str,
        add_dirs: list[str] | None = None,
        mcp_servers: list | None = None,
    ) -> str | None:
        # The official SDK creates and persists a session lazily on first prompt.
        return None

    async def resume_session(
        self,
        session_id: str,
        cwd: str,
        add_dirs: list[str] | None = None,
        mcp_servers: list | None = None,
    ) -> bool:
        # spawn(session_id=...) is the SDK's native resume seam.
        return bool(session_id)

    async def close_session(self, session_id: str, cwd: str | None = None) -> None:
        if self._running:
            await self.stop()

    async def cancel_session(self, session_id: str, cwd: str | None = None) -> None:
        if self._running:
            await self.stop()

    def build_resume_params(self, session_id: str) -> dict:
        return {"session_id": session_id}

    acp_events: frozenset[str] = frozenset({
        "agent_message_chunk",
        "agent_thought_chunk",
        "tool_call",
        "tool_call_update",
        "plan",
        "usage_update",
        "status",
        "session_started",
        "compacted",
        "subagent",
        "error",
        "acp_raw",
    })
