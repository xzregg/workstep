"""Tests for the standalone apps/webrtc-signal service entrypoint."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

from fastapi.testclient import TestClient


def _load_signal_app_module():
    module_path = Path(__file__).resolve().parents[1] / "main.py"
    spec = importlib.util.spec_from_file_location("webrtc_signal_main", module_path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_standalone_signal_app_serves_health_stun_and_p2p_shell(tmp_path):
    web_dist = tmp_path / "web_dist"
    assets_dir = web_dist / "assets"
    assets_dir.mkdir(parents=True)
    (web_dist / "index.html").write_text("<html><body>WorkStep P2P</body></html>", encoding="utf-8")
    (assets_dir / "app.js").write_text("console.log('p2p');", encoding="utf-8")

    mod = _load_signal_app_module()
    app = mod.create_app(
        mod.SignalSettings(
            stun_host="127.0.0.1",
            stun_port=0,
            public_host="127.0.0.1",
            web_dist=web_dist,
        )
    )

    with TestClient(app) as client:
        health = client.get("/api/health")
        assert health.status_code == 200
        body = health.json()
        assert body["status"] == "ok"
        assert body["stun_port"] > 0

        cfg = client.get("/api/webrtc/config", params={"device_id": "missing-dev"})
        assert cfg.status_code == 200
        assert cfg.json()["online"] is False
        assert cfg.json()["stun_urls"] == [f"stun:127.0.0.1:{body['stun_port']}"]

        shell = client.get("/p2p/dev-123/tasks")
        assert shell.status_code == 200
        assert "WorkStep P2P" in shell.text

        asset = client.get("/assets/app.js")
        assert asset.status_code == 200
        assert "console.log('p2p')" in asset.text

        p2p_asset = client.get("/p2p/dev-123/assets/app.js")
        assert p2p_asset.status_code == 200
        assert "console.log('p2p')" in p2p_asset.text
