"""The unsupported personal-WeChat channel is no longer exposed."""

from main import app


def test_legacy_wechat_channel_endpoints_are_absent():
    routes = {
        route.path
        for route in app.routes
        if hasattr(route, "path")
    }
    assert "/api/channels" not in routes
    assert not any(path.startswith("/api/channels/") for path in routes)
