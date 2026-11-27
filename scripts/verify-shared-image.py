"""Smoke-test both service commands with an isolated, credential-free Docker HOME."""

import argparse
import json
from pathlib import Path
import re
import subprocess
import tempfile
import time
from uuid import uuid4


def docker(*args, check=True):
    return subprocess.run(["docker", *args], check=check, text=True, capture_output=True)


def verify(image):
    previous_key = None
    with tempfile.TemporaryDirectory(prefix="workstep-image-home-") as home:
        for app in ("main:app", "gateway.app:app", "gateway.app:app"):
            name = "workstep-image-check-" + uuid4().hex[:12]
            try:
                docker(
                    "run", "-d", "--name", name, "--mount", f"type=bind,src={home},dst=/root",
                    "-e", "WORKSTEP_GATEWAY_PUBLIC_ORIGIN=http://localhost:8765",
                    "-e", "WORKSTEP_GATEWAY_GATEWAY_ID=image-smoke-check", image,
                    "python", "-m", "uvicorn", app, "--host", "127.0.0.1", "--port", "8765",
                )
                deadline = time.monotonic() + 90
                while time.monotonic() < deadline:
                    result = docker("exec", name, "curl", "-fsS", "http://127.0.0.1:8765/api/health", check=False)
                    if result.returncode == 0:
                        assert json.loads(result.stdout).get("status") == "ok", result.stdout
                        break
                    if docker("inspect", "--format", "{{.State.Running}}", name).stdout.strip() != "true":
                        logs = docker("logs", name)
                        raise RuntimeError(logs.stdout + logs.stderr)
                    time.sleep(0.5)
                else:
                    raise RuntimeError("Health timeout: " + docker("logs", name).stderr)
                page = docker("exec", name, "curl", "-fsS", "http://127.0.0.1:8765/").stdout
                assert '<div id="root">' in page, "Frontend index missing"
                for asset in re.findall(r'(?:src|href)="(/assets/[^\"]+)"', page):
                    docker("exec", name, "curl", "-fsS", "-o", "/dev/null", "http://127.0.0.1:8765" + asset)
                docker("exec", name, "python", "-c", (
                    "from pathlib import Path; "
                    "assert Path('/app/apps/gateway-web/dist/index.html').is_file(); "
                    "assert Path('/app/apps/web/dist-gateway-share/index.html').is_file(); "
                    "import gateway.app, main"
                ))
                if app == "gateway.app:app":
                    viewer = docker("exec", name, "cat", "/app/apps/web/dist-gateway-share/index.html").stdout
                    for asset in re.findall(r'(?:src|href)="(/workspace-assets/[^\"]+)"', viewer):
                        docker("exec", name, "curl", "-fsS", "-o", "/dev/null", "http://127.0.0.1:8765" + asset)
                    webrtc_cfg = json.loads(
                        docker("exec", name, "curl", "-fsS", "http://127.0.0.1:8765/api/webrtc/config").stdout
                    )
                    assert webrtc_cfg.get("direct_only") is True, webrtc_cfg
                    assert webrtc_cfg.get("stun_urls"), webrtc_cfg
                    p2p_page = docker("exec", name, "curl", "-fsS", "http://127.0.0.1:8765/p2p/smoke-device/").stdout
                    assert "/workspace-assets/" in p2p_page, "P2P workbench assets missing"
                    stun_probe = (
                        "import os, socket, struct; "
                        "tx=os.urandom(12); "
                        "req=struct.pack('!HHI', 0x0001, 0, 0x2112A442)+tx; "
                        "s=socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(2); "
                        "s.sendto(req, ('127.0.0.1', 3478)); resp,_=s.recvfrom(1500); s.close(); "
                        "mt,ml,ck=struct.unpack('!HHI', resp[:8]); "
                        "assert mt==0x0101 and ck==0x2112A442 and resp[8:20]==tx"
                    )
                    docker("exec", name, "python", "-c", stun_probe)
                    database = Path(home) / ".workstep-gateway/workstep_platform.db"
                    assert database.is_file(), "Gateway database missing from mounted HOME"
                    probe = (
                        "import sqlite3; "
                        "db=sqlite3.connect('/root/.workstep-gateway/workstep_platform.db'); "
                    )
                    if previous_key is None:
                        probe += (
                            "db.execute('CREATE TABLE image_smoke_probe (value TEXT)'); "
                            "db.execute(\"INSERT INTO image_smoke_probe VALUES ('persisted')\"); db.commit()"
                        )
                    else:
                        probe += (
                            "assert db.execute('SELECT value FROM image_smoke_probe').fetchone() == ('persisted',)"
                        )
                    docker("exec", name, "python", "-c", probe)
                    current_key = (Path(home) / ".workstep-gateway/gateway-signing-key.pem").read_bytes()
                    if previous_key is not None:
                        assert current_key == previous_key, "Gateway key changed on recreation"
                    previous_key = current_key
                print(f"PASS {app}: health, frontend, shared imports, mounted HOME", flush=True)
            finally:
                docker("rm", "-f", name, check=False)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("image", nargs="?", default="workstep:latest")
    verify(parser.parse_args().image)
