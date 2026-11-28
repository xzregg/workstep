"""Tests for the standalone apps/webrtc-signal service entrypoint."""

from __future__ import annotations

import importlib.util
import asyncio
import time
import sys
from pathlib import Path

from fastapi.testclient import TestClient
import pytest
from httpx import ASGITransport, AsyncClient


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
    bootstrap=web_dist/'rtc-bootstrap'
    bootstrap.mkdir()
    (bootstrap/'index.html').write_text('<html><script src="/p2p-bootstrap/bootstrap.js"></script></html>')
    (bootstrap/'bootstrap.js').write_text('/* connection only */')
    (bootstrap/'worker.js').write_text('/* resource worker */')

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
        assert '/p2p-bootstrap/bootstrap.js' in shell.text
        assert 'WorkStep P2P' not in shell.text

        asset = client.get("/assets/app.js")
        assert asset.status_code == 404

        p2p_asset = client.get("/p2p/dev-123/assets/app.js")
        assert p2p_asset.status_code == 404
        assert client.get('/p2p-bootstrap/bootstrap.js').text=='/* connection only */'
        assert client.get('/p2p/rtc-worker.js').text=='/* resource worker */'


@pytest.mark.asyncio
async def test_slow_bootstrap_disk_probe_does_not_block_health(tmp_path,monkeypatch):
    directory=tmp_path/'rtc-bootstrap';directory.mkdir()
    target=directory/'index.html';target.write_text('<html>Connect</html>')
    module=_load_signal_app_module()
    app=module.create_app(module.SignalSettings(web_dist=tmp_path))
    original=Path.is_file
    entered=asyncio.Event();loop=asyncio.get_running_loop()
    def slow(path):
        if path==target:
            loop.call_soon_threadsafe(entered.set);time.sleep(.2)
        return original(path)
    monkeypatch.setattr(Path,'is_file',slow)
    async with AsyncClient(transport=ASGITransport(app=app),base_url='http://signal.test') as client:
        pending=asyncio.create_task(client.get('/p2p/device/'))
        await asyncio.wait_for(entered.wait(),1)
        assert (await asyncio.wait_for(client.get('/api/health'),.1)).status_code==200
        assert (await pending).status_code==200
