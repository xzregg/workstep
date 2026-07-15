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
        # Need node + the npm bridge package
        if not shutil.which("node"):
            return False
        # Check if the bridge is available
        return shutil.which("claude") is not None

    @staticmethod
    def get_version() -> str | None:
        return "acp-bridge"

    @staticmethod
    def resolve_binary() -> str | None:
        return shutil.which("node")

    def get_command(self) -> list[str]:
        """Resolve the ACP bridge command.

        Looks for the npm bridge entrypoint in common locations.
        """
        node = shutil.which("node")
        if not node:
            return []

        # Try common bridge locations
        import subprocess
        # Use npx to find and run the bridge
        npx = shutil.which("npx")
        if npx:
            return [npx, "@agentclientprotocol/claude-agent-acp"]

        # Fallback: try running claude with --acp flag
        claude = shutil.which("claude") or os.environ.get("CLAUDE_BIN")
        if claude:
            return [claude, "--acp"]

        return []
