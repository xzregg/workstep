from fastapi.testclient import TestClient
from gateway.app import create_app
from gateway.config import GatewaySettings


def test_public_share_serves_the_existing_workstep_viewer_and_separate_assets(tmp_path):
    portal = tmp_path / 'portal'; portal.mkdir()
    (portal / 'index.html').write_text('<main>Gateway Portal</main>')
    viewer = tmp_path / 'workstep'; viewer.mkdir()
    (viewer / 'index.html').write_text('<html><head><script src="/workspace-assets/viewer.js"></script></head><body>WorkStep</body></html>')
    (viewer / 'viewer.js').write_text('/* WorkStep viewer */')
    app = create_app(GatewaySettings(data_dir=tmp_path / 'data', web_dist=portal, workspace_web_dist=viewer))
    with TestClient(app) as client:
        assert 'Gateway Portal' in client.get('/auth').text
        response = client.get('/share/public-handle')
        assert response.status_code == 200
        assert 'workstep-share-transport' in response.text
        assert '/workspace-assets/viewer.js' in response.text
        assert 'Gateway Portal' not in response.text
        assert client.get('/workspace-assets/viewer.js').text == '/* WorkStep viewer */'
        assert client.get('/workspace-assets/../index.html').status_code == 404
        assert client.get('/api/public/shares/public-handle/task').status_code == 404


def test_missing_viewer_build_returns_actionable_unavailable(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app) as client:
        assert client.get('/share/public-handle').status_code == 503


def test_slow_viewer_index_read_keeps_health_responsive(tmp_path, monkeypatch):
    import threading
    import time
    from pathlib import Path
    viewer = tmp_path / 'viewer'; viewer.mkdir()
    index = viewer / 'index.html'; index.write_text('<html><head></head></html>')
    app = create_app(GatewaySettings(data_dir=tmp_path / 'data', workspace_web_dist=viewer))
    entered = threading.Event(); release = threading.Event(); original = Path.read_text
    def slow_read(path, *args, **kwargs):
        if path == index:
            entered.set(); assert release.wait(3)
        return original(path, *args, **kwargs)
    monkeypatch.setattr(Path, 'read_text', slow_read)
    with TestClient(app) as client:
        results = []
        worker = threading.Thread(target=lambda: results.append(client.get('/share/token')))
        worker.start()
        try:
            assert entered.wait(2)
            started = time.monotonic()
            assert client.get('/api/health').status_code == 200
            assert time.monotonic() - started < .5
        finally: release.set(); worker.join(3)
        assert results[0].status_code == 200
