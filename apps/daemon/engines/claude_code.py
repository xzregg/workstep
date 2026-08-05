"""ClaudeCodeEngine — direct CLI mode (claude -p)."""

import asyncio
import json
import logging
import os
import shlex
import shutil
from typing import AsyncIterator

from engines.base import BaseLLMEngine, EngineModel
from engines.events import InternalEvent
from services.config import config_store

logger = logging.getLogger(__name__)


class ClaudeCodeEngine(BaseLLMEngine):
    """Claude Code CLI engine using direct subprocess.

    Spawns `claude -p --output-format stream-json` and parses JSONL stdout.
    """

    def __init__(self):
        self._process: asyncio.subprocess.Process | None = None
        self._running = False

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
    ) -> list[str]:
        cmd = [
            binary,
            "-p",
            "--output-format", "stream-json",
            "--verbose",
            "--permission-mode", permission_mode,
        ]
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
    ) -> AsyncIterator[InternalEvent]:
        """Spawn claude CLI and stream events."""
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

        cmd = self.build_command(
            binary,
            permission_mode,
            model=model,
            session_id=session_id,
            add_dirs=add_dirs,
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

        # Send prompt via stdin
        self._process.stdin.write((prompt + "\n").encode())
        await self._process.stdin.drain()
        self._process.stdin.close()

        yield InternalEvent(type="status", data={"status": "running"})

        # Parse stdout JSONL
        async for event in self._parse_stdout():
            yield event

        # Wait for process exit
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
            return InternalEvent(type="usage", data={
                "input_tokens": usage.get("input_tokens", 0),
                "output_tokens": usage.get("output_tokens", 0),
                "cache_creation_input_tokens": usage.get("cache_creation_input_tokens", 0),
                "cache_read_input_tokens": usage.get("cache_read_input_tokens", 0),
                "session_id": obj.get("session_id"),
            })

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

    # --- Session resume ---

    @property
    def supports_resume(self) -> bool:
        return True

    @property
    def supports_interactive(self) -> bool:
        return False  # Direct CLI mode doesn't support mid-execution interaction

    def build_resume_params(self, session_id: str) -> dict:
        return {"session_id": session_id}
