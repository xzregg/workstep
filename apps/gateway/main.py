"""Gateway entry point, matching daemon's `uvicorn main:app` convention."""

from gateway.app import app, create_app

__all__ = ["app", "create_app"]
