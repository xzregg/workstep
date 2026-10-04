"""ACP session lifecycle, configuration, and extension commands."""

import logging
from typing import Any

logger = logging.getLogger(__name__)


class ACPSessionProtocol:
    """Own ACP native session and extension commands for engine adapters."""

    # --- ACP-aligned session lifecycle (session/*) ---

    @property
    def supports_sessions(self) -> bool:
        """Whether this engine exposes ACP-style sessions (ACP native only)."""
        return self._is_acp_native

    @property
    def supports_tool_approval(self) -> bool:
        """Whether pending tool calls can be approved (ACP native only)."""
        return self._is_acp_native

    async def create_session(
        self,
        cwd: str,
        add_dirs: list[str] | None = None,
        mcp_servers: list | None = None,
    ) -> str | None:
        """session/new — create a fresh session, return its session id."""
        if not self._is_acp_native:
            return None

        async def action(client):
            self._validate_session_inputs(
                self._initialize_response, add_dirs or [], mcp_servers or []
            )
            session = await client.new_session(
                cwd=cwd,
                additional_directories=add_dirs or [],
                mcp_servers=mcp_servers or [],
            )
            return session.session_id

        return await self._with_agent(cwd, action)

    async def load_session(
        self,
        session_id: str,
        cwd: str,
        add_dirs: list[str] | None = None,
        mcp_servers: list | None = None,
    ) -> bool:
        """session/load — restore a persisted session's context/memory/config."""
        if not self._is_acp_native:
            return False

        async def action(client):
            if not self._agent_capability(
                self._initialize_response, "load_session"
            ):
                return False
            self._validate_session_inputs(
                self._initialize_response, add_dirs or [], mcp_servers or []
            )
            response = await client.load_session(
                cwd=cwd,
                session_id=session_id,
                additional_directories=add_dirs or [],
                mcp_servers=mcp_servers or [],
            )
            return response is not None

        return await self._with_agent(cwd, action)

    async def list_sessions(self, cwd: str | None = None) -> list[str]:
        """session/list — list local archived session ids."""
        if not self._is_acp_native:
            return []
        if not cwd:
            return []

        async def action(client):
            if not self._agent_capability(
                self._initialize_response, "session_capabilities", "list"
            ):
                return []
            response = await client.list_sessions(cwd=cwd)
            return [item.session_id for item in (response.sessions or [])]

        return await self._with_agent(cwd, action)

    async def resume_session(
        self,
        session_id: str,
        cwd: str,
        add_dirs: list[str] | None = None,
        mcp_servers: list | None = None,
    ) -> bool:
        """session/resume — restore a session and replay its history."""
        if not self._is_acp_native:
            return False

        async def action(client):
            if not self._agent_capability(
                self._initialize_response, "session_capabilities", "resume"
            ):
                return False
            self._validate_session_inputs(
                self._initialize_response, add_dirs or [], mcp_servers or []
            )
            response = await client.resume_session(
                session_id=session_id,
                cwd=cwd,
                additional_directories=add_dirs or [],
                mcp_servers=mcp_servers or [],
            )
            return response is not None

        return await self._with_agent(cwd, action)

    async def fork_session(
        self,
        session_id: str,
        cwd: str,
        *,
        fork_point: str | None = None,
        model: str | None = None,
        provider_id: str | None = None,
    ) -> str | None:
        """Create an independent native ACP session fork when advertised."""
        if not self._is_acp_native:
            return None

        async def action(client):
            if not self._agent_capability(
                self._initialize_response, "session_capabilities", "fork"
            ):
                return None
            response = await client.fork_session(
                session_id=session_id,
                cwd=cwd,
                additional_directories=[],
                mcp_servers=[],
            )
            return response.session_id if response is not None else None

        return await self._with_agent(cwd, action)

    async def close_session(self, session_id: str, cwd: str | None = None) -> None:
        """session/close — close a session and release its resources."""
        if not self._is_acp_native:
            return None
        cwd = cwd or self._last_cwd or "."

        async def action(client):
            if not self._agent_capability(
                self._initialize_response, "session_capabilities", "close"
            ):
                return None
            await client.close_session(session_id=session_id)

        await self._with_agent(cwd, action)

    def delete_session_persistence(self, session_id: str, cwd: str) -> None:
        """Delete engine-side durable session storage for a conversation.

        No-op by default: most engines keep no WorkStep-owned store keyed by
        session id. Overridden by engines that do (e.g. Pydantic AI's
        ``harness_runs.db``) so deleting a chat session also reclaims those
        bytes instead of orphaning them on disk.
        """
        return None

    async def cancel_session(self, session_id: str, cwd: str | None = None) -> None:
        """session/cancel — force-stop current reasoning / tool execution."""
        if not self._is_acp_native:
            return None
        cwd = cwd or self._last_cwd or "."

        async def action(client):
            await client.cancel(session_id=session_id)

        await self._with_agent(cwd, action)

    async def set_config_option(
        self,
        config_id: str,
        value: str | bool,
        session_id: str | None = None,
    ) -> None:
        """session/set_config_option — change model / cwd / max turns / permission mode."""
        if not self._is_acp_native:
            return None
        if not session_id:
            logger.warning(
                "ACP set_config_option(%s) requires session_id; ignored", config_id
            )
            return None

        async def action(client):
            await client.set_config_option(
                config_id=config_id,
                session_id=session_id,
                value=value,
            )

        await self._with_agent(self._last_cwd or ".", action)

    async def set_session_mode(
        self,
        mode_id: str,
        session_id: str | None = None,
    ) -> None:
        """Call the ACP session mode compatibility endpoint."""
        if not self._is_acp_native or not session_id:
            return None

        async def action(client):
            await client.set_session_mode(session_id=session_id, mode_id=mode_id)

        await self._with_agent(self._last_cwd or ".", action)

    async def authenticate(self, method_id: str, cwd: str | None = None) -> bool:
        """Run one of the authentication methods returned by initialize."""
        if not self._is_acp_native or not method_id:
            return False

        async def action(client):
            response = await client.authenticate(method_id=method_id)
            return response is not None

        return await self._with_agent(cwd or self._last_cwd or ".", action)

    async def call_acp_extension(
        self,
        method: str,
        params: dict[str, Any],
        cwd: str | None = None,
    ) -> dict[str, Any]:
        """Call an ACP extension method, including draft NES methods."""
        if not self._is_acp_native:
            raise RuntimeError(f"{self.ENGINE_ID}: ACP 扩展不可用")

        async def action(client):
            return await client.ext_method(method, params)

        return await self._with_agent(cwd or self._last_cwd or ".", action)

    async def notify_acp_extension(
        self,
        method: str,
        params: dict[str, Any],
        cwd: str | None = None,
    ) -> None:
        """Send an ACP extension notification without silently discarding it."""
        if not self._is_acp_native:
            raise RuntimeError(f"{self.ENGINE_ID}: ACP 扩展不可用")

        async def action(client):
            await client.ext_notification(method, params)

        await self._with_agent(cwd or self._last_cwd or ".", action)

    async def nes_start(self, params: dict[str, Any], cwd: str | None = None) -> dict[str, Any]:
        return await self.call_acp_extension("nes/start", params, cwd)

    async def nes_suggest(self, params: dict[str, Any], cwd: str | None = None) -> dict[str, Any]:
        return await self.call_acp_extension("nes/suggest", params, cwd)

    async def nes_accept(self, params: dict[str, Any], cwd: str | None = None) -> None:
        await self.notify_acp_extension("nes/accept", params, cwd)

    async def nes_reject(self, params: dict[str, Any], cwd: str | None = None) -> None:
        await self.notify_acp_extension("nes/reject", params, cwd)

    async def nes_close(self, params: dict[str, Any], cwd: str | None = None) -> dict[str, Any]:
        return await self.call_acp_extension("nes/close", params, cwd)

    async def reset_options(self, session_id: str | None = None) -> None:
        """session/reset-options — restore process-global defaults.

        ACP has no native reset primitive; agents start from process-global
        defaults with a fresh session (session/new), so this is a no-op.
        """
        if not self._is_acp_native:
            return None
        logger.info(
            "ACP reset_options: not supported natively (start a new session instead)"
        )
        return None
