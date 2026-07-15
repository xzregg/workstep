"""QoderAcpEngine — ACP mode for Qoder CLI."""

import shutil

from engines.acp_base import AcpEngineBase


class QoderAcpEngine(AcpEngineBase):
    """Qoder CLI via ACP protocol.

    Requires: qodercli binary with --acp flag.
    """

    ENGINE_ID = "qoder_acp"

    @staticmethod
    def is_installed() -> bool:
        return QoderAcpEngine.resolve_binary() is not None

    @staticmethod
    def get_version() -> str | None:
        binary = QoderAcpEngine.resolve_binary()
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
        return shutil.which("qodercli") or shutil.which("qoder")

    def get_command(self) -> list[str]:
        binary = self.resolve_binary()
        if not binary:
            return []
        return [binary, "--acp"]
