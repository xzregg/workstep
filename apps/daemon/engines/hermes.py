"""HermesEngine — JSON-RPC bidirectional communication."""

import asyncio
import json
import logging
import os
import shutil
from typing import AsyncIterator

from engines.core.acp_base import AcpEngineBase
from engines.core.plans import plan_event
from engines.core.events import (
    InternalEvent,
    acp_raw_event,
    normalize_token_usage,
)
from engines.core.schema import EngineImage

logger = logging.getLogger(__name__)


class HermesEngine(AcpEngineBase):
    ENGINE_ID = "hermes"

    """Hermes ACP engine using JSON-RPC over stdin/stdout.

    Lifecycle: initialize → session/new → session/prompt → stream updates.
    Surfaces ACP permission requests through WorkStep's interaction UI.
    """

    def __init__(self):
        super().__init__()
        self._process: asyncio.subprocess.Process | None = None
        self._running = False
        self._request_id = 0

    @staticmethod
    def is_installed() -> bool:
        return HermesEngine.resolve_binary() is not None

    @staticmethod
    def get_version() -> str | None:
        binary = HermesEngine.resolve_binary()
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
        override = HermesEngine.get_binary_override()
        if override is not None:
            return override if os.path.isfile(override) else None
        env_bin = os.environ.get("HERMES_BIN")
        if env_bin and os.path.isfile(env_bin):
            return env_bin
        return shutil.which("hermes")

    def get_command(self) -> list[str]:
        binary = self.resolve_binary()
        return [binary, "acp", "--accept-hooks"] if binary else []

    def get_permission_mode(self) -> str:
        """ACP permissions must be decided by the user, never auto-approved."""
        return "ask"

    def _next_id(self) -> int:
        self._request_id += 1
        return self._request_id

    async def _send_rpc(self, method: str, params: dict | None = None) -> int:
        """Send a JSON-RPC request to stdin. Returns request ID."""
        req_id = self._next_id()
        msg = {
            "jsonrpc": "2.0",
            "id": req_id,
            "method": method,
        }
        if params:
            msg["params"] = params
        data = json.dumps(msg) + "\n"
        self._process.stdin.write(data.encode())
        await self._process.stdin.drain()
        return req_id

    async def _send_response(self, req_id: int, result: dict):
        """Send a JSON-RPC response (for permission approvals)."""
        msg = {"jsonrpc": "2.0", "id": req_id, "result": result}
        data = json.dumps(msg) + "\n"
        self._process.stdin.write(data.encode())
        await self._process.stdin.drain()

    async def spawn(
        self,
        prompt: str,
        cwd: str,
        model: str | None = None,
        add_dirs: list[str] | None = None,
        session_id: str | None = None,
        images: list[EngineImage] | None = None,
        config_overrides: dict | None = None,
        thinking_effort: str | None = None,
    ) -> AsyncIterator[InternalEvent]:
        async for event in super().spawn(
            prompt=prompt,
            cwd=cwd,
            model=model,
            add_dirs=add_dirs,
            session_id=session_id,
            images=images,
            config_overrides=config_overrides,
            thinking_effort=thinking_effort,
        ):
            yield event

    async def _read_until_response(self, target_id: int) -> dict | None:
        """Read lines until we get a response matching target_id."""
        async for line in self._process.stdout:
            line = line.decode(errors="replace").strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if obj.get("id") == target_id:
                return obj
        return None

    async def _stream_until_prompt_done(self, prompt_id: int) -> AsyncIterator[InternalEvent]:
        """Stream events until prompt response is received."""
        async for line in self._process.stdout:
            line = line.decode(errors="replace").strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue

            # Check if this is the prompt completion response
            if obj.get("id") == prompt_id:
                return

            # Handle notifications (session/update)
            if obj.get("method") == "session/update":
                params = obj.get("params", {})
                event = self._map_update(params)
                if event:
                    yield event

            # Handle permission requests — auto-approve
            if obj.get("method") == "session/request_permission":
                req_id = obj.get("id")
                if req_id is not None:
                    await self._send_response(req_id, {"decision": "allow_always"})

    def _map_update(self, params: dict) -> InternalEvent | None:
        """Map a ``session/update`` notification to the ACP-vocabulary event.

        与 ``AcpEngineBase._map_notification`` 对齐：全部 session update 类型
        按 ACP 字段形状产出；未知 update 透传 ``acp_raw`` 不再静默丢弃。
        """
        update_type = params.get("type", "")

        if update_type == "agent_message_chunk":
            content = params.get("content", {})
            if isinstance(content, dict) and content.get("type") == "text":
                return InternalEvent(
                    type="agent_message_chunk",
                    data={"content": {"text": content.get("text", "")}},
                )

        if update_type == "agent_thought_chunk":
            content = params.get("content", {})
            if isinstance(content, dict) and content.get("type") == "text":
                return InternalEvent(
                    type="agent_thought_chunk",
                    data={"content": {"text": content.get("text", "")}},
                )

        if update_type == "user_message_chunk":
            content = params.get("content", {})
            if isinstance(content, dict) and content.get("type") == "text":
                return InternalEvent(
                    type="user_message_chunk",
                    data={"content": {"text": content.get("text", "")}},
                )

        if update_type == "tool_call":
            data = {
                "tool_call_id": str(
                    params.get("toolCallId") or params.get("id") or ""
                ),
                "title": str(
                    params.get("title") or params.get("name") or "tool"
                ),
            }
            if params.get("kind"):
                data["kind"] = params["kind"]
            if params.get("rawInput") is not None:
                data["raw_input"] = params["rawInput"]
            elif params.get("input") is not None:
                data["raw_input"] = params["input"]
            return InternalEvent(type="tool_call", data=data)

        if update_type == "tool_call_update":
            data: dict = {
                "tool_call_id": str(
                    params.get("toolCallId") or params.get("id") or ""
                ),
                "status": str(
                    params.get("status")
                    or ("completed" if params.get("output") is not None else "in_progress")
                ),
            }
            if params.get("rawInput") is not None:
                data["raw_input"] = params["rawInput"]
            elif params.get("input") is not None:
                data["raw_input"] = params["input"]
            if params.get("rawOutput") is not None:
                data["raw_output"] = params["rawOutput"]
            elif params.get("output") is not None:
                data["raw_output"] = params["output"]
            if params.get("title"):
                data["title"] = params["title"]
            if params.get("kind"):
                data["kind"] = params["kind"]
            return InternalEvent(type="tool_call_update", data=data)

        if update_type == "plan":
            return plan_event(self._plan_entries(params))

        if update_type == "plan_update":
            data: dict = {"id": str(params.get("id") or "")}
            if params.get("type"):
                data["type"] = params["type"]
            if params.get("content") is not None:
                data["content"] = params["content"]
            elif params.get("uri") is not None:
                data["uri"] = params["uri"]
            elif params.get("entries") is not None:
                data["entries"] = self._plan_entries(params)
            return InternalEvent(type="plan_update", data=data)

        if update_type == "plan_removed":
            return InternalEvent(type="plan_removed", data={"id": str(params.get("id") or "")})

        if update_type == "usage_update":
            data = normalize_token_usage({
                "input_tokens": params.get("input_tokens", 0),
                "output_tokens": params.get("output_tokens", 0),
                "cache_creation_input_tokens": params.get("cache_creation_input_tokens", 0),
                "cache_read_input_tokens": params.get("cache_read_input_tokens", 0),
                **({"cost": params["cost"]} if params.get("cost") is not None else {}),
            })
            if params.get("used") is not None:
                data["used"] = int(params["used"])
            if params.get("size") is not None:
                data["size"] = int(params["size"])
            return InternalEvent(type="usage_update", data=data)

        if update_type == "session_info_update":
            data: dict = {}
            if params.get("title") is not None:
                data["title"] = params["title"]
            if params.get("updatedAt") is not None:
                data["updated_at"] = params["updatedAt"]
            return InternalEvent(type="session_info_update", data=data)

        if update_type == "available_commands_update":
            return InternalEvent(
                type="available_commands_update",
                data={"available_commands": params.get("availableCommands") or []},
            )

        if update_type == "config_option_update":
            return InternalEvent(
                type="config_option_update",
                data={"config_options": params.get("configOptions") or []},
            )

        if update_type == "current_mode_update":
            return InternalEvent(
                type="current_mode_update",
                data={"current_mode_id": str(params.get("currentModeId") or "")},
            )

        if update_type == "mcp_message":
            data: dict = {
                "connection_id": str(params.get("connectionId") or ""),
                "method": str(params.get("method") or ""),
            }
            if params.get("params") is not None:
                data["params"] = params["params"]
            return InternalEvent(type="mcp_message", data=data)

        if update_type == "elicitation_completed":
            return InternalEvent(
                type="elicitation_completed",
                data={"elicitation_id": str(params.get("elicitationId") or "")},
            )

        return acp_raw_event(params)

    @staticmethod
    def _plan_entries(params: dict) -> list[dict]:
        entries = params.get("entries")
        if not isinstance(entries, list):
            return []
        return [
            {
                "content": str(entry.get("content") or ""),
                "priority": str(entry.get("priority") or "medium"),
                "status": str(entry.get("status") or "pending"),
            }
            for entry in entries
            if isinstance(entry, dict)
        ]

    async def stop(self) -> None:
        if self._process and self._running:
            self._process.stdin.close()
            try:
                await asyncio.wait_for(self._process.wait(), timeout=3)
            except asyncio.TimeoutError:
                self._process.terminate()
                try:
                    await asyncio.wait_for(self._process.wait(), timeout=2)
                except asyncio.TimeoutError:
                    self._process.kill()
            self._running = False

    async def inject_response(self, tool_use_id: str, content: str) -> None:
        logger.warning("inject_response not implemented for Hermes")

    @property
    def supports_resume(self) -> bool:
        return True

    @property
    def supports_thinking_effort(self) -> bool:
        """Best-effort via ACP ``reasoning_effort`` config option."""
        return True

    @property
    def supports_interactive(self) -> bool:
        return True

    def build_resume_params(self, session_id: str) -> dict:
        return {"session_id": session_id}
