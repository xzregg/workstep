"""Lock Gateway additions without changing daemon's shared dependency versions."""

from pathlib import Path
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "scripts/container-gateway-requirements.txt"


def main():
    with tempfile.TemporaryDirectory(prefix="workstep-container-lock-") as temporary:
        constraints = Path(temporary) / "daemon.txt"
        subprocess.run([
            "uv", "export", "--project", "apps/daemon", "--frozen", "--no-dev",
            "--no-emit-local", "--no-hashes", "--no-header", "-o", str(constraints),
        ], cwd=ROOT, check=True, stdout=subprocess.DEVNULL)
        subprocess.run([
            "uv", "pip", "compile", "apps/gateway/pyproject.toml", "-c", str(constraints),
            "--python-version", "3.14", "--python-platform", "linux",
            "--no-emit-package", "workstep-gateway-protocol", "--no-annotate", "--no-header",
            "-o", str(OUTPUT),
        ], cwd=ROOT, check=True, stdout=subprocess.DEVNULL)
    OUTPUT.write_text(
        "# Gateway dependencies compatible with apps/daemon/uv.lock (Python 3.14, Linux).\n"
        "# Regenerate: python3 scripts/lock-container-gateway.py\n" + OUTPUT.read_text(),
    )


if __name__ == "__main__":
    main()
