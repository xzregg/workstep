"""CodexAcpEngine — ACP mode for Codex CLI."""

import shutil

from engines.acp_base import AcpEngineBase


class CodexAcpEngine(AcpEngineBase):
    """Codex CLI via ACP protocol.

    Requires: Node.js + @agentclientprotocol/codex-acp npm package.
    """

    ENGINE_ID = "codex_acp"

    @staticmethod
    def is_installed() -> bool:
        return shutil.which("node") is not None and shutil.which("codex") is not None

    @staticmethod
    def get_version() -> str | None:
        return "acp-bridge"

    @staticmethod
    def resolve_binary() -> str | None:
        return shutil.which("node")

    def get_command(self) -> list[str]:
        npx = shutil.which("npx")
        if npx:
            return [npx, "@agentclientprotocol/codex-acp"]

        codex = shutil.which("codex")
        if codex:
            return [codex, "--acp"]

        return []
