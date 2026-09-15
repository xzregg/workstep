"""CodexEngine — direct CLI mode (codex exec)."""

from engines.core.plans import codex_subagent_events

import asyncio
import json
import logging
import os
import platform
import shutil
import uuid
from contextlib import suppress
from typing import AsyncIterator

import re

from engines.core.acp_base import AcpEngineBase
from engines.core.packages import RuntimePackage
from engines.core.base import (
    EngineInstallResult,
    EngineModel,
    ProviderRuntimeConfig,
    install_with_command,
    resolve_thinking_effort,
)

from engines.core.events import (
    InternalEvent,
    agent_message_chunk,
    extract_reasoning_text,
    normalize_cost,
    tool_call_event,
    tool_call_update_event,
    usage_update_event,
)
from engines.core.interactions import permission_request, permission_signature
from engines.core.input_items import workstep_input_commands
from engines.core.plans import plan_event
from engines.core.schema import EngineConfigField, EngineConfigOption, EngineImage
from engines.core.stream_lines import ChunkedLineReader
from services.config import (
    CODEX_APPROVAL_POLICIES,
    CODEX_REASONING_EFFORTS,
    CODEX_SANDBOX_MODES,
    config_store,
)

logger = logging.getLogger(__name__)


def _noop_publish(_event: InternalEvent) -> None:
    """CLI 引擎的事件由 ``_parse_stdout`` 直接 yield，无需再入队。"""

# codex exec 模式没有执行中审批协议：沙箱/策略拒绝只表现为失败的
# command_execution 项。以下特征串用于识别「权限拒绝」而非普通命令失败。
_SANDBOX_DENIAL_PATTERN = re.compile(
    r"operation\s+not\s+permitted|permission\s+denied|read-only\s+file"
    r"\s+system|requires\s+approval|denied|not\s+permitted|被拒绝|未授权",
    re.IGNORECASE,
)

_SANDBOX_ESCALATION = {
    "read-only": "workspace-write",
    "workspace-write": "danger-full-access",
    "danger-full-access": "danger-full-access",
}


def _escalate_sandbox(mode: str) -> str:
    """用户批准被拒命令后，把当前沙箱提升一档供重启会话使用。"""
    return _SANDBOX_ESCALATION.get(mode, mode)


class CodexEngine(AcpEngineBase):
    ENGINE_ID = "codex"
    RUNTIME_PACKAGE = RuntimePackage('@openai/codex', 'npm', '0', None)

    @classmethod
    def supported_provider_protocols(cls) -> set[str]:
        return {"openai_responses"}

    def build_provider_runtime(self, provider, model):
        base_url = str(provider.get("base_url") or "")
        return ProviderRuntimeConfig(
            provider_id=str(provider.get("id") or ""),
            model=model,
            env={"WORKSTEP_LLM_API_KEY": str(provider.get("api_key") or "")},
            engine_config=(
                'model_provider="workstep"',
                'model_providers.workstep.name="WorkStep"',
                f"model_providers.workstep.base_url={json.dumps(base_url)}",
                'model_providers.workstep.env_key="WORKSTEP_LLM_API_KEY"',
                'model_providers.workstep.wire_api="responses"',
            ),
        )

    """Codex CLI engine using direct subprocess.

    Spawns `codex exec --json` and parses JSONL stdout.
    """

    def __init__(self):
        super().__init__()
        self._process: asyncio.subprocess.Process | None = None
        self._running = False
        self._stderr: list[bytes] = []
        self._thread_id: str | None = None
        self._stdout_reader: ChunkedLineReader | None = None
        self._escalate_sandbox = False
        # interaction_id → 命令签名（「拒绝本次运行」跨调用记忆用）。
        self._permission_signatures: dict[str, str] = {}
        # 本运行内记住的「拒绝本次运行」命令签名。
        self._session_reject: set[str] = set()

    @staticmethod
    def is_installed() -> bool:
        return CodexEngine.get_version() is not None

    @staticmethod
    def get_version() -> str | None:
        binary = CodexEngine.resolve_binary()
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
        override = CodexEngine.get_binary_override()
        if override is not None:
            return override if os.path.isfile(override) else None
        env_bin = os.environ.get("CODEX_BIN")
        if env_bin and os.path.isfile(env_bin):
            return env_bin
        return shutil.which("codex")

    @staticmethod
    def _default_sandbox() -> str:
        """Default sandbox mode based on platform."""
        system = platform.system()
        if system in ("Darwin", "Linux"):
            return "workspace-write"
        return "danger-full-access"  # Windows

    @staticmethod
    def install_command() -> str:
        return "npm install -g @openai/codex"

    async def install(self) -> EngineInstallResult:
        """Install Codex CLI via npm global install."""
        return await install_with_command(
            ["npm", "install", "-g", "@openai/codex"],
            display="Codex CLI",
        )

    async def list_models(self, cwd: str) -> list[EngineModel]:
        """Read the selectable model catalog from the installed Codex CLI."""
        binary = await asyncio.to_thread(self.resolve_binary)
        if not binary:
            return []

        process = await asyncio.create_subprocess_exec(
            binary,
            "debug",
            "models",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd,
            limit=1024 * 256,
        )
        stdout, stderr = await process.communicate()
        if process.returncode != 0:
            detail = stderr.decode(errors="replace").strip()
            raise RuntimeError(detail or "Codex CLI 读取模型列表失败")

        try:
            payload = json.loads(stdout)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise RuntimeError("Codex CLI 返回了无效的模型列表") from exc

        models = payload.get("models") if isinstance(payload, dict) else None
        if not isinstance(models, list):
            raise RuntimeError("Codex CLI 返回了无效的模型列表")

        return [
            EngineModel(
                id=str(model["slug"]),
                label=str(model.get("display_name") or model["slug"]),
                description=str(model.get("description") or ""),
            )
            for model in models
            if isinstance(model, dict)
            and model.get("slug")
            and model.get("visibility") == "list"
        ]

    # --- Config schema (backend-driven settings form) ---

    @classmethod
    def config_schema(cls) -> list[EngineConfigField]:
        return [
            EngineConfigField(
                key="sandbox_mode",
                label="沙箱模式",
                type="select",
                options=tuple(
                    EngineConfigOption(mode, mode) for mode in CODEX_SANDBOX_MODES
                ),
                default="workspace-write",
                help="模型生成的 shell 命令在此沙箱策略下执行。",
            ),
            EngineConfigField(
                key="model_reasoning_effort",
                label="推理强度",
                type="select",
                options=tuple(
                    EngineConfigOption(level, level)
                    for level in CODEX_REASONING_EFFORTS
                ),
                placeholder="默认不覆盖",
                help="等价于 config.toml 的 model_reasoning_effort。",
            ),
            EngineConfigField(
                key="approval_policy",
                label="审批策略",
                type="select",
                options=tuple(
                    EngineConfigOption(policy, policy)
                    for policy in CODEX_APPROVAL_POLICIES
                ),
                placeholder="默认不覆盖",
                help="等价于 config.toml 的 approval_policy，控制自动审批级别。",
            ),
        ]

    def get_config_values(self) -> dict:
        return config_store.get_codex_config()

    async def save_config_values(
        self,
        values: dict,
        clear: dict[str, bool] | None = None,
        confirmed: dict[str, bool] | None = None,
    ) -> None:
        await asyncio.to_thread(
            config_store.set_codex_config,
            sandbox_mode=str(values.get("sandbox_mode") or ""),
            model_reasoning_effort=str(values.get("model_reasoning_effort") or ""),
            approval_policy=str(values.get("approval_policy") or ""),
        )

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
    ) -> AsyncIterator[InternalEvent]:
        """Run ``codex exec``, restarting with ``resume`` on live messages.

        codex exec 没有执行中注入协议。当 ``live_message_queue`` 中出现插入
        消息时，终止当前进程，并用该消息作为提示词经 ``codex exec resume
        <session_id> <消息>`` 重启同一会话，从而延续完整上下文继续作答。

        ``config_overrides`` 覆盖 sandbox_mode / model_reasoning_effort /
        approval_policy（空值回退全局配置）。
        """
        binary = await asyncio.to_thread(self.resolve_binary)
        if not binary:
            yield InternalEvent(type="error", data={"message": "codex binary not found"})
            return

        codex_config = self.merge_config_overrides(
            await asyncio.to_thread(config_store.get_codex_config), config_overrides
        )
        compaction_args = self._compaction_config_args(codex_config)
        provider_runtime = await asyncio.to_thread(
            self.resolve_provider_runtime,
            provider_id=str((config_overrides or {}).get("provider_id") or ""),
            model=model,
        )
        model = provider_runtime.model
        from services.skill_runtime import codex_skills_config

        skill_override = await asyncio.to_thread(
            lambda: codex_skills_config(self.project_skills(cwd))
        )
        run_prompt = prompt
        resume_session = session_id or None
        self._escalate_sandbox = False
        self._permission_signatures.clear()
        self._session_reject.clear()
        escalated_mode: str | None = None

        while True:
            if self._escalate_sandbox:
                # 用户批准被拒命令：提升沙箱一档，重启会话让模型重试。
                escalated_mode = _escalate_sandbox(codex_config["sandbox_mode"])
                codex_config["sandbox_mode"] = escalated_mode
                self._escalate_sandbox = False
            cmd = [binary, "exec", "--json", "--skip-git-repo-check"]
            if resume_session:
                # `codex exec resume <session_id> <prompt>` 恢复上次会话，复用完整
                # 上下文；会话已记录 cwd，恢复时沿用原工作目录。
                cmd.extend(["resume", resume_session, run_prompt])
                if escalated_mode:
                    # resume 复用会话记录的沙箱，需显式覆盖才能提权重试。
                    cmd.extend(["-c", f"sandbox_mode={escalated_mode}"])
                    escalated_mode = None
            else:
                cmd.extend([
                    "--sandbox",
                    codex_config["sandbox_mode"] or self._default_sandbox(),
                    "-C", cwd,
                ])

            if model:
                cmd.extend(["--model", model])

            reasoning_effort = resolve_thinking_effort(
                thinking_effort, codex_config["model_reasoning_effort"]
            )
            if reasoning_effort:
                cmd.extend(
                    ["-c", f"model_reasoning_effort={reasoning_effort}"]
                )
            cmd.extend([
                "-c", 'model_reasoning_summary="detailed"',
                "-c", "model_supports_reasoning_summaries=true",
            ])
            cmd.extend(compaction_args)
            if codex_config["approval_policy"]:
                cmd.extend(["-c", f"approval_policy={codex_config['approval_policy']}"])
            for item in provider_runtime.engine_config:
                cmd.extend(["-c", item])
            cmd.extend(["-c", skill_override])

            logger.info("Spawning: %s", " ".join(cmd))

            process_kwargs = {
                "stdin": asyncio.subprocess.PIPE,
                "stdout": asyncio.subprocess.PIPE,
                "stderr": asyncio.subprocess.PIPE,
                "cwd": cwd,
                "limit": 1024 * 256,
            }
            if provider_runtime.provider_id:
                process_kwargs["env"] = provider_runtime.child_env()
            self._process = await asyncio.create_subprocess_exec(*cmd, **process_kwargs)
            self._running = True
            self._stderr = []
            stderr_task = asyncio.create_task(self._drain_stderr())

            if resume_session is None:
                # 新会话：codex exec 无位置参数时把 stdin 当作提示词读取。
                self._process.stdin.write(run_prompt.encode())
                await self._process.stdin.drain()
            self._process.stdin.close()

            yield InternalEvent(type="status", data={"status": "running"})

            restart_content: str | None = None
            produced_output = False
            async for event in self._parse_stdout(live_message_queue):
                yield event
                if event.type == "live_message":
                    # 收到插入消息：终止当前进程，稍后用新消息 resume 重启。
                    restart_content = str(event.data.get("content") or "")
                elif event.type != "status":
                    produced_output = True

            if restart_content is None and live_message_queue is not None:
                # 进程已结束但队列中仍有插入消息（执行刚完成即插入）：
                # 同样以该消息作为提示词恢复会话。
                try:
                    message_id, content = live_message_queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
                else:
                    yield InternalEvent(type="live_message", data={
                        "message_id": message_id,
                        "content": content,
                        "status": "delivered",
                        "session_id": self._thread_id,
                    })
                    restart_content = content

            if restart_content is not None:
                stderr_task.cancel()
                with suppress(asyncio.CancelledError):
                    await stderr_task
                await self.stop()
                if self._thread_id:
                    resume_session = self._thread_id
                    run_prompt = restart_content
                elif resume_session:
                    run_prompt = restart_content
                else:
                    # 会话尚未建立（thread.started 未到达）：无法 resume，
                    # 用「原提示词 + 插入消息」重启新会话，避免丢失上下文。
                    run_prompt = (
                        f"{run_prompt}\n\n[用户插入消息]\n{restart_content}"
                    )
                continue

            exit_code = await self._process.wait()
            self._running = False
            await stderr_task
            stderr_text = b"".join(self._stderr).decode(errors="replace").strip()

            if stderr_text:
                logger.debug("codex stderr: %s", stderr_text[-2000:])

            if exit_code != 0:
                yield InternalEvent(type="error", data={
                    "message": f"Process exited with code {exit_code}",
                    "stderr": stderr_text,
                })
            elif not produced_output and stderr_text:
                yield InternalEvent(type="error", data={
                    "message": "codex 未产生任何输出",
                    "stderr": stderr_text[-2000:],
                })
            else:
                yield InternalEvent(type="status", data={"status": "done"})
            return

    @staticmethod
    def _compaction_config_args(config: dict) -> list[str]:
        """Build hidden test-only Codex compaction overrides.

        These keys intentionally are not part of the user-facing engine
        schema; when absent, Codex keeps its own automatic policy.
        """
        limit = config.get("model_auto_compact_token_limit")
        scope = config.get("model_auto_compact_token_limit_scope")
        if limit in (None, "") and scope in (None, ""):
            return []
        try:
            limit_value = int(limit)
        except (TypeError, ValueError) as exc:
            raise ValueError("model_auto_compact_token_limit must be an integer") from exc
        if limit_value <= 0:
            raise ValueError("model_auto_compact_token_limit must be positive")
        scope_value = str(scope or "total")
        if scope_value not in {"total", "body_after_prefix"}:
            raise ValueError(
                "model_auto_compact_token_limit_scope must be total or body_after_prefix"
            )
        return [
            "-c",
            f"model_auto_compact_token_limit={limit_value}",
            "-c",
            f'model_auto_compact_token_limit_scope="{scope_value}"',
        ]

    async def send_live_stage_message(self, content: str) -> bool:
        """Direct mid-run injection is not possible for ``codex exec``.

        Live stage messages are instead handled inside ``spawn``: the running
        process is stopped and restarted via ``codex exec resume`` with the
        inserted message as the new prompt, preserving the session context.
        """
        return False

    async def _drain_stderr(self) -> None:
        """Keep reading stderr so a chatty process cannot fill its pipe."""
        assert self._process is not None
        try:
            while True:
                chunk = await self._process.stderr.read(4096)
                if not chunk:
                    break
                self._stderr.append(chunk)
        except Exception:
            logger.exception("Failed to drain codex stderr")

    async def _parse_stdout(
        self,
        live_message_queue: asyncio.Queue | None = None,
    ) -> AsyncIterator[InternalEvent]:
        """Parse Codex JSONL stdout, polling the live message queue.

        codex exec 无执行中注入协议，插入消息无法实时写入进程；队列中的消息
        以 ``live_message`` 事件上报，由 ``spawn`` 负责终止进程并用该消息
        resume 重启会话。
        """
        assert self._process is not None
        while True:
            if live_message_queue is not None and not live_message_queue.empty():
                message_id, content = live_message_queue.get_nowait()
                yield InternalEvent(type="live_message", data={
                    "message_id": message_id,
                    "content": content,
                    "status": "delivered",
                    "session_id": self._thread_id,
                })
                return
            try:
                # 分块读取：codex 单条 JSONL（大 tool 输出 / 长消息）可能超过
                # StreamReader 默认 64KiB limit，readline 会抛
                # "Separator is not found, and chunk exceed the limit" 并清空缓冲。
                # 超时只作用于等待新数据，已缓冲的不完整行会保留继续拼接。
                if (
                    self._stdout_reader is None
                    or self._stdout_reader.stream is not self._process.stdout
                ):
                    self._stdout_reader = ChunkedLineReader(self._process.stdout)
                line = await self._stdout_reader.readline(timeout=0.25)
            except asyncio.TimeoutError:
                continue
            except (RuntimeError, OSError):
                break
            if not line:
                break
            line = line.decode(errors="replace").strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue

            if obj.get("type") == "thread.started":
                # codex exec JSONL 在 thread.started 携带真实 thread_id，
                # 作为本次运行的会话标识（重跑可经 `codex exec resume` 复用）。
                self._thread_id = (
                    str(obj.get("thread_id") or "") or str(uuid.uuid4())
                )
                yield InternalEvent(
                    type="session_started",
                    data={"session_id": self._thread_id},
                )

            item = obj.get("item") or {}
            if item.get("type") == "collab_agent_tool_call":
                for child_event in codex_subagent_events(item):
                    yield child_event
            event = self._map_event(obj)
            if event is None:
                continue
            if (
                event.type == "interaction_request"
                and event.data.get("method") == "session/request_permission"
            ):
                # 沙箱/策略拒绝 → 弹窗等待用户决定；批准则提升沙箱，
                # 之后以 live_message 触发 spawn 的「终止 + resume 重启」流程。
                tool_call = event.data.get("tool_call") or {}
                raw_input = tool_call.get("raw_input") or {}
                command = str(raw_input.get("command") or "")[:120]
                tool_use_id = str(tool_call.get("tool_call_id") or "")
                interaction_id = str(event.data.get("interaction_id") or "")
                signature = self._permission_signatures.pop(interaction_id, "")
                runtime_decision = self.runtime_permission_decision()
                if runtime_decision is not None:
                    if runtime_decision:
                        self._escalate_sandbox = True
                        content = (
                            "权限模式已允许该命令，沙箱权限已提升，请重新尝试："
                            f"{command}"
                        )
                    else:
                        content = f"当前只读权限拒绝了该命令：{command}"
                    yield InternalEvent(type="live_message", data={
                        "message_id": f"approval:{tool_use_id or 'unknown'}",
                        "content": content,
                        "status": "delivered",
                        "session_id": self._thread_id,
                    })
                    return
                if signature and signature in self._session_reject:
                    # 本运行内已记住「拒绝本次运行」：不再弹窗，直接注入决定。
                    yield InternalEvent(type="live_message", data={
                        "message_id": f"approval:{tool_use_id or 'unknown'}",
                        "content": (
                            f"用户拒绝了该命令：{command}，请改用其他方式或跳过。"
                            f"本次运行内相同命令将自动拒绝。"
                        ),
                        "status": "delivered",
                        "session_id": self._thread_id,
                    })
                    return
                yield event
                response = await self.request_interaction(event, _noop_publish)
                outcome = response.get("outcome") or {}
                option_id = str(outcome.get("option_id") or "")
                if option_id == "allow_once":
                    self._escalate_sandbox = True
                    content = (
                        f"用户已批准执行被拒的命令，沙箱权限已提升，"
                        f"请重新尝试该命令：{command}"
                    )
                else:
                    if option_id == "reject_for_session" and signature:
                        self._session_reject.add(signature)
                        content = (
                            f"用户拒绝了该命令：{command}，请改用其他方式或跳过。"
                            f"本次运行内相同命令将自动拒绝。"
                        )
                    else:
                        content = f"用户拒绝了该命令：{command}，请改用其他方式或跳过。"
                yield InternalEvent(type="live_message", data={
                    "message_id": f"approval:{tool_use_id or 'unknown'}",
                    "content": content,
                    "status": "delivered",
                    "session_id": self._thread_id,
                })
                return
            yield event

    def _map_event(self, obj: dict) -> InternalEvent | None:
        """Map Codex event to InternalEvent."""
        event_type = obj.get("type", "")

        # Codex CLI emits this when its automatic context compaction finishes.
        # Older/newer transports may wrap the message in ``event_msg``.
        compacted = obj
        if event_type == "event_msg" and isinstance(obj.get("msg"), dict):
            compacted = obj["msg"]
            event_type = compacted.get("type", "")
        if event_type in {"context_compacted", "thread/compacted", "compacted"}:
            summary = (
                compacted.get("summary")
                or compacted.get("compact_summary")
                or compacted.get("text")
            )
            return InternalEvent(
                type="compacted",
                data={"summary": str(summary)} if summary else {},
            )

        if event_type == "thread.started":
            return InternalEvent(type="status", data={"status": "initializing"})

        if event_type == "turn.started":
            return InternalEvent(type="status", data={"status": "running"})

        if event_type in {"turn.plan.updated", "turn/plan/updated"}:
            return plan_event(
                obj.get("plan") or [],
                explanation=obj.get("explanation"),
            )

        if event_type == "item.completed":
            item = obj.get("item", {})
            item_type = item.get("type", "")

            if item_type == "collab_agent_tool_call":
                agents_states = item.get("agents_states") or []
                content = "\n".join(
                    str(state.get("message") or state)
                    for state in agents_states
                    if isinstance(state, dict)
                )
                status = ""
                if agents_states and isinstance(agents_states[-1], dict):
                    status = str(agents_states[-1].get("status") or "")
                return tool_call_update_event(
                    tool_call_id=str(item.get("id") or ""),
                    status="failed" if status in {"failed", "error", "declined"} else "completed",
                    raw_output=content or "",
                )

            if item_type == "agent_message":
                text = item.get("text") or item.get("message") or ""
                if text:
                    return agent_message_chunk(
                        text, phase=item.get("phase"), source_item_id=item.get("id"),
                    )

            elif item_type in {"reasoning", "analysis"}:
                thinking = extract_reasoning_text(
                    item.get("text") or item.get("summary") or item.get("content")
                )
                if thinking:
                    return InternalEvent(
                        type="agent_thought_chunk",
                        data={"content": {"text": thinking}},
                    )

            elif item_type == "command_execution":
                cmd = item.get("command", "")
                output = item.get("output", "")
                is_error = item.get("exit_code", 0) != 0
                if is_error and _SANDBOX_DENIAL_PATTERN.search(str(output or "")):
                    interaction_id = str(uuid.uuid4())
                    signature = permission_signature("Bash", {"command": cmd})
                    if signature:
                        self._permission_signatures[interaction_id] = signature
                    return permission_request(
                        interaction_id=interaction_id,
                        session_id=self._thread_id or "codex",
                        tool_call={
                            "tool_call_id": item.get("id", ""),
                            "title": f"执行命令: {str(cmd)[:120]}",
                            "name": "Bash",
                            "raw_input": {"command": cmd, "denial": output},
                        },
                        options=[
                            {"option_id": "allow_once", "name": "允许并提升沙箱", "kind": "allow_once"},
                            {"option_id": "reject_once", "name": "拒绝", "kind": "reject_once"},
                            {"option_id": "reject_for_session", "name": "拒绝本次运行", "kind": "reject_for_session"},
                        ],
                    )
                return tool_call_update_event(
                    tool_call_id=str(item.get("id") or ""),
                    status="failed" if is_error else "completed",
                    raw_output=output,
                )

        if event_type == "item.started":
            item = obj.get("item", {})
            if item.get("type") == "collab_agent_tool_call":
                return tool_call_event(
                    tool_call_id=str(item.get("id") or ""),
                    title=item.get("tool") or "spawnAgent",
                    kind="other",
                    raw_input={
                        "prompt": item.get("prompt"),
                        "model": item.get("model"),
                        "receiver_thread_ids": item.get("receiver_thread_ids") or [],
                    },
                )
            if item.get("type") == "command_execution":
                return tool_call_event(
                    tool_call_id=str(item.get("id") or ""),
                    title="Bash",
                    kind="execute",
                    raw_input={"command": item.get("command", "")},
                )

        if event_type == "turn.completed":
            usage = obj.get("usage", {})
            data = {
                "input_tokens": usage.get("input_tokens", 0),
                "output_tokens": usage.get("output_tokens", 0),
                "cache_creation_input_tokens": usage.get(
                    "cache_creation_input_tokens",
                    usage.get("cache_write_input_tokens", 0),
                ),
                "cache_read_input_tokens": usage.get(
                    "cache_read_input_tokens",
                    usage.get("cached_input_tokens", 0),
                ),
            }
            thought_tokens = (
                usage.get("reasoning_output_tokens")
                or usage.get("reasoning_tokens")
                or 0
            )
            if thought_tokens:
                data["thought_tokens"] = thought_tokens
            cost = normalize_cost(usage)
            if cost is not None:
                data["cost"] = cost
            return usage_update_event(data)

        if event_type in ("error", "turn.failed"):
            return InternalEvent(type="error", data={
                "message": obj.get("message", obj.get("error", "Unknown error")),
            })

        return None

    async def stop(self) -> None:
        if self._process and self._running:
            self._process.terminate()
            try:
                await asyncio.wait_for(self._process.wait(), timeout=5)
            except asyncio.TimeoutError:
                self._process.kill()
            self._running = False

    async def inject_response(self, tool_use_id: str, content: str) -> None:
        logger.warning("inject_response not supported for Codex")

    @property
    def supports_resume(self) -> bool:
        return True

    @property
    def supports_interactive(self) -> bool:
        return False  # codex exec 非交互模式无执行中注入协议

    @property
    def supports_live_stage_message(self) -> bool:
        """插入消息以「终止当前进程 + 新消息 resume 重启」的方式支持。"""
        return True

    @property
    def supports_thinking_effort(self) -> bool:
        """``-c model_reasoning_effort=...`` supports a per-turn override."""
        return True

    # --- ACP 会话 / 审批契约（非 ACP 引擎：用自己的传输实现等价语义） ---

    #: spawn 实际产出的 ACP 词汇事件（声明 = 实际；无原生来源不合成）。
    acp_events: frozenset[str] = frozenset({
        "subagent",
        "agent_message_chunk",
        "agent_thought_chunk",
        "tool_call",
        "tool_call_update",
        "plan",
        "usage_update",
        "interaction_request",
        "live_message",
        "status",
        "session_started",
        "compacted",
        "error",
    })

    @property
    def supports_sessions(self) -> bool:
        """codex exec 按 thread_id 原生支持 resume，会话随首次 spawn 建立。"""
        return True

    @property
    def supports_tool_approval(self) -> bool:
        """沙箱拒绝 → permission 弹窗 → 批准后提权重试，原生审批语义。"""
        return True

    async def create_session(
        self,
        cwd: str,
        add_dirs: list[str] | None = None,
        mcp_servers: list | None = None,
    ) -> str | None:
        """无法脱离提示词创建空会话；会话在首次 spawn（thread.started）时建立。"""
        logger.info("Codex create_session: not supported without a prompt")
        return None

    async def resume_session(
        self,
        session_id: str,
        cwd: str,
        add_dirs: list[str] | None = None,
        mcp_servers: list | None = None,
    ) -> bool:
        """codex exec resume <thread_id> 原生恢复；spawn(session_id=...) 时实际恢复。"""
        return bool(session_id)

    async def close_session(self, session_id: str, cwd: str | None = None) -> None:
        """关闭会话 = 结束当前运行中的 codex 进程。"""
        if self._running:
            await self.stop()

    async def cancel_session(self, session_id: str, cwd: str | None = None) -> None:
        """取消会话 = 终止当前运行中的 codex 进程。"""
        if self._running:
            await self.stop()

    async def set_config_option(
        self,
        config_id: str,
        value: str | bool,
        session_id: str | None = None,
    ) -> None:
        """配置在 spawn 时从 config_store 读取（-c / --sandbox）；运行中修改无原生入口。"""
        return None

    async def reset_options(self, session_id: str | None = None) -> None:
        """无原生 reset；新会话从全局配置重新读取。"""
        return None

    def build_resume_params(self, session_id: str) -> dict:
        return {"session_id": session_id}
    @property
    def skill_invocation_prefix(self) -> str:
        return "$"

    def input_commands(self) -> list[dict[str, str]]:
        return workstep_input_commands()
