"""OpenClawEngine — OpenClaw CLI implementation."""

import asyncio
import json
import logging
import os
import shutil
import uuid
from typing import AsyncIterator

from engines.core.acp_base import AcpEngineBase
from engines.core.schema import EngineImage
from engines.core.events import (
    InternalEvent,
    normalize_token_usage,
    tool_call_event,
    tool_call_update_event,
    usage_update_event,
)

logger = logging.getLogger(__name__)


class OpenClawEngine(AcpEngineBase):
    ENGINE_ID = "openclaw"

    """OpenClaw's stable one-shot ``agent exec --json`` integration."""

    def __init__(self):
        super().__init__()
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

    @staticmethod
    def build_command(
        binary: str,
        prompt: str,
        cwd: str,
        model: str | None = None,
    ) -> list[str]:
        cmd = [binary, "agent", "exec", prompt, "--cwd", cwd, "--json"]
        if model:
            cmd.extend(["--model", model])
        return cmd

    async def spawn(
        self,
        prompt: str,
        cwd: str,
        model: str | None = None,
        add_dirs: list[str] | None = None,
        session_id: str | None = None,
        images: list[EngineImage] | None = None,
        config_overrides: dict | None = None,
    ) -> AsyncIterator[InternalEvent]:
        """Run OpenClaw's stable JSON envelope command.

        OpenClaw does not expose token deltas on this headless interface, so
        the final assistant text is emitted as one ``text_delta`` event.
        """
        self.require_native_credentials_allowed()
        prompt, binary = await asyncio.to_thread(
            lambda: (self.render_image_prompt(prompt, images), self.resolve_binary())
        )
        if not binary:
            yield InternalEvent(type="error", data={"message": "openclaw binary not found"})
            return

        cmd = self.build_command(binary, prompt, cwd, model=model)
        from services.skill_runtime import write_openclaw_config

        openclaw_config = await asyncio.to_thread(
            lambda: write_openclaw_config(self.project_skills(cwd))
        )

        logger.info("Spawning: %s (cwd=%s)", " ".join(cmd), cwd)

        process_env = dict(os.environ)
        process_env["OPENCLAW_CONFIG_PATH"] = str(openclaw_config)
        self._process = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd,
            env=process_env,
            limit=1024 * 256,
        )
        self._running = True

        yield InternalEvent(type="status", data={"status": "running"})
        stdout, stderr = await self._process.communicate()
        exit_code = self._process.returncode
        self._running = False

        try:
            envelope = json.loads(stdout.decode(errors="replace"))
        except json.JSONDecodeError:
            yield InternalEvent(type="error", data={
                "message": "OpenClaw 未返回有效 JSON",
                "stderr": stderr.decode(errors="replace"),
            })
            return

        mapped = self._map_envelope(envelope)
        if (
            not any(event.type in {"session_started", "error"} for event in mapped)
            and envelope.get("ok")
        ):
            mapped.insert(0, InternalEvent(
                type="session_started", data={"session_id": str(uuid.uuid4())}
            ))
        for event in mapped:
            yield event
        has_error = any(event.type == "error" for event in mapped)
        if exit_code != 0 and not has_error:
            yield InternalEvent(type="error", data={
                "message": f"OpenClaw 进程退出码 {exit_code}",
                "stderr": stderr.decode(errors="replace"),
            })
        elif exit_code == 0 and not has_error:
            yield InternalEvent(type="status", data={"status": "done"})

    def _map_envelope(self, obj: dict) -> list[InternalEvent]:
        """Map the documented ``agent exec --json`` response envelope."""
        if not obj.get("ok") or obj.get("status") in {"error", "timeout"}:
            error = obj.get("error") or {}
            message = error.get("message") if isinstance(error, dict) else error
            return [InternalEvent(type="error", data={
                "message": str(message or "OpenClaw 执行失败"),
                "kind": error.get("kind") if isinstance(error, dict) else None,
            })]

        events: list[InternalEvent] = []
        session_id = obj.get("sessionId")
        if session_id:
            events.append(InternalEvent(
                type="session_started", data={"session_id": str(session_id)}
            ))
        final = obj.get("final") or ""
        if not final:
            final = "\n".join(
                str(item.get("text") or "")
                for item in obj.get("payloads") or []
                if isinstance(item, dict) and item.get("text")
            )
        if final:
            events.append(InternalEvent(
                type="agent_message_chunk",
                data={"content": {"text": str(final)}},
            ))
        usage = obj.get("usage")
        if isinstance(usage, dict):
            usage_data = normalize_token_usage({
                "input_tokens": usage.get("input", 0),
                "output_tokens": usage.get("output", 0),
                "total_tokens": usage.get("total", 0),
                "cost_usd": obj.get("costUsd"),
            })
            if session_id:
                usage_data["session_id"] = str(session_id)
            events.append(usage_update_event(usage_data))
        return events

    def _map_event(self, obj: dict) -> InternalEvent | None:
        """Map an OpenClaw event to InternalEvent."""
        # Placeholder implementation - adjust based on actual openclaw event format
        event_type = obj.get("type", "")

        if event_type == "status":
            return InternalEvent(type="status", data={"status": obj.get("value", "running")})

        if event_type == "output":
            return InternalEvent(
                type="agent_message_chunk",
                data={"content": {"text": obj.get("text", "")}},
            )

        if event_type in {"thinking", "reasoning"}:
            return InternalEvent(
                type="agent_thought_chunk",
                data={"content": {"text": obj.get("text", obj.get("content", ""))}},
            )

        if event_type == "tool":
            if obj.get("status") in {"completed", "failed", "error"}:
                return tool_call_update_event(
                    tool_call_id=str(obj.get("id", obj.get("tool_use_id", ""))),
                    status="failed" if obj.get("status") in {"failed", "error"} else "completed",
                    raw_output=obj.get("output", obj.get("result", "")),
                )
            return tool_call_event(
                tool_call_id=str(obj.get("id", obj.get("tool_use_id", ""))),
                title=obj.get("tool", ""),
                raw_input=obj.get("input", {}),
            )

        if event_type == "tool_result":
            return tool_call_update_event(
                tool_call_id=str(obj.get("tool_use_id", obj.get("id", ""))),
                status="failed" if bool(obj.get("is_error", False)) else "completed",
                raw_output=obj.get("content", obj.get("output", "")),
            )

        if event_type == "usage":
            usage = obj.get("usage") if isinstance(obj.get("usage"), dict) else obj
            return usage_update_event(usage)

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
        return False

    @property
    def supports_interactive(self) -> bool:
        return False

    # --- ACP 事件契约（非 ACP 引擎：声明 = 实际，无原生来源不合成） ---

    #: spawn（agent exec --json 信封）实际产出的 ACP 词汇事件；
    #: 无会话 / 审批 / 直播消息能力（一次性 exec，supports_resume=False）。
    acp_events: frozenset[str] = frozenset({
        "agent_message_chunk",
        "usage_update",
        "session_started",
        "status",
        "error",
    })

    def build_resume_params(self, session_id: str) -> dict:
        return {}
