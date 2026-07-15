"""CodexEngine — direct CLI mode (codex exec)."""

import asyncio
import json
import logging
import os
import platform
import shutil
from typing import AsyncIterator

from engines.base import BaseLLMEngine
from engines.events import InternalEvent

logger = logging.getLogger(__name__)


class CodexEngine(BaseLLMEngine):
    """Codex CLI engine using direct subprocess.

    Spawns `codex exec --json` and parses JSONL stdout.
    """

    def __init__(self):
        self._process: asyncio.subprocess.Process | None = None
        self._running = False

    @staticmethod
    def is_installed() -> bool:
        return CodexEngine.resolve_binary() is not None

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

    async def spawn(
        self,
        prompt: str,
        cwd: str,
        model: str | None = None,
        add_dirs: list[str] | None = None,
        session_id: str | None = None,
    ) -> AsyncIterator[InternalEvent]:
        binary = self.resolve_binary()
        if not binary:
            yield InternalEvent(type="error", data={"message": "codex binary not found"})
            return

        cmd = [
            binary, "exec",
            "--json",
            "--skip-git-repo-check",
            "--sandbox", self._default_sandbox(),
            "-C", cwd,
        ]

        if model:
            cmd.extend(["--model", model])

        logger.info("Spawning: %s", " ".join(cmd))

        self._process = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd,
        )
        self._running = True

        # Codex: write prompt to stdin and close
        self._process.stdin.write(prompt.encode())
        await self._process.stdin.drain()
        self._process.stdin.close()

        yield InternalEvent(type="status", data={"status": "running"})

        async for event in self._parse_stdout():
            yield event

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
        """Parse Codex JSONL stdout."""
        async for line in self._process.stdout:
            line = line.decode(errors="replace").strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue

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
                text = item.get("message", "")
                if text:
                    return InternalEvent(type="text_delta", data={"delta": text})

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
            return InternalEvent(type="usage", data={
                "input_tokens": usage.get("input_tokens", 0),
                "output_tokens": usage.get("output_tokens", 0),
            })

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
        return False

    @property
    def supports_interactive(self) -> bool:
        return False

    def build_resume_params(self, session_id: str) -> dict:
        return {}
