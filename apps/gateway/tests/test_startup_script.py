import os
import shutil
import subprocess
from pathlib import Path

import pytest


@pytest.mark.parametrize("mode,reload", [("prod", False), ("dev", True)])
def test_startup_script_builds_portal_and_launches_daemon_entrypoint(tmp_path, mode, reload):
    shutil.copy(Path(__file__).resolve().parents[3] / "start-gateway.sh", tmp_path)
    for directory in ("apps/gateway/.venv", "apps/gateway-web/node_modules", "apps/web/node_modules", "bin"):
        (tmp_path / directory).mkdir(parents=True)
    for command in ("uv", "yarn"):
        stub = tmp_path / "bin" / command
        stub.write_text('#!/bin/bash\nprintf "%s\\n" "' + command + ' $*" >> "$STARTUP_LOG"\n')
        stub.chmod(0o755)
    log = tmp_path / "commands.log"
    env = {**os.environ, "PATH": str(tmp_path / "bin") + ":" + os.environ["PATH"], "STARTUP_LOG": str(log)}
    result = subprocess.run(["/bin/bash", str(tmp_path / "start-gateway.sh"), "8700", mode], env=env, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    assert "http://localhost:8700" in result.stdout
    commands = log.read_text().splitlines()
    assert commands[:2] == ["yarn build", "yarn build:gateway-share"]
    assert commands[2] == "uv run --no-sync uvicorn main:app --host 127.0.0.1 --port 8700" + (" --reload" if reload else "")
