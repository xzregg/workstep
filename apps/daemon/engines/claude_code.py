"""ClaudeCodeEngine — direct CLI mode (claude -p)."""

import asyncio
import json
import logging
import os
import shlex
import shutil
from pathlib import Path
from typing import AsyncIterator

from engines.core.acp_base import AcpEngineBase
from engines.claude_code_events import ClaudeCodeEventMapper
from engines.core.packages import RuntimePackage
from engines.core.base import (
    EngineInstallResult,
    EngineModel,
    ProviderRuntimeConfig,
    install_with_command,
)

from engines.core.events import (
    InternalEvent,
)
from engines.core.schema import EngineConfigField, EngineConfigOption, EngineImage
from engines.core.stream_lines import iter_stream_lines
from services import providers as provider_service
from services.config import (
    CLAUDE_PERMISSION_MODES,
    claude_custom_settings_env,
    claude_custom_settings_rest,
    claude_sandbox_env,
    claude_model_map_env,
    config_store,
    normalize_claude_custom_settings,
    normalize_claude_model_map,
)

logger = logging.getLogger(__name__)


def _noop_publish(_event: InternalEvent) -> None:
    """CLI 引擎的事件由 ``_parse_stdout`` 直接 yield，无需再入队。"""


def _load_claude_settings(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _append_claude_permission_rule(path: Path, rule: str) -> bool:
    """Append an allow rule to the project ``.claude/settings.local.json``.

    这是 Claude Code 原生「允许所有」的落点：后续运行同一项目时，CLI 会
    读取该文件并直接放行，不再产生权限拒绝。
    """
    if not rule:
        return False
    try:
        data = _load_claude_settings(path)
        permissions = data.get("permissions")
        if not isinstance(permissions, dict):
            permissions = {}
            data["permissions"] = permissions
        allow = permissions.get("allow")
        if not isinstance(allow, list):
            allow = []
            permissions["allow"] = allow
        if rule not in allow:
            allow.append(rule)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f"{path.name}.tmp")
        tmp.write_text(
            json.dumps(data, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        tmp.replace(path)
        return True
    except OSError:
        return False


_PERMISSION_ALLOW_ONCE_CONTENT = (
    "The user approved this command; retry it. "
    "If Claude permission policy still rejects it, use another tool or ask the user."
)
_PERMISSION_ALLOW_FOR_SESSION_CONTENT = (
    "The user approved this command; retry it. "
    "The same command will be allowed for this session without asking again."
)
_PERMISSION_ALLOW_ALWAYS_CONTENT = (
    "The user approved this command; retry it. "
    "The same command was written to project permissions (.claude/settings.local.json) "
    "and will be allowed in later runs."
)
_PERMISSION_REJECT_ONCE_CONTENT = "The user rejected this command; use another approach or skip it."
_PERMISSION_REJECT_FOR_SESSION_CONTENT = (
    "The user rejected this command; use another approach or skip it. "
    "The same command will be rejected for this session without asking again."
)
class ClaudeCodeEngine(ClaudeCodeEventMapper, AcpEngineBase):
    ENGINE_ID = "claude"
    RUNTIME_PACKAGE = RuntimePackage('@anthropic-ai/claude-code', 'npm', '0', None)

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

    """Claude Code CLI engine using direct subprocess.

    Spawns `claude -p --output-format stream-json` and parses JSONL stdout.
    """

    def __init__(self):
        super().__init__()
        self._process: asyncio.subprocess.Process | None = None
        self._running = False
        self._live_mode = False
        self._cwd: str = ""
        # interaction_id → (权限签名, Claude Code 权限规则)，供会话记忆与持久化。
        self._permission_details: dict[str, tuple[str, str]] = {}
        # 本会话内记住的签名 → 决定（allow_for_session / allow_always）。
        self._session_allow: dict[str, str] = {}
        # 本会话内记住的签名 → 决定（reject_for_session）。
        self._session_reject: dict[str, str] = {}

    # --- Engine discovery ---

    @staticmethod
    def is_installed() -> bool:
        return ClaudeCodeEngine.resolve_binary() is not None

    @staticmethod
    def get_version() -> str | None:
        binary = ClaudeCodeEngine.resolve_binary()
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
        """Resolve claude binary: CLAUDE_BIN env → PATH → 'claude'."""
        override = ClaudeCodeEngine.get_binary_override()
        if override is not None:
            return override if os.path.isfile(override) else None
        env_bin = os.environ.get("CLAUDE_BIN")
        if env_bin and os.path.isfile(env_bin):
            return env_bin
        found = shutil.which("claude")
        return found

    @staticmethod
    def install_command() -> str:
        return "npm install -g @anthropic-ai/claude-code"

    async def install(self) -> EngineInstallResult:
        """Install Claude Code CLI via npm global install."""
        return await install_with_command(
            ["npm", "install", "-g", "@anthropic-ai/claude-code"],
            display="Claude Code",
        )

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
                help="WorkStep 每次启动 Claude Code 都会显式传入此权限模式。",
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
                    "其余键作为 --settings 覆盖与 WorkStep 技能配置合并。"
                    "按引擎独立保存，需先保存配置再生效。"
                ),
            ),
        ]

    def get_config_values(self) -> dict:
        config = config_store.get_claude_code_config()
        return {
            "permission_mode": config_store.get_claude_permission_mode(),
            "model_map": config["model_map"],
            "custom_settings": config["custom_settings"],
        }

    async def save_config_values(
        self,
        values: dict,
        clear: dict[str, bool] | None = None,
        confirmed: dict[str, bool] | None = None,
    ) -> None:
        mode = str(values.get("permission_mode") or "").strip()
        if mode not in CLAUDE_PERMISSION_MODES:
            raise ValueError("不支持的 Claude Code 权限模式")
        if mode == "bypassPermissions" and not (confirmed or {}).get(
            "permission_mode"
        ):
            raise ValueError("bypassPermissions 需要明确确认风险")
        # 先校验映射与自定义配置再落盘，避免非法输入时其它字段已写一半。
        model_map = normalize_claude_model_map(values.get("model_map"))
        custom_settings = normalize_claude_custom_settings(
            values.get("custom_settings")
        )
        await asyncio.to_thread(config_store.set_claude_permission_mode, mode)
        await asyncio.to_thread(
            config_store.set_claude_code_config,
            model_map=model_map,
            custom_settings=custom_settings,
        )

    # --- Execution ---

    async def list_models(self, cwd: str) -> list[EngineModel]:
        return [
            EngineModel("sonnet", "Sonnet"),
            EngineModel("opus", "Opus"),
            EngineModel("haiku", "Haiku"),
        ]

    @staticmethod
    def build_command(
        binary: str,
        permission_mode: str,
        model: str | None = None,
        session_id: str | None = None,
        add_dirs: list[str] | None = None,
        live_mode: bool = False,
        plugin_dir: str | None = None,
        skill_settings: str | None = None,
    ) -> list[str]:
        cmd = [
            binary,
            "-p",
            "--output-format", "stream-json",
            "--include-partial-messages",
            "--verbose",
            "--permission-mode", permission_mode,
        ]
        if live_mode:
            # Realtime streaming input: keep stdin open and accept JSONL user
            # messages so mid-execution step messages can be injected.
            cmd.extend(["--input-format", "stream-json"])
        if model:
            cmd.extend(["--model", model])
        if session_id:
            cmd.extend(["--resume", session_id])
        if add_dirs:
            for directory in add_dirs:
                cmd.extend(["--add-dir", directory])
        if plugin_dir:
            cmd.extend(["--plugin-dir", plugin_dir, "--setting-sources", ""])
        if skill_settings:
            cmd.extend(["--settings", skill_settings])
        return cmd

    async def spawn(
        self,
        prompt: str,
        cwd: str,
        model: str | None = None,
        add_dirs: list[str] | None = None,
        session_id: str | None = None,
        live_message_queue: asyncio.Queue | None = None,
        images: list[EngineImage] | None = None,
        config_overrides: dict | None = None,
    ) -> AsyncIterator[InternalEvent]:
        """Spawn claude CLI and stream events.

        When ``live_message_queue`` is given the CLI runs in stream-json input
        mode: stdin stays open and queued ``(message_id, content)`` pairs are
        injected as ordinary user messages while the turn is still running.
        """
        prompt, binary = await asyncio.to_thread(
            lambda: (self.render_image_prompt(prompt, images), self.resolve_binary())
        )
        if not binary:
            yield InternalEvent(type="error", data={"message": "claude binary not found"})
            return

        permission_mode = self.merge_config_overrides(
            {
                "permission_mode": await asyncio.to_thread(
                    config_store.get_claude_permission_mode
                )
            },
            config_overrides,
        )["permission_mode"]
        provider_runtime = await asyncio.to_thread(
            self.resolve_provider_runtime,
            provider_id=str((config_overrides or {}).get("provider_id") or ""),
            model=model,
        )
        model = provider_runtime.model
        if not permission_mode:
            yield InternalEvent(type="error", data={
                "message": "Claude Code 权限模式尚未确认，请先在设置中选择权限模式",
            })
            return

        self._live_mode = live_message_queue is not None
        self._cwd = cwd
        self._permission_details.clear()
        self._session_allow.clear()
        self._session_reject.clear()
        from services.skill_runtime import prepare_claude_plugin

        plugin_dir, skill_names = await asyncio.to_thread(
            lambda: prepare_claude_plugin(self.project_skills(cwd))
        )
        custom_settings = config_store.get_claude_code_config().get(
            "custom_settings"
        )
        settings_payload = {
            **claude_custom_settings_rest(custom_settings),
            # WorkStep 管理的技能开关优先于用户自定义，避免绕过技能白名单。
            "skillOverrides": {name: "on" for name in skill_names},
        }
        skill_settings = json.dumps(settings_payload, ensure_ascii=False)
        # 已有配置优先：供应商 base url / 鉴权、模型映射以及供应商显式清理的键
        # 都不允许被自定义 JSON 覆盖，textarea 只补充缺失的环境变量。
        protected_env_keys = set(provider_runtime.env) | set(provider_runtime.unset_env)
        custom_env = claude_custom_settings_env(custom_settings, protected_env_keys)
        cmd = self.build_command(
            binary,
            permission_mode,
            model=model,
            session_id=session_id,
            add_dirs=add_dirs,
            live_mode=self._live_mode,
            plugin_dir=str(plugin_dir),
            skill_settings=skill_settings,
        )

        command_text = shlex.join(cmd)
        logger.info("Spawning: %s (cwd=%s)", command_text, cwd)
        print(
            "[ClaudeCodeEngine] "
            f"session={'resume:' + session_id if session_id else 'new'} "
            f"cwd={cwd} command={command_text}",
            flush=True,
        )

        process_kwargs = {
            "stdin": asyncio.subprocess.PIPE,
            "stdout": asyncio.subprocess.PIPE,
            "stderr": asyncio.subprocess.PIPE,
            "cwd": cwd,
            "limit": 1024 * 256,
        }
        compact_pct = (config_overrides or {}).get("autocompact_pct_override")
        sandbox_env = claude_sandbox_env(permission_mode)
        needs_child_env = bool(
            provider_runtime.provider_id
            or provider_runtime.env
            or sandbox_env
            or custom_env
            or compact_pct not in (None, "")
        )
        if needs_child_env:
            # env 非空也可能只是模型映射（未绑供应商），此时同样要落进子进程。
            process_kwargs["env"] = provider_runtime.child_env()
            process_kwargs["env"].update(custom_env)
        if compact_pct not in (None, ""):
            try:
                compact_pct_value = int(compact_pct)
            except (TypeError, ValueError) as exc:
                raise ValueError("autocompact_pct_override must be an integer") from exc
            if not 1 <= compact_pct_value <= 100:
                raise ValueError("autocompact_pct_override must be between 1 and 100")
            process_kwargs["env"]["CLAUDE_AUTOCOMPACT_PCT_OVERRIDE"] = str(
                compact_pct_value
            )
        if sandbox_env:
            process_kwargs["env"].update(sandbox_env)
        self._process = await asyncio.create_subprocess_exec(*cmd, **process_kwargs)
        self._running = True

        # Send prompt via stdin. Live mode keeps stdin open for later messages.
        if self._live_mode:
            initial = {
                "type": "user",
                "message": {"role": "user", "content": prompt},
            }
            self._process.stdin.write(
                (json.dumps(initial, ensure_ascii=False) + "\n").encode()
            )
        else:
            self._process.stdin.write((prompt + "\n").encode())
        await self._process.stdin.drain()
        if not self._live_mode:
            self._process.stdin.close()

        yield InternalEvent(type="status", data={"status": "running"})

        self._turn_done = False
        self._delivered_after_done = False
        self._turn_error = False
        # Parse stdout JSONL; deliver queued live messages between events.
        async for event in self._parse_stdout():
            yield event
            if self._live_mode and live_message_queue is not None:
                while not live_message_queue.empty():
                    message_id, content = live_message_queue.get_nowait()
                    delivered = await self.send_live_step_message(content)
                    if delivered and self._turn_done:
                        self._delivered_after_done = True
                    yield InternalEvent(type="live_message", data={
                        "message_id": message_id,
                        "status": "delivered" if delivered else "error",
                        "detail": "" if delivered else "引擎执行已结束，无法接收新消息",
                    })
                if self._turn_done and not self._delivered_after_done:
                    break

        # Live mode: ask the CLI to finalize, then wait with a bounded watchdog.
        if self._live_mode:
            try:
                self._process.stdin.write(b'{"type":"close_stream"}\n')
                await self._process.stdin.drain()
            except (BrokenPipeError, ConnectionResetError, RuntimeError):
                pass
            try:
                self._process.stdin.close()
            except Exception:
                pass
            try:
                exit_code = await asyncio.wait_for(self._process.wait(), timeout=15)
            except asyncio.TimeoutError:
                logger.warning("Claude live mode did not exit after completion; terminating")
                self._process.terminate()
                try:
                    exit_code = await asyncio.wait_for(self._process.wait(), timeout=5)
                except asyncio.TimeoutError:
                    self._process.kill()
                    exit_code = await self._process.wait()
        else:
            exit_code = await self._process.wait()
        self._running = False

        if exit_code != 0:
            stderr = await self._process.stderr.read()
            yield InternalEvent(type="error", data={
                "message": f"Process exited with code {exit_code}",
                "stderr": stderr.decode(errors="replace"),
            })
        elif not self._turn_error:
            yield InternalEvent(type="status", data={"status": "done"})

    async def _parse_stdout(self) -> AsyncIterator[InternalEvent]:
        """Parse Claude's stream-json stdout into InternalEvents."""
        state = {"streamed_text": False, "streamed_thinking": False}
        # 分块读取：Claude 的单条 JSONL 事件（大段 tool 输出 / 长消息）可能超过
        # asyncio StreamReader 默认 64KiB limit，readline 会抛
        # "Separator is not found, and chunk exceed the limit" 并清空缓冲。
        async for line in iter_stream_lines(self._process.stdout):
            line = line.decode(errors="replace").strip()
            if not line:
                continue

            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                logger.warning("Non-JSON line from claude: %s", line[:100])
                continue

            if obj.get("type") == "result":
                self._turn_done = True
                self._delivered_after_done = False
                self._turn_error = bool(
                    obj.get("is_error")
                    or str(obj.get("subtype") or "").startswith("error")
                )
            for event in self._map_events(obj, state):
                if (
                    event.type == "interaction_request"
                    and event.data.get("method") == "session/request_permission"
                ):
                    tool_call = event.data.get("tool_call") or {}
                    tool_use_id = str(tool_call.get("tool_call_id") or "")
                    interaction_id = str(event.data.get("interaction_id") or "")
                    signature, rule = self._permission_details.pop(
                        interaction_id, ("", "")
                    )
                    runtime_decision = self.runtime_permission_decision()
                    if runtime_decision is not None:
                        await self._inject_permission(
                            tool_use_id,
                            _PERMISSION_ALLOW_ONCE_CONTENT
                            if runtime_decision
                            else _PERMISSION_REJECT_ONCE_CONTENT,
                        )
                        continue
                    # 本会话内已记住的决定：不弹窗，直接注入结果。
                    remembered = (
                        self._session_allow.get(signature) if signature else None
                    )
                    if remembered:
                        content = (
                            _PERMISSION_ALLOW_ALWAYS_CONTENT
                            if remembered == "allow_always"
                            else _PERMISSION_ALLOW_FOR_SESSION_CONTENT
                        )
                        await self._inject_permission(tool_use_id, content)
                        continue
                    if signature and signature in self._session_reject:
                        await self._inject_permission(
                            tool_use_id, _PERMISSION_REJECT_FOR_SESSION_CONTENT
                        )
                        continue
                    # 权限被拒 → 弹窗等待用户决定，再把决定作为 tool_result 注入 CLI。
                    yield event
                    response = await self.request_interaction(event, _noop_publish)
                    outcome = response.get("outcome") or {}
                    option_id = str(outcome.get("option_id") or "")
                    if option_id == "allow_always":
                        if signature:
                            self._session_allow[signature] = "allow_always"
                        self._persist_always_allow(rule)
                        content = _PERMISSION_ALLOW_ALWAYS_CONTENT
                    elif option_id == "allow_for_session":
                        if signature:
                            self._session_allow[signature] = "allow_for_session"
                        content = _PERMISSION_ALLOW_FOR_SESSION_CONTENT
                    elif option_id == "reject_for_session":
                        if signature:
                            self._session_reject[signature] = "reject_for_session"
                        content = _PERMISSION_REJECT_FOR_SESSION_CONTENT
                    elif option_id == "allow_once":
                        content = _PERMISSION_ALLOW_ONCE_CONTENT
                    else:
                        content = _PERMISSION_REJECT_ONCE_CONTENT
                    await self._inject_permission(tool_use_id, content)
                else:
                    yield event

    # --- Interaction ---

    async def stop(self) -> None:
        """Terminate the subprocess."""
        if self._process and self._running:
            self._process.terminate()
            try:
                await asyncio.wait_for(self._process.wait(), timeout=5)
            except asyncio.TimeoutError:
                self._process.kill()
            self._running = False

    async def _inject_permission(self, tool_use_id: str, content: str) -> None:
        """Inject a permission decision as a tool result, swallowing failures."""
        if not tool_use_id:
            return
        try:
            await self.inject_response(tool_use_id, content)
        except Exception:
            logger.exception("注入权限决定失败：%s", tool_use_id)

    def _persist_always_allow(self, rule: str) -> None:
        """把「允许所有」规则写入项目 .claude/settings.local.json（Claude Code 原生机制）。"""
        if not rule or not self._cwd:
            return
        path = Path(self._cwd) / ".claude" / "settings.local.json"
        if not _append_claude_permission_rule(path, rule):
            logger.warning("写入 Claude Code 权限规则失败：%s", rule)

    async def inject_response(self, tool_use_id: str, content: str) -> None:
        """Return a tool result to Claude Code's stream-json input."""
        if (
            not self._live_mode
            or not self._running
            or self._process is None
            or self._process.stdin is None
            or self._process.stdin.is_closing()
        ):
            raise RuntimeError("Claude Code 当前会话不支持交互响应")
        message = {
            "type": "user",
            "message": {
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": tool_use_id,
                    "content": content,
                }],
            },
        }
        self._process.stdin.write(
            (json.dumps(message, ensure_ascii=False) + "\n").encode()
        )
        await self._process.stdin.drain()

    async def send_live_step_message(self, content: str) -> bool:
        """Inject an ordinary user message into the running claude process."""
        if (
            not self._live_mode
            or not self._running
            or self._process is None
            or self._process.stdin is None
            or self._process.stdin.is_closing()
        ):
            return False
        message = {
            "type": "user",
            "message": {"role": "user", "content": content},
        }
        try:
            self._process.stdin.write(
                (json.dumps(message, ensure_ascii=False) + "\n").encode()
            )
            await self._process.stdin.drain()
            return True
        except (BrokenPipeError, ConnectionResetError, RuntimeError):
            return False

    # --- Session resume ---

    @property
    def supports_resume(self) -> bool:
        return True

    @property
    def supports_interactive(self) -> bool:
        return True  # Live mode accepts ordinary user messages mid-execution

    @property
    def supports_live_step_message(self) -> bool:
        return True

    @property
    def supports_vision(self) -> bool:
        """Claude models accept markdown image references in prompts."""
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
        """claude -p --resume <session_id> 原生支持恢复会话。"""
        return True

    @property
    def supports_tool_approval(self) -> bool:
        """权限拒绝 → permission 弹窗 → 决定作为 tool_result 注入 CLI，原生审批语义。"""
        return True

    async def create_session(
        self,
        cwd: str,
        add_dirs: list[str] | None = None,
        mcp_servers: list | None = None,
    ) -> str | None:
        """无法脱离提示词创建空会话；会话在首次 spawn（system/init）时建立。"""
        logger.info("ClaudeCode create_session: not supported without a prompt")
        return None

    async def resume_session(
        self,
        session_id: str,
        cwd: str,
        add_dirs: list[str] | None = None,
        mcp_servers: list | None = None,
    ) -> bool:
        """--resume 原生恢复；spawn(session_id=...) 时实际恢复。"""
        return bool(session_id)

    async def close_session(self, session_id: str, cwd: str | None = None) -> None:
        """关闭会话 = 结束当前运行中的 claude 进程。"""
        if self._running:
            await self.stop()

    async def cancel_session(self, session_id: str, cwd: str | None = None) -> None:
        """取消会话 = 终止当前运行中的 claude 进程。"""
        if self._running:
            await self.stop()

    async def set_config_option(
        self,
        config_id: str,
        value: str | bool,
        session_id: str | None = None,
    ) -> None:
        """配置在 spawn 时从 config_store 读取（permission_mode / model）；
        运行中修改无原生入口。"""
        return None

    async def reset_options(self, session_id: str | None = None) -> None:
        """无原生 reset；新会话从全局配置重新读取。"""
        return None

    def build_resume_params(self, session_id: str) -> dict:
        return {"session_id": session_id}
