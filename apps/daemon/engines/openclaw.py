"""OpenClawEngine — OpenClaw CLI implementation."""

import asyncio
import json
import logging
import os
import shutil
from typing import AsyncIterator

from engines.base import BaseLLMEngine
from engines.events import InternalEvent, normalize_token_usage

logger = logging.getLogger(__name__)


class OpenClawEngine(BaseLLMEngine):
    """OpenClaw CLI engine implementation.

    Protocol details to be determined based on actual OpenClaw CLI specification.
    """

    def __init__(self):
        self._process: asyncio.subprocess.Process | None = None
        self._running = False

    # --- Engine discovery ---

    @staticmethod
    def is_installed() -> bool:
        return OpenClawEngine.resolve_binary() is not None

    @staticmethod
    def get_version() -> str | None:
        binary = OpenClawEngine.resolve_binary()
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
        """Resolve openclaw binary: OPENCLAW_BIN env → PATH → 'openclaw'."""
        override = OpenClawEngine.get_binary_override()
        if override is not None:
            return override if os.path.isfile(override) else None
        env_bin = os.environ.get("OPENCLAW_BIN")
        if env_bin and os.path.isfile(env_bin):
            return env_bin
        found = shutil.which("openclaw")
        return found

    # --- Execution ---

    async def spawn(
        self,
        prompt: str,
        cwd: str,
        model: str | None = None,
        add_dirs: list[str] | None = None,
        session_id: str | None = None,
    ) -> AsyncIterator[InternalEvent]:
        """Spawn openclaw CLI and stream events."""
        binary = self.resolve_binary()
        if not binary:
            yield InternalEvent(type="error", data={"message": "openclaw binary not found"})
            return

        # Placeholder command - adjust based on actual openclaw CLI spec
        cmd = [binary, "run", "--prompt", prompt]

        if model:
            cmd.extend(["--model", model])
        if session_id:
            cmd.extend(["--session", session_id])

        logger.info("Spawning: %s (cwd=%s)", " ".join(cmd), cwd)

        self._process = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd,
        )
        self._running = True

        yield InternalEvent(type="status", data={"status": "running"})

        # Parse stdout - adjust based on actual openclaw output format
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
        """Parse OpenClaw stdout into InternalEvents.

        This implementation assumes a JSONL format.
        Adjust based on actual openclaw output specification.
        """
        async for line in self._process.stdout:
            line = line.decode(errors="replace").strip()
            if not line:
                continue

            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                logger.warning("Non-JSON line from openclaw: %s", line[:100])
                continue

            event = self._map_event(obj)
            if event:
                yield event

    def _map_event(self, obj: dict) -> InternalEvent | None:
        """Map an OpenClaw event to InternalEvent."""
        # Placeholder implementation - adjust based on actual openclaw event format
        event_type = obj.get("type", "")

        if event_type == "status":
            return InternalEvent(type="status", data={"status": obj.get("value", "running")})

        if event_type == "output":
            return InternalEvent(type="text_delta", data={"delta": obj.get("text", "")})

        if event_type in {"thinking", "reasoning"}:
            return InternalEvent(
                type="thinking_delta",
                data={"delta": obj.get("text", obj.get("content", ""))},
            )

        if event_type == "tool":
            if obj.get("status") in {"completed", "failed", "error"}:
                return InternalEvent(type="tool_result", data={
                    "tool_use_id": obj.get("id", obj.get("tool_use_id", "")),
                    "content": obj.get("output", obj.get("result", "")),
                    "is_error": obj.get("status") in {"failed", "error"},
                })
            return InternalEvent(type="tool_use", data={
                "id": obj.get("id", obj.get("tool_use_id", "")),
                "name": obj.get("tool", ""),
                "input": obj.get("input", {}),
            })

        if event_type == "tool_result":
            return InternalEvent(type="tool_result", data={
                "tool_use_id": obj.get("tool_use_id", obj.get("id", "")),
                "content": obj.get("content", obj.get("output", "")),
                "is_error": bool(obj.get("is_error", False)),
            })

        if event_type == "usage":
            usage = obj.get("usage") if isinstance(obj.get("usage"), dict) else obj
            return InternalEvent(type="usage", data=normalize_token_usage(usage))

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
        """Inject response to a tool use."""
        logger.warning("inject_response not implemented for OpenClaw")
        # Placeholder for future implementation

    # --- Session resume ---

    @property
    def supports_resume(self) -> bool:
        return False  # OpenClaw does not support session resume

    @property
    def supports_interactive(self) -> bool:
        return False

    def build_resume_params(self, session_id: str) -> dict:
        return {}
