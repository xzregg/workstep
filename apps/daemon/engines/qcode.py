"""QCodeEngine — QCode CLI implementation."""

import asyncio
import json
import logging
import os
import shutil
from typing import AsyncIterator

from engines.base import BaseLLMEngine
from engines.events import InternalEvent

logger = logging.getLogger(__name__)


class QCodeEngine(BaseLLMEngine):
    """QCode CLI engine implementation.

    Protocol details to be determined based on actual QCode CLI specification.
    """

    def __init__(self):
        self._process: asyncio.subprocess.Process | None = None
        self._running = False

    # --- Engine discovery ---

    @staticmethod
    def is_installed() -> bool:
        return QCodeEngine.resolve_binary() is not None

    @staticmethod
    def get_version() -> str | None:
        binary = QCodeEngine.resolve_binary()
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
        """Resolve qcode binary: QCODE_BIN env → PATH → 'qcode'."""
        override = QCodeEngine.get_binary_override()
        if override is not None:
            return override if os.path.isfile(override) else None
        env_bin = os.environ.get("QCODE_BIN")
        if env_bin and os.path.isfile(env_bin):
            return env_bin
        found = shutil.which("qcode")
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
        """Spawn qcode CLI and stream events."""
        binary = self.resolve_binary()
        if not binary:
            yield InternalEvent(type="error", data={"message": "qcode binary not found"})
            return

        # Placeholder command - adjust based on actual qcode CLI spec
        cmd = [binary, "--prompt", prompt]

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

        # Parse stdout - adjust based on actual qcode output format
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
        """Parse QCode stdout into InternalEvents.

        This implementation assumes a JSONL format similar to Claude.
        Adjust based on actual qcode output specification.
        """
        async for line in self._process.stdout:
            line = line.decode(errors="replace").strip()
            if not line:
                continue

            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                logger.warning("Non-JSON line from qcode: %s", line[:100])
                continue

            event = self._map_event(obj)
            if event:
                yield event

    def _map_event(self, obj: dict) -> InternalEvent | None:
        """Map a QCode event to InternalEvent."""
        # Placeholder implementation - adjust based on actual qcode event format
        event_type = obj.get("type", "")

        if event_type == "status":
            return InternalEvent(type="status", data={"status": obj.get("value", "running")})

        if event_type == "output":
            return InternalEvent(type="text_delta", data={"delta": obj.get("text", "")})

        if event_type == "tool":
            return InternalEvent(type="tool_use", data={
                "name": obj.get("tool", ""),
                "input": obj.get("input", {}),
            })

        if event_type == "usage":
            return InternalEvent(type="usage", data={
                "tokens": obj.get("tokens", 0),
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
        """Inject response to a tool use."""
        logger.warning("inject_response not implemented for QCode")
        # Placeholder for future implementation

    # --- Session resume ---

    @property
    def supports_resume(self) -> bool:
        return False  # QCode does not support session resume

    @property
    def supports_interactive(self) -> bool:
        return False

    def build_resume_params(self, session_id: str) -> dict:
        return {}
