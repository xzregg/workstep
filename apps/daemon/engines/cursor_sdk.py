"""CursorSdkEngine — Cursor 官方 Python SDK 引擎（``cursor-sdk`` + 内置 bridge）。

Cursor SDK 通过本地 bridge 运行 agent。鉴权使用 Cursor 账号 API key
（``CURSOR_API_KEY`` 或配置项）。

非 ACP 原生传输适配器：将 SDK ``run.messages()`` 的消息映射为 ACP 对齐事件。
"""

import asyncio
import importlib.metadata
import importlib.util
import logging
import os
from typing import AsyncIterator, ClassVar

from engines.core.acp_base import AcpEngineBase
from engines.core.base import ProviderRuntimeConfig
from engines.core.events import InternalEvent
from engines.core.packages import RuntimePackage
from engines.core.schema import EngineConfigField, EngineImage
from services.config import config_store

logger = logging.getLogger(__name__)


def _sdk_available() -> bool:
    return importlib.util.find_spec("cursor_sdk") is not None


class CursorSdkEngine(AcpEngineBase):
    ENGINE_ID = "cursor"

    #: 按需安装：默认不随 daemon 打包，设置页安装按钮执行 pip install cursor-sdk。
    RUNTIME_PACKAGE: ClassVar[RuntimePackage] = RuntimePackage(
        "cursor-sdk", "pypi", "1.0.32", None
    )

    # 非 ACP 原生：无 COMMAND，基类 _is_acp_native 为 False。
    # 安装态 = Python 包可导入（运行时随包自带），配置态 = 有 API key。

    # ------------------------------------------------------------- 发现/安装

    @staticmethod
    def is_installed() -> bool:
        return _sdk_available()

    @staticmethod
    def get_version() -> str | None:
        if not _sdk_available():
            return None
        try:
            return importlib.metadata.version("cursor-sdk")
        except Exception:
            return None

    @staticmethod
    def install_command() -> str:
        return "pip install cursor-sdk"

    async def install(self):
        """按需安装官方 ``cursor-sdk``（pip 包自带 bridge + node 运行时）。"""
        from engines.core.base import install_python_package

        return await install_python_package("cursor-sdk")

    @staticmethod
    def resolve_binary() -> str | None:
        """展示用：返回自带 bridge 入口（非 spawn 依赖）。"""
        if not _sdk_available():
            return None
        try:
            import cursor_sdk

            root = os.path.dirname(cursor_sdk.__file__)
            cand = os.path.join(root, "_vendor", "bridge", "bin", "cursor-sdk-bridge")
            return cand if os.path.isfile(cand) else None
        except Exception:
            return None

    @classmethod
    def config_schema(cls) -> list[EngineConfigField]:
        return [
            EngineConfigField(
                key="api_key",
                label="Cursor API Key",
                type="password",
                placeholder="crsr-...",
                required=True,
                help="Cursor 账号 API Key（Settings → API Keys），留空时回退 CURSOR_API_KEY 环境变量",
                sensitive=True,
            ),
        ]

    def _api_key(self) -> str:
        return str(config_store.get("cursor_sdk_api_key", "") or os.environ.get("CURSOR_API_KEY", ""))

    def get_config_values(self) -> dict:
        return {"api_key": ""}

    def get_config_secrets(self) -> dict[str, bool]:
        return {"api_key": bool(config_store.get("cursor_sdk_api_key", ""))}

    def reveal_config_value(self, key: str) -> str | None:
        return str(config_store.get("cursor_sdk_api_key", "") or "") if key == "api_key" else None

    async def save_config_values(
        self,
        values: dict,
        clear: dict[str, bool] | None = None,
        confirmed: dict[str, bool] | None = None,
    ) -> None:
        key = str(values.get("api_key") or "").strip()
        if key:
            await asyncio.to_thread(config_store.set, "cursor_sdk_api_key", key)
        elif (clear or {}).get("api_key"):
            await asyncio.to_thread(config_store.delete, "cursor_sdk_api_key")

    def is_configured(self) -> bool:
        return self.is_installed() and bool(self._api_key())

    # ------------------------------------------------------------------ 能力

    @property
    def supports_sessions(self) -> bool:
        return self.is_installed()

    @property
    def supports_resume(self) -> bool:
        # SDK 提供 client.agents.resume（按 agent id 恢复）。
        return self.is_installed()

    @property
    def supports_vision(self) -> bool:
        return False  # 未实测，保守声明

    @property
    def supports_thinking_effort(self) -> bool:
        return False

    @property
    def supports_tool_approval(self) -> bool:
        # SDK 未暴露逐工具审批 API（工具执行受 Cursor 沙箱/auto-run 纪律约束），
        # 如实声明为不支持；上层据此提示用户。
        return False

    @classmethod
    def supported_provider_protocols(cls) -> set[str] | None:
        # 使用 Cursor 自身鉴权（Composer 系列模型），不接 WorkStep Provider。
        return set()

    def build_provider_runtime(self, provider, model, protocol=None):
        return ProviderRuntimeConfig(
            provider_id=str(provider.get("id") or ""), model=model
        )

    @property
    def acp_events(self) -> set[str]:
        # 声明 = 实际：SDK 事件词汇映射后产出的 ACP 对齐事件。
        # 仅声明 ACP 词汇内的内容事件（session_started/done 为内部编排事件，
        # 不在契约词表内，不声明）。
        return {
            "agent_message_chunk",
            "agent_thought_chunk",
            "tool_call",
            "tool_call_update",
            "usage_update",
        }

    # ------------------------------------------------------------------ 执行

    _active_runs: ClassVar[dict[str, tuple]] = {}

    def build_resume_params(self, session_id: str) -> dict:
        return {"session_id": session_id}

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
        self.require_native_credentials_allowed()
        api_key = await asyncio.to_thread(self._api_key)
        if not api_key:
            yield InternalEvent(
                "done",
                {"stop_reason": "error", "error": "未配置 Cursor API Key（设置页填写或 CURSOR_API_KEY 环境变量）"},
            )
            return
        try:
            from cursor_sdk import (
                AsyncClient,
                AgentOptions,
                LocalAgentOptions,
                SendOptions,
            )
        except ImportError as exc:
            yield InternalEvent("done", {"stop_reason": "error", "error": f"cursor_sdk 未安装: {exc}"})
            return

        client = None
        agent = None
        run = None
        agent_id = session_id
        try:
            client = await AsyncClient.launch_bridge(workspace=cwd)
            options = AgentOptions(
                api_key=api_key,
                local=LocalAgentOptions(cwd=cwd, **({"dirs": add_dirs} if add_dirs else {})),
                **({"model": model} if model else {}),
            )
            if session_id:
                agent = await client.agents.resume(session_id, options)
            else:
                agent = await client.agents.create(
                    model=model or "auto",
                    api_key=api_key,
                    local=LocalAgentOptions(cwd=cwd),
                )
            agent_id = getattr(agent, "agent_id", None) or session_id
            if agent_id:
                yield InternalEvent("session_started", {"session_id": agent_id})

            run = await agent.send(
                prompt,
                SendOptions(**({"model": model} if model else {})),
            )
            self._active_runs[agent_id or f"cwd:{cwd}"] = (client, agent, run)
            try:
                async for event in run.messages():
                    mapped = self._map_sdk_event(event)
                    if mapped is not None:
                        yield mapped
                result = await run.wait()
                usage = self._usage_payload(getattr(result, "usage", None))
                stop_reason = str(getattr(result, "status", None) or "completed")
            finally:
                self._active_runs.pop(agent_id or f"cwd:{cwd}", None)
            if usage:
                yield InternalEvent("usage_update", usage)
            yield InternalEvent("done", {"stop_reason": stop_reason})
        except Exception as exc:  # noqa: BLE001 — spawn 失败转 done(error)
            self._active_runs.pop(agent_id or f"cwd:{cwd}", None)
            logger.warning("cursor_sdk spawn 失败: %s", exc)
            yield InternalEvent("done", {"stop_reason": "error", "error": str(exc)})
        finally:
            if agent is not None:
                try:
                    await agent.close()
                except Exception:
                    pass
            if client is not None:
                try:
                    await client.aclose()
                except Exception:
                    pass

    def _map_sdk_event(self, event) -> InternalEvent | None:
        """Map the documented SDKMessage stream to ACP content events."""
        kind = getattr(event, "type", None)
        if kind == "assistant":
            message = getattr(event, "message", None)
            blocks = getattr(message, "content", ()) or ()
            text = "".join(
                str(getattr(block, "text", ""))
                for block in blocks if getattr(block, "type", None) == "text"
            )
            return InternalEvent("agent_message_chunk", {"text": text}) if text else None
        if kind == "thinking":
            return InternalEvent("agent_thought_chunk", {"text": str(getattr(event, "text", ""))})
        if kind == "tool_call":
            call_id = str(getattr(event, "call_id", ""))
            status = str(getattr(event, "status", ""))
            if status == "running":
                return InternalEvent("tool_call", {
                    "tool_call_id": call_id,
                    "title": str(getattr(event, "name", "")),
                    "raw_input": getattr(event, "args", None) or {},
                })
            return InternalEvent("tool_call_update", {
                "tool_call_id": call_id,
                "status": "failed" if status == "error" else status,
                "raw_output": getattr(event, "result", None) or {},
            })
        if kind == "usage":
            usage = self._usage_payload(getattr(event, "usage", None))
            if usage:
                return InternalEvent("usage_update", usage)
            return None
        return InternalEvent("acp_raw", {
            "update_type": str(kind or type(event).__name__),
            "data": {"repr": repr(event)[:300]},
        })

    @staticmethod
    def _usage_payload(usage) -> dict:
        if usage is None:
            return {}
        if hasattr(usage, "model_dump"):
            usage = usage.model_dump(by_alias=True, exclude_none=True)
        elif not isinstance(usage, dict):
            usage = vars(usage) if hasattr(usage, "__dict__") else {}
        if not isinstance(usage, dict) or not usage:
            return {}
        total = usage.get("total_tokens") or usage.get("total")
        return {k: v for k, v in usage.items() if v is not None} or (
            {"total_tokens": total} if total else {}
        )

    # ------------------------------------------------------- 控制面 / 查询

    async def stop(self, session_id: str | None = None, **kwargs) -> None:
        key = session_id or None
        entries = list(self._active_runs.items())
        for k, (_client, _agent, run) in entries:
            if key is None or k == key:
                try:
                    await run.cancel()
                except Exception as exc:
                    logger.debug("cursor run.cancel 失败: %s", exc)
                self._active_runs.pop(k, None)

    async def test_connection(self) -> dict:
        if not await asyncio.to_thread(self.is_installed):
            return {"ok": False, "message": "cursor-sdk 未安装"}
        api_key = await asyncio.to_thread(self._api_key)
        if not api_key:
            return {"ok": False, "message": "未配置 Cursor API Key"}
        try:
            from cursor_sdk import AsyncClient

            client = await AsyncClient.launch_bridge(workspace=os.getcwd())
            try:
                me = await client.me(api_key=api_key)
                return {"ok": True, "message": f"Connected as {getattr(me, 'user_email', '') or getattr(me, 'user_first_name', '') or 'Cursor account'}"}
            finally:
                await client.aclose()
        except Exception as exc:
            return {"ok": False, "message": str(exc)[:300]}

    async def list_models(self, cwd: str | None = None) -> list:
        if not await asyncio.to_thread(self.is_installed):
            return []
        api_key = await asyncio.to_thread(self._api_key)
        if not api_key:
            return []
        try:
            from cursor_sdk import AsyncClient

            from engines.core.base import EngineModel

            client = await AsyncClient.launch_bridge(workspace=cwd or os.getcwd())
            try:
                raw = await client.models.list(api_key=api_key)
                items = raw if isinstance(raw, list) else getattr(raw, "models", None) or []
                models = []
                for m in items:
                    d = m.model_dump(by_alias=True, exclude_none=True) if hasattr(m, "model_dump") else (m if isinstance(m, dict) else {"id": getattr(m, "id", str(m)), "name": getattr(m, "name", None)})
                    models.append(EngineModel(id=str(d.get("id") or d.get("name") or ""), label=str(d.get("name") or d.get("id") or "")))
                return models
            finally:
                await client.aclose()
        except Exception as exc:
            logger.warning("cursor list_models 失败: %s", exc)
            return []
