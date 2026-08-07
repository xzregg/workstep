"""ClaudeCodeEngine — direct CLI mode (claude -p)."""

import asyncio
import json
import logging
import os
import shlex
import shutil
from typing import AsyncIterator

from engines.base import BaseLLMEngine, EngineModel
from engines.events import InternalEvent, normalize_cost
from engines.schema import EngineConfigField, EngineConfigOption, EngineImage
from services.config import CLAUDE_PERMISSION_MODES, config_store

logger = logging.getLogger(__name__)


class ClaudeCodeEngine(BaseLLMEngine):
    """Claude Code CLI engine using direct subprocess.

    Spawns `claude -p --output-format stream-json` and parses JSONL stdout.
    """

    def __init__(self):
        self._process: asyncio.subprocess.Process | None = None
        self._running = False
        self._live_mode = False

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
        ]

    def get_config_values(self) -> dict:
        return {"permission_mode": config_store.get_claude_permission_mode()}

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
        config_store.set_claude_permission_mode(mode)

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
    ) -> list[str]:
        cmd = [
            binary,
            "-p",
            "--output-format", "stream-json",
            "--verbose",
            "--permission-mode", permission_mode,
        ]
        if live_mode:
            # Realtime streaming input: keep stdin open and accept JSONL user
            # messages so mid-execution stage messages can be injected.
            cmd.extend(["--input-format", "stream-json"])
        if model:
            cmd.extend(["--model", model])
        if session_id:
            cmd.extend(["--resume", session_id])
        if add_dirs:
            for directory in add_dirs:
                cmd.extend(["--add-dir", directory])
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
    ) -> AsyncIterator[InternalEvent]:
        """Spawn claude CLI and stream events.

        When ``live_message_queue`` is given the CLI runs in stream-json input
        mode: stdin stays open and queued ``(message_id, content)`` pairs are
        injected as ordinary user messages while the turn is still running.
        """
        prompt = self.render_image_prompt(prompt, images)
        binary = self.resolve_binary()
        if not binary:
            yield InternalEvent(type="error", data={"message": "claude binary not found"})
            return

        permission_mode = config_store.get_claude_permission_mode()
        if not permission_mode:
            yield InternalEvent(type="error", data={
                "message": "Claude Code 权限模式尚未确认，请先在设置中选择权限模式",
            })
            return

        self._live_mode = live_message_queue is not None
        cmd = self.build_command(
            binary,
            permission_mode,
            model=model,
            session_id=session_id,
            add_dirs=add_dirs,
            live_mode=self._live_mode,
        )

        command_text = shlex.join(cmd)
        logger.info("Spawning: %s (cwd=%s)", command_text, cwd)
        print(
            "[ClaudeCodeEngine] "
            f"session={'resume:' + session_id if session_id else 'new'} "
            f"cwd={cwd} command={command_text}",
            flush=True,
        )

        self._process = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd,
        )
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
        # Parse stdout JSONL; deliver queued live messages between events.
        async for event in self._parse_stdout():
            yield event
            if self._live_mode and live_message_queue is not None:
                while not live_message_queue.empty():
                    message_id, content = live_message_queue.get_nowait()
                    delivered = await self.send_live_stage_message(content)
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
        else:
            yield InternalEvent(type="status", data={"status": "done"})

    async def _parse_stdout(self) -> AsyncIterator[InternalEvent]:
        """Parse Claude's stream-json stdout into InternalEvents."""
        async for line in self._process.stdout:
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
            event = self._map_event(obj)
            if event:
                yield event

    def _map_event(self, obj: dict) -> InternalEvent | None:
        """Map a Claude JSONL event to InternalEvent."""
        event_type = obj.get("type", "")

        if event_type == "system" and obj.get("subtype") == "init":
            return InternalEvent(type="status", data={"status": "initializing"})

        if event_type == "assistant":
            # Assistant message with content blocks
            for block in obj.get("message", {}).get("content", []):
                block_type = block.get("type", "")
                if block_type == "text":
                    return InternalEvent(type="text_delta", data={"delta": block.get("text", "")})
                elif block_type == "thinking":
                    return InternalEvent(type="thinking_delta", data={"delta": block.get("thinking", "")})
                elif block_type == "tool_use":
                    return InternalEvent(type="tool_use", data={
                        "id": block.get("id", ""),
                        "name": block.get("name", ""),
                        "input": block.get("input", {}),
                    })

        if event_type == "result":
            usage = obj.get("usage") or obj
            data = {
                "input_tokens": usage.get("input_tokens", 0),
                "output_tokens": usage.get("output_tokens", 0),
                "cache_creation_input_tokens": usage.get("cache_creation_input_tokens", 0),
                "cache_read_input_tokens": usage.get("cache_read_input_tokens", 0),
                "session_id": obj.get("session_id"),
            }
            cost = normalize_cost(usage)
            if cost is None:
                # claude CLI 把 total_cost_usd / cost_usd 放在 result 顶层
                cost = normalize_cost(obj)
            if cost is not None:
                data["cost"] = cost
            return InternalEvent(type="usage", data=data)

        if event_type == "user":
            # Tool results from Claude
            for block in obj.get("message", {}).get("content", []):
                if block.get("type") == "tool_result":
                    return InternalEvent(type="tool_result", data={
                        "tool_use_id": block.get("tool_use_id", ""),
                        "content": block.get("content", ""),
                        "is_error": block.get("is_error", False),
                    })

        return None

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

    async def inject_response(self, tool_use_id: str, content: str) -> None:
        """Inject response — not supported in direct CLI mode (use ACP for this)."""
        logger.warning("inject_response not supported in direct CLI mode")

    async def send_live_stage_message(self, content: str) -> bool:
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
    def supports_live_stage_message(self) -> bool:
        return True

    @property
    def supports_vision(self) -> bool:
        """Claude models accept markdown image references in prompts."""
        return True

    def build_resume_params(self, session_id: str) -> dict:
        return {"session_id": session_id}
