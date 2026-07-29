"""CodexAcpEngine — ACP mode for Codex CLI."""

import os
import shutil

from engines.acp_base import AcpEngineBase


class CodexAcpEngine(AcpEngineBase):
    """Codex CLI via ACP protocol.

    Requires: Node.js + @agentclientprotocol/codex-acp npm package.
    """

    ENGINE_ID = "codex_acp"

    @staticmethod
    def is_installed() -> bool:
        return CodexAcpEngine.resolve_binary() is not None

    @staticmethod
    def get_version() -> str | None:
        return "acp-bridge"

    @staticmethod
    def resolve_binary() -> str | None:
        configured = os.environ.get("CODEX_ACP_BIN")
        if configured and os.path.isfile(configured):
            return configured
        return shutil.which("codex-acp")

    def get_command(self) -> list[str]:
        bridge = self.resolve_binary()
        return [bridge] if bridge else []
