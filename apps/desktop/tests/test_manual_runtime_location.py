import importlib.util
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest


SERVER_PATH = Path(__file__).resolve().parents[1] / "backend/server.py"
spec = importlib.util.spec_from_file_location("manual_runtime_server", SERVER_PATH)
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


@pytest.mark.parametrize("configured", [None, "custom-website"])
def test_desktop_initializes_manual_location_without_starting_server(tmp_path, monkeypatch, configured):
    bundle = tmp_path / "WorkStep Test.app/Contents/Resources/backend"
    daemon = bundle / "app/daemon"
    daemon.mkdir(parents=True)
    monkeypatch.setattr(server, "_bundle_dir", lambda: bundle)
    monkeypatch.setattr(server, "_daemon_dir", lambda: daemon)
    monkeypatch.setattr(server, "prepare_cli_environment", lambda *args: None)
    monkeypatch.setattr(sys, "path", list(sys.path))
    monkeypatch.chdir(tmp_path)
    for key in ("WORKSTEP_HOST", "WORKSTEP_PORT", "WORKSTEP_WEB_DIST", "WORKSTEP_LANDING_DIST"):
        monkeypatch.delenv(key, raising=False)
    if configured:
        monkeypatch.setenv("WORKSTEP_LANDING_DIST", configured)
    app = object()
    monkeypatch.setitem(sys.modules, "main", SimpleNamespace(app=app))

    assert server._load_app("127.0.0.1", 8766) is app
    assert server.os.environ["WORKSTEP_LANDING_DIST"] == (configured or str(bundle / "landing_dist"))
