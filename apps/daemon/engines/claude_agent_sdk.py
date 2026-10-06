"""ClaudeAgentSDKEngine — Claude Code via the official claude-agent-sdk."""

import asyncio
import json
import logging
import os
from pathlib import Path
import shutil
import uuid
from typing import Any, AsyncIterator

from engines.claude_image_input import build_claude_user_content
from engines.core.acp_base import AcpEngineBase
from engines.claude_agent_sdk_events import ClaudeAgentSDKEventMapper
from engines.core.packages import RuntimePackage
from engines.core.base import (
    EngineInstallResult,
    EngineModel,
    ProviderRuntimeConfig,
    install_python_package,
    resolve_thinking_effort,
    sdk_turn_watchdog,
)

from engines.core.events import (
    InternalEvent,
    usage_update_event,
)
from engines.core.schema import EngineImage
from engines.core.schema import EngineConfigField, EngineConfigOption
from services import providers as provider_service
from services.config import config_store
from services.engine_config_rules import (
    CLAUDE_PERMISSION_MODES,
    claude_custom_settings_env,
    claude_custom_settings_rest,
    claude_sandbox_env,
    claude_model_map_env,
    normalize_claude_custom_settings,
    normalize_claude_model_map,
)
from services.chat_permissions import map_permission_overrides

logger = logging.getLogger(__name__)


class ClaudeAgentSDKEngine(ClaudeAgentSDKEventMapper, AcpEngineBase):
    """Claude Code driven by the official ``claude-agent-sdk`` Python package.

    The SDK's ``local`` transport still starts the ``claude`` binary as a child
    process, but the SDK manages that process in-process via the stream-json
    protocol — no shell wrapper, no ACP bridge. This adapter only drives the
    SDK's async ``query()`` API and maps its messages to internal events.
    """

    ENGINE_ID = "claude_agent_sdk"
    SYSTEM_PROMPT_MODE = "system"
    RUNTIME_PACKAGE = RuntimePackage('claude-agent-sdk', 'pypi', '0.1.0', None)
    UPDATE_PACKAGE = "claude-agent-sdk"

    async def set_permission_mode(self, mode: str) -> None:
        await super().set_permission_mode(mode)
        client = self._client
        if client is None:
            return
        mapped = (
            map_permission_overrides(self.ENGINE_ID, mode).get("permission_mode", "")
            if mode
            else str(
                (await asyncio.to_thread(config_store.get_claude_agent_sdk_config))
                .get("permission_mode")
                or "acceptEdits"
            )
        )
        try:
            await client.set_permission_mode(
                "default" if mapped == "manual" else mapped
            )
        except Exception:
            # Claude Code CLI 拒绝运行中切换到 bypassPermissions（除非进程启动时
            # 带 --dangerously-skip-permissions）。跳过热切换：已持久化的模式会
            # 在下一轮启动时通过 --permission-mode 生效。
            logger.warning(
                "claude_agent_sdk 热切换权限模式到 %r 失败，将在下一轮生效",
                mapped,
                exc_info=True,
            )

    @classmethod
    def supported_provider_protocols(cls) -> set[str]:
        return {"anthropic_messages"}

    def _model_map(self) -> dict[str, dict[str, str]]:
        """已保存的档位映射；读取路径不抛错（写路径才校验）。"""
        try:
            return normalize_claude_model_map(
                self.get_config_values().get("model_map")
            )
        except ValueError:
            return {}

    def build_provider_runtime(self, provider, model, protocol=None):
        # 本引擎只消费 Anthropic Messages 协议（protocol 由基类解析）。
        selected_protocol = str(protocol or "anthropic_messages")
        return ProviderRuntimeConfig(
            provider_id=str(provider.get("id") or ""),
            model=model,
            protocol=selected_protocol,
            env={
                "ANTHROPIC_BASE_URL": provider_service.provider_runtime_base_url(
                    provider, selected_protocol
                ),
                "ANTHROPIC_API_KEY": str(provider.get("api_key") or ""),
                **claude_model_map_env(self._model_map()),
            },
            unset_env={
                "ANTHROPIC_AUTH_TOKEN",
                "CLAUDE_CODE_USE_BEDROCK",
                "CLAUDE_CODE_USE_VERTEX",
                "CLAUDE_CODE_USE_FOUNDRY",
            },
        )

    def build_native_runtime(self, model):
        # 未绑定供应商时映射同样生效（CLI 原生登录 + 只做档位映射是合法场景）。
        return ProviderRuntimeConfig(
            model=model,
            env=claude_model_map_env(self._model_map()),
        )

    def __init__(self):
        super().__init__()
        self._running = False
        self._receive_task: asyncio.Task | None = None
        self._client = None

    # --- Engine discovery ---

    @staticmethod
    def _sdk_available() -> bool:
        try:
            import claude_agent_sdk  # noqa: F401
            return True
        except Exception:
            return False

    @staticmethod
    def is_installed() -> bool:
        if not ClaudeAgentSDKEngine._sdk_available():
            return False
        return ClaudeAgentSDKEngine.resolve_binary() is not None

    @staticmethod
    def is_configured() -> bool:
        return True

    @staticmethod
    def get_version() -> str | None:
        binary = ClaudeAgentSDKEngine.resolve_binary()
        if not binary:
            return None
        try:
            import subprocess
            out = subprocess.run(
                [binary, "--version"], capture_output=True, text=True, timeout=5
            )
            return out.stdout.strip() if out.returncode == 0 else None
        except Exception:
            return None

    @staticmethod
    def resolve_binary() -> str | None:
        """Resolve the claude binary: override → env → SDK bundled → PATH.

        The SDK wheel bundles a platform-matched ``_bundled/claude`` runtime
        (``cli_path`` defaults to it), so no separate CLI install is required.
        """
        override = ClaudeAgentSDKEngine.get_binary_override()
        if override is not None:
            return override if os.path.isfile(override) else None
        env_bin = os.environ.get("CLAUDE_AGENT_CLAUDE_BIN")
        if env_bin and os.path.isfile(env_bin):
            return env_bin
        try:
            import claude_agent_sdk
            bundled = Path(claude_agent_sdk.__file__).parent / "_bundled" / (
                "claude.exe" if os.name == "nt" else "claude"
            )
            if bundled.is_file():
                return str(bundled)
        except Exception:
            pass
        return shutil.which("claude")

    @staticmethod
    def install_command() -> str:
        return "pip install claude-agent-sdk"

    async def install(self) -> EngineInstallResult:
        """Install the official ``claude-agent-sdk`` Python package."""
        return await install_python_package("claude-agent-sdk")

    # --- Config schema (backend-driven settings form) ---

    @classmethod
    def config_schema(cls) -> list[EngineConfigField]:
        return [
            EngineConfigField(
                key="permission_mode",
                label="权限模式",
                type="select",
                options=tuple(
                    EngineConfigOption(mode, mode) for mode in CLAUDE_PERMISSION_MODES
                ),
                placeholder="请选择并确认权限模式",
                required=True,
                confirm_values=("bypassPermissions",),
                help="与 Claude Code CLI 引擎共用同一权限模式配置。",
            ),
            EngineConfigField(
                key="max_turns",
                label="最大轮数",
                type="number",
                placeholder="如 20，留空为 SDK 默认",
                help="Agent 最多执行的工具调用轮数。",
            ),
            EngineConfigField(
                key="fallback_model",
                label="备用模型",
                type="text",
                placeholder="如 claude-3-5-haiku-latest",
                help="主模型不可用时自动切换的备用模型。",
            ),
            EngineConfigField(
                key="model_map",
                label="模型映射",
                type="model_map",
                step_hidden=True,
                help=(
                    "把 Claude Code 内部的 sonnet/opus/haiku/fable 档位映射到实际模型 ID，"
                    "绑定第三方中转时用它替代 Anthropic 官方模型名；显示名留空则与模型 ID 相同。"
                    "按引擎独立保存，需先保存配置再生效。"
                ),
            ),
            EngineConfigField(
                key="custom_settings",
                label="自定义配置 (JSON)",
                type="json",
                step_hidden=True,
                placeholder=(
                    '{"env": {"ANTHROPIC_BASE_URL": "..."}, '
                    '"permissions": {"ask": ["Bash(rm\\\\s)"]}}'
                ),
                help=(
                    "整段 Claude Code settings JSON。env 会注入子进程环境；"
                    "其余键与 WorkStep 技能配置合并后作为 SDK settings 覆盖。"
                    "按引擎独立保存，需先保存配置再生效。"
                ),
            ),
        ]

    def get_config_values(self) -> dict:
        return config_store.get_claude_agent_sdk_config()

    async def save_config_values(
        self,
        values: dict,
        clear: dict[str, bool] | None = None,
        confirmed: dict[str, bool] | None = None,
    ) -> None:
        mode = str(values.get("permission_mode") or "").strip()
        if mode not in CLAUDE_PERMISSION_MODES:
            raise ValueError("不支持的权限模式")
        if mode == "bypassPermissions" and not (confirmed or {}).get(
            "permission_mode"
        ):
            raise ValueError("bypassPermissions 需要明确确认风险")
        # 先校验映射与自定义配置再落盘，避免非法输入时其它字段已写一半。
        model_map = normalize_claude_model_map(values.get("model_map"))
        custom_settings = normalize_claude_custom_settings(
            values.get("custom_settings")
        )
        await asyncio.to_thread(
            config_store.set_claude_agent_sdk_config,
            max_turns=str(values.get("max_turns") or ""),
            permission_mode=mode,
            fallback_model=str(values.get("fallback_model") or ""),
            model_map=model_map,
            custom_settings=custom_settings,
        )

    async def list_models(self, cwd: str) -> list[EngineModel]:
        return [
            EngineModel("sonnet", "Sonnet"),
            EngineModel("opus", "Opus"),
            EngineModel("haiku", "Haiku"),
        ]

    # --- Execution ---

    async def spawn(
        self,
        prompt: str,
        cwd: str,
        model: str | None = None,
        add_dirs: list[str] | None = None,
        session_id: str | None = None,
        images: list[EngineImage] | None = None,
        live_message_queue: asyncio.Queue | None = None,
        thinking_effort: str | None = None,
        config_overrides: dict | None = None,
        system_prompt: str | None = None,
    ) -> AsyncIterator[InternalEvent]:
        user_content, binary = await asyncio.to_thread(
            lambda: (build_claude_user_content(prompt, images), self.resolve_binary())
        )
        if not binary:
            yield InternalEvent(
                type="error", data={"message": "claude binary not found"}
            )
            return
        try:
            from claude_agent_sdk import (
                ClaudeAgentOptions,
                ClaudeSDKClient,
                PermissionResultAllow,
                PermissionResultDeny,
            )
        except Exception as exc:
            yield InternalEvent(
                type="error",
                data={"message": f"claude-agent-sdk 未安装：{exc}"},
            )
            return

        event_queue: asyncio.Queue[InternalEvent | None] = asyncio.Queue()
        stderr_lines: list[str] = []

        def on_stderr(line: str) -> None:
            """Keep the CLI's stderr so spawn failures can surface the real cause."""
            text = str(line).rstrip()
            if not text:
                return
            stderr_lines.append(text)
            del stderr_lines[:-20]
            logger.warning("claude-agent-sdk stderr: %s", text)

        async def can_use_tool(tool_name, input_data, context):
            allowed, updated_input = await self.handle_tool_permission(
                event_queue.put,
                tool_name=str(tool_name),
                tool_input=input_data if isinstance(input_data, dict) else {},
                tool_use_id=str(getattr(context, "tool_use_id", "") or uuid.uuid4()),
                title=str(getattr(context, "title", "") or ""),
                session_id=session_id or "claude-agent-sdk",
            )
            if allowed:
                return PermissionResultAllow(updated_input=updated_input)
            return PermissionResultDeny(message="用户拒绝了该操作")

        sdk_config = self.merge_config_overrides(
            await asyncio.to_thread(config_store.get_claude_agent_sdk_config),
            config_overrides,
        )
        provider_runtime = await asyncio.to_thread(
            self.resolve_provider_runtime,
            provider_id=str((config_overrides or {}).get("provider_id") or ""),
            model=model,
        )
        model = provider_runtime.model
        from services.skill_runtime import prepare_claude_plugin

        plugin_dir, skill_names = await asyncio.to_thread(
            lambda: prepare_claude_plugin(self.project_skills(cwd))
        )
        custom_settings = sdk_config.get("custom_settings")
        # 已有配置优先：供应商 base url / 鉴权、模型映射以及供应商显式清理的键
        # 都不允许被自定义 JSON 覆盖，textarea 只补充缺失的环境变量。
        protected_env_keys = set(provider_runtime.env) | set(provider_runtime.unset_env)
        custom_env = claude_custom_settings_env(custom_settings, protected_env_keys)
        settings_payload = {
            **claude_custom_settings_rest(custom_settings),
            # WorkStep 管理的技能开关优先于用户自定义，避免绕过技能白名单。
            "skillOverrides": {name: "on" for name in skill_names},
        }
        sandbox_env = claude_sandbox_env(sdk_config["permission_mode"])
        if provider_runtime.provider_id or provider_runtime.env or sandbox_env or custom_env:
            child_env = {**provider_runtime.child_env(), **custom_env, **sandbox_env}
        else:
            child_env = {}
        options = ClaudeAgentOptions(
            cwd=cwd,
            model=model or None,
            permission_mode=sdk_config["permission_mode"] or "acceptEdits",
            cli_path=binary,
            resume=session_id or None,
            include_partial_messages=True,
            can_use_tool=can_use_tool,
            stderr=on_stderr,
            env=child_env,
            plugins=[{"type": "local", "path": str(plugin_dir)}],
            skills=skill_names,
            setting_sources=[],
            settings=json.dumps(settings_payload, ensure_ascii=False),
        )
        # Each invocation creates a new SDK process. Resume restores the
        # transcript, not reliably the startup options on supported versions.
        # Keep configuring the preset append; omitting it can lose these rules.
        if system_prompt:
            options.system_prompt = {
                "type": "preset", "preset": "claude_code", "append": system_prompt,
            }
        if add_dirs:
            options.add_dirs = list(add_dirs)
        if sdk_config["max_turns"]:
            options.max_turns = int(sdk_config["max_turns"])
        if sdk_config["fallback_model"]:
            options.fallback_model = sdk_config["fallback_model"]
        effort = resolve_thinking_effort(thinking_effort)
        if effort and hasattr(options, "effort"):
            # Claude 的 effort 取值 low/medium/high/xhigh/max：
            # 极简映射到最低档，其余原样传递。
            options.effort = "low" if effort == "minimal" else effort

        logger.info(
            "ClaudeAgentSDKEngine spawn: binary=%s cwd=%s model=%s provider_id=%s",
            binary,
            cwd,
            model,
            provider_runtime.provider_id or "native",
        )

        self._running = True
        yield InternalEvent(type="status", data={"status": "running"})

        state: dict[str, Any] = {
            "emitted_text": False,
            "streamed_text": False,
            "streamed_thinking": False,
            "session_started": False,
        }

        client = ClaudeSDKClient(options=options)
        self._client = client
        try:
            await client.connect()
        except Exception as exc:
            detail = "\n".join(stderr_lines[-5:]).strip()
            message = str(exc)
            if detail and detail not in message:
                message = f"{message}\n{detail}"
            yield InternalEvent(type="error", data={"message": message})
            try:
                await client.disconnect()
            except Exception:
                logger.debug("claude-agent-sdk disconnect after connect failure", exc_info=True)
            return

        turn_ended = asyncio.Event()
        end_prompt = asyncio.Event()
        input_closed = asyncio.Event()

        def _user_message(content: str | list[dict]) -> dict:
            return {
                "type": "user",
                "message": {"role": "user", "content": content},
                "parent_tool_use_id": None,
                "session_id": "default",
            }

        async def prompt_source() -> AsyncIterator[dict]:
            """Stream the initial prompt and live injections to the SDK.

            The SDK keeps stdin open for the whole session; ending this source
            closes stdin so the CLI finishes the turn, exits gracefully, and
            the SDK emits its stream-end frame (deterministic end, not a
            timeout).
            """
            yield _user_message(user_content)
            if live_message_queue is None:
                return
            while True:
                get_task = asyncio.create_task(live_message_queue.get())
                end_task = asyncio.create_task(end_prompt.wait())
                closed_task = asyncio.create_task(input_closed.wait())
                try:
                    done, _ = await asyncio.wait(
                        {get_task, end_task, closed_task},
                        return_when=asyncio.FIRST_COMPLETED,
                    )
                except asyncio.CancelledError:
                    for task in (get_task, end_task, closed_task):
                        task.cancel()
                    raise
                if end_task in done or closed_task in done:
                    if get_task in done:
                        # 消息已被取出但引擎收流：补报 error，避免静默丢失。
                        message_id, _ = get_task.result()
                        await event_queue.put(InternalEvent(
                            type="live_message",
                            data={
                                "message_id": message_id,
                                "status": "error",
                                "detail": "引擎执行已结束，无法接收新消息",
                            },
                        ))
                    else:
                        get_task.cancel()
                    return
                message_id, content = get_task.result()
                extras: list[tuple[str, str]] = []
                while not live_message_queue.empty():
                    extras.append(live_message_queue.get_nowait())
                combined = "\n\n".join(
                    [content] + [item[1] for item in extras]
                )
                for injected_id, _ in [(message_id, content), *extras]:
                    await event_queue.put(InternalEvent(
                        type="live_message",
                        data={
                            "message_id": injected_id,
                            "status": "delivered",
                            "detail": "",
                        },
                    ))
                yield _user_message(combined)

        query_task = asyncio.create_task(client.query(prompt_source()))

        async def receive() -> None:
            try:
                async for message in client.receive_messages():
                    is_result = self._msg_type(message) == "result"
                    if is_result:
                        get_context_usage = getattr(client, "get_context_usage", None)
                        if callable(get_context_usage):
                            try:
                                context_usage = await asyncio.wait_for(
                                    get_context_usage(), timeout=3
                                )
                                context_used = int(context_usage.get("totalTokens", 0))
                                context_size = int(context_usage.get("rawMaxTokens", 0))
                                if context_used > 0 and context_size > 0:
                                    await event_queue.put(usage_update_event(
                                        context_usage,
                                        used=context_used,
                                        size=context_size,
                                    ))
                            except Exception:
                                logger.debug(
                                    "Claude Agent SDK context usage unavailable",
                                    exc_info=True,
                                )
                        turn_ended.set()
                    for event in self._map_message(message, state):
                        await event_queue.put(event)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.exception("Claude Agent SDK query error")
                await event_queue.put(
                    InternalEvent(type="error", data={"message": str(exc)})
                )
            finally:
                input_closed.set()
                if query_task is not None:
                    try:
                        # 等输入源收尾：prompt_source 可能在收流瞬间已取出
                        # 插入消息，需先补报 error 事件，避免被 None 抢先吞掉。
                        await asyncio.wait_for(
                            asyncio.shield(query_task), timeout=5
                        )
                    except asyncio.TimeoutError:
                        query_task.cancel()
                    except asyncio.CancelledError:
                        pass
                await event_queue.put(None)

        receive_task = asyncio.create_task(receive())
        watchdog_task = asyncio.create_task(sdk_turn_watchdog(
            turn_ended,
            end_prompt.set,
            disconnect=client.disconnect,
            pending_injection=(
                (lambda: not live_message_queue.empty())
                if live_message_queue is not None else None
            ),
        ))
        self._receive_task = receive_task
        try:
            while True:
                event = await event_queue.get()
                if event is None:
                    break
                yield event
            await receive_task
        except asyncio.CancelledError:
            yield InternalEvent(type="status", data={"status": "cancelled"})
        except Exception as exc:
            logger.exception("ClaudeAgentSDKEngine spawn error")
            yield InternalEvent(type="error", data={"message": str(exc)})
        finally:
            # 收流结束：尚未投递的插入消息标记失败，避免静默丢失。
            if live_message_queue is not None:
                remaining: list[tuple[str, str]] = []
                while not live_message_queue.empty():
                    remaining.append(live_message_queue.get_nowait())
                for message_id, _ in remaining:
                    yield InternalEvent(type="live_message", data={
                        "message_id": message_id,
                        "status": "error",
                        "detail": "引擎执行已结束，无法接收新消息",
                    })
            for task in (receive_task, query_task, watchdog_task):
                if task is not None and not task.done():
                    task.cancel()
            for task in (query_task, watchdog_task):
                if task is not None:
                    await asyncio.gather(task, return_exceptions=True)
            self._receive_task = None
            try:
                await client.disconnect()
            except Exception:
                pass
            self._client = None
            self._running = False

    async def stop(self) -> None:
        receive_task = self._receive_task
        self._receive_task = None
        if receive_task is not None and not receive_task.done():
            receive_task.cancel()
            await asyncio.gather(receive_task, return_exceptions=True)
        client = self._client
        self._client = None
        if client is not None:
            try:
                await client.disconnect()
            except Exception:
                pass
        self._running = False

    async def inject_response(self, tool_use_id: str, content: str) -> None:
        logger.warning("inject_response is not supported by ClaudeAgentSDKEngine")

    @property
    def supports_resume(self) -> bool:
        return True

    @property
    def supports_vision(self) -> bool:
        """Claude models accept markdown image references in prompts."""
        return True

    @property
    def supports_interactive(self) -> bool:
        return True  # ClaudeSDKClient 双向流式：运行中 query() 注入 + can_use_tool

    @property
    def supports_live_step_message(self) -> bool:
        return True

    @property
    def supports_thinking_effort(self) -> bool:
        """ClaudeAgentOptions.effort maps to a per-turn thinking effort."""
        return True

    # --- ACP 会话 / 审批契约（非 ACP 引擎：用自己的传输实现等价语义） ---

    #: spawn 实际产出的 ACP 词汇事件（声明 = 实际；无原生来源不合成）。
    acp_events: frozenset[str] = frozenset({
        "agent_message_chunk",
        "agent_thought_chunk",
        "tool_call",
        "tool_call_update",
        "usage_update",
        "interaction_request",
        "live_message",
        "status",
        "session_started",
        "subagent",
        "compacted",
        "error",
    })

    @property
    def supports_sessions(self) -> bool:
        """ClaudeAgentOptions.resume 原生支持按 session_id 恢复会话。"""
        return True

    @property
    def supports_tool_approval(self) -> bool:
        """can_use_tool 回调桥接审批到 interaction_request，原生审批语义。"""
        return True

    async def create_session(
        self,
        cwd: str,
        add_dirs: list[str] | None = None,
        mcp_servers: list | None = None,
    ) -> str | None:
        """无法脱离提示词创建空会话；会话在首次 spawn（system/init）时建立。"""
        logger.info("ClaudeAgentSDK create_session: not supported without a prompt")
        return None

    async def resume_session(
        self,
        session_id: str,
        cwd: str,
        add_dirs: list[str] | None = None,
        mcp_servers: list | None = None,
    ) -> bool:
        """SDK resume 原生恢复；spawn(session_id=...) 时实际恢复。"""
        return bool(session_id)

    async def close_session(self, session_id: str, cwd: str | None = None) -> None:
        """关闭会话 = 断开当前 client 并结束运行中的任务。"""
        if self._running:
            await self.stop()

    async def cancel_session(self, session_id: str, cwd: str | None = None) -> None:
        """取消会话 = 断开当前 client 并结束运行中的任务。"""
        if self._running:
            await self.stop()

    async def set_config_option(
        self,
        config_id: str,
        value: str | bool,
        session_id: str | None = None,
    ) -> None:
        """配置在 spawn 时从 config_store 读取（permission_mode / model / effort）；
        运行中修改无原生入口。"""
        return None

    async def reset_options(self, session_id: str | None = None) -> None:
        """无原生 reset；新会话从全局配置重新读取。"""
        return None

    def build_resume_params(self, session_id: str) -> dict:
        return {"session_id": session_id}
