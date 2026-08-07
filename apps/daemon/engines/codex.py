"""CodexEngine — direct CLI mode (codex exec)."""

import asyncio
import json
import logging
import os
import platform
import shutil
import uuid
from contextlib import suppress
from typing import AsyncIterator

from engines.base import BaseLLMEngine
from engines.events import InternalEvent, normalize_cost
from engines.schema import EngineConfigField, EngineConfigOption, EngineImage
from services.config import (
    CODEX_APPROVAL_POLICIES,
    CODEX_REASONING_EFFORTS,
    CODEX_SANDBOX_MODES,
    config_store,
)

logger = logging.getLogger(__name__)


class CodexEngine(BaseLLMEngine):
    """Codex CLI engine using direct subprocess.

    Spawns `codex exec --json` and parses JSONL stdout.
    """

    def __init__(self):
        self._process: asyncio.subprocess.Process | None = None
        self._running = False
        self._stderr: list[bytes] = []
        self._thread_id: str | None = None

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
        config_store.set_codex_config(
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
    ) -> AsyncIterator[InternalEvent]:
        """Run ``codex exec``, restarting with ``resume`` on live messages.

        codex exec 没有执行中注入协议。当 ``live_message_queue`` 中出现插入
        消息时，终止当前进程，并用该消息作为提示词经 ``codex exec resume
        <session_id> <消息>`` 重启同一会话，从而延续完整上下文继续作答。
        """
        binary = self.resolve_binary()
        if not binary:
            yield InternalEvent(type="error", data={"message": "codex binary not found"})
            return

        codex_config = config_store.get_codex_config()
        run_prompt = prompt
        resume_session = session_id or None

        while True:
            cmd = [binary, "exec", "--json", "--skip-git-repo-check"]
            if resume_session:
                # `codex exec resume <session_id> <prompt>` 恢复上次会话，复用完整
                # 上下文；会话已记录 cwd，恢复时沿用原工作目录。
                cmd.extend(["resume", resume_session, run_prompt])
            else:
                cmd.extend([
                    "--sandbox",
                    codex_config["sandbox_mode"] or self._default_sandbox(),
                    "-C", cwd,
                ])

            if model:
                cmd.extend(["--model", model])

            if codex_config["model_reasoning_effort"]:
                cmd.extend(
                    ["-c", f"model_reasoning_effort={codex_config['model_reasoning_effort']}"]
                )
            if codex_config["approval_policy"]:
                cmd.extend(["-c", f"approval_policy={codex_config['approval_policy']}"])

            logger.info("Spawning: %s", " ".join(cmd))

            self._process = await asyncio.create_subprocess_exec(
                *cmd,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=cwd,
            )
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
                line = await asyncio.wait_for(
                    self._process.stdout.readline(), timeout=0.25
                )
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

            event = self._map_event(obj)
            if event:
                yield event

    def _map_event(self, obj: dict) -> InternalEvent | None:
        """Map Codex event to InternalEvent."""
        event_type = obj.get("type", "")

        if event_type == "thread.started":
            return InternalEvent(type="status", data={"status": "initializing"})

        if event_type == "turn.started":
            return InternalEvent(type="status", data={"status": "running"})

        if event_type == "item.completed":
            item = obj.get("item", {})
            item_type = item.get("type", "")

            if item_type == "agent_message":
                text = item.get("text") or item.get("message") or ""
                if text:
                    return InternalEvent(type="text_delta", data={"delta": text})

            elif item_type in {"reasoning", "analysis"}:
                thinking = item.get("text") or item.get("summary") or ""
                if isinstance(thinking, list):
                    thinking = "\n".join(str(part) for part in thinking)
                if thinking:
                    return InternalEvent(
                        type="thinking_delta",
                        data={"delta": str(thinking)},
                    )

            elif item_type == "command_execution":
                cmd = item.get("command", "")
                output = item.get("output", "")
                return InternalEvent(type="tool_result", data={
                    "tool_use_id": item.get("id", ""),
                    "content": output,
                    "is_error": item.get("exit_code", 0) != 0,
                })

        if event_type == "item.started":
            item = obj.get("item", {})
            if item.get("type") == "command_execution":
                return InternalEvent(type="tool_use", data={
                    "id": item.get("id", ""),
                    "name": "Bash",
                    "input": {"command": item.get("command", "")},
                })

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
            return InternalEvent(type="usage", data=data)

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

    def build_resume_params(self, session_id: str) -> dict:
        return {"session_id": session_id}
