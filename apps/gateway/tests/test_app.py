from fastapi.testclient import TestClient

from gateway.app import create_app
from gateway.config import GatewaySettings


def test_health_and_lifespan(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app) as client:
        assert app.state.ready is True
        assert client.get("/api/health").json() == {"status": "ok"}
    assert app.state.ready is False


def test_errors_have_one_shape(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app) as client:
        response = client.get("/api/does-not-exist")
    assert response.status_code == 404
    assert response.json() == {"error": {"code": "not_found", "message": "Not Found"}}


def test_validation_errors_have_one_shape(tmp_path):
    from fastapi import FastAPI, Query

    app = create_app(GatewaySettings(data_dir=tmp_path))

    @app.get("/api/check")
    async def check(count: int = Query(ge=1)) -> dict[str, int]:
        return {"count": count}

    with TestClient(app) as client:
        response = client.get("/api/check?count=0")
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"


def test_invalid_configuration_fails_before_serving(tmp_path):
    from pydantic import ValidationError
    import pytest

    with pytest.raises(ValidationError):
        GatewaySettings(data_dir=tmp_path, port=0)


def test_gateway_can_host_portal_routes(tmp_path):
    web_dist = tmp_path / "dist"
    web_dist.mkdir()
    (web_dist / "index.html").write_text("<html>Gateway portal</html>")
    app = create_app(GatewaySettings(data_dir=tmp_path, web_dist=web_dist))
    with TestClient(app) as client:
        assert "Gateway portal" in client.get("/").text
        assert "Gateway portal" in client.get("/admin").text
        assert client.get("/api/unknown").json()["error"]["code"] == "not_found"
