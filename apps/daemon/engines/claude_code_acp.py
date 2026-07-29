"""ClaudeCodeAcpEngine — ACP mode via Claude Agent SDK bridge."""

import os
import shutil

from engines.acp_base import AcpEngineBase


class ClaudeCodeAcpEngine(AcpEngineBase):
    """Claude Code via ACP protocol.

    Requires: Node.js + @agentclientprotocol/claude-agent-acp npm package.
    """

    ENGINE_ID = "claude_acp"

    @staticmethod
    def is_installed() -> bool:
        return ClaudeCodeAcpEngine.resolve_binary() is not None

    @staticmethod
    def get_version() -> str | None:
        return "acp-bridge"

    @staticmethod
    def resolve_binary() -> str | None:
        configured = os.environ.get("CLAUDE_ACP_BIN")
        if configured and os.path.isfile(configured):
            return configured
        return shutil.which("claude-agent-acp")

    def get_command(self) -> list[str]:
        """Resolve the ACP bridge command.

        Looks for the npm bridge entrypoint in common locations.
        """
        bridge = self.resolve_binary()
        return [bridge] if bridge else []
