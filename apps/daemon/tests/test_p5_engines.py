"""Tests for P5 engines (QCode, OpenClaw, API)."""

import pytest

from engines.api import APIEngine
from engines.qcode import QCodeEngine
from engines.openclaw import OpenClawEngine
from engines.events import InternalEvent


class TestQCodeEngine:
    """Tests for QCodeEngine."""

    def test_is_installed(self):
        """Test is_installed returns boolean."""
        assert isinstance(QCodeEngine.is_installed(), bool)

    def test_get_version(self):
        """Test get_version returns string or None."""
        version = QCodeEngine.get_version()
        assert version is None or isinstance(version, str)

    def test_resolve_binary(self):
        """Test resolve_binary returns path or None."""
        binary = QCodeEngine.resolve_binary()
        assert binary is None or isinstance(binary, str)

    def test_supports_resume(self):
        """Test QCode does not support resume."""
        engine = QCodeEngine()
        assert engine.supports_resume is False

    def test_supports_interactive(self):
        """Test QCode does not support interactive."""
        engine = QCodeEngine()
        assert engine.supports_interactive is False

    def test_build_resume_params(self):
        """Test build_resume_params returns dict."""
        engine = QCodeEngine()
        params = engine.build_resume_params("test-session")
        assert isinstance(params, dict)


class TestOpenClawEngine:
    """Tests for OpenClawEngine."""

    def test_is_installed(self):
        """Test is_installed returns boolean."""
        assert isinstance(OpenClawEngine.is_installed(), bool)

    def test_get_version(self):
        """Test get_version returns string or None."""
        version = OpenClawEngine.get_version()
        assert version is None or isinstance(version, str)

    def test_resolve_binary(self):
        """Test resolve_binary returns path or None."""
        binary = OpenClawEngine.resolve_binary()
        assert binary is None or isinstance(binary, str)

    def test_supports_resume(self):
        """Test OpenClaw does not support resume."""
        engine = OpenClawEngine()
        assert engine.supports_resume is False

    def test_supports_interactive(self):
        """Test OpenClaw does not support interactive."""
        engine = OpenClawEngine()
        assert engine.supports_interactive is False

    def test_build_resume_params(self):
        """Test build_resume_params returns dict."""
        engine = OpenClawEngine()
        params = engine.build_resume_params("test-session")
        assert isinstance(params, dict)


class TestAPIEngine:
    """Tests for APIEngine."""

    def test_is_installed(self, monkeypatch):
        """API mode is available only when credentials are configured."""
        monkeypatch.delenv("API_KEY", raising=False)
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        assert APIEngine.is_installed() is False
        monkeypatch.setenv("OPENAI_API_KEY", "configured")
        assert APIEngine.is_installed() is True

    def test_get_version(self):
        """Test get_version returns version string."""
        version = APIEngine.get_version()
        assert isinstance(version, str)
        assert version == "1.0.0"

    def test_resolve_binary(self):
        """Test resolve_binary returns identifier."""
        binary = APIEngine.resolve_binary()
        assert binary == "api-engine"

    def test_supports_resume(self):
        """Test API engine does not support resume."""
        engine = APIEngine()
        assert engine.supports_resume is False

    def test_supports_interactive(self):
        """Test API engine does not support interactive."""
        engine = APIEngine()
        assert engine.supports_interactive is False

    def test_build_resume_params(self):
        """Test build_resume_params returns dict."""
        engine = APIEngine()
        params = engine.build_resume_params("test-session")
        assert isinstance(params, dict)

    def test_internal_event_creation(self):
        """Test InternalEvent creation works."""
        event = InternalEvent(
            type="text_delta",
            data={"delta": "test"},
        )
        assert event.type == "text_delta"
        assert event.data["delta"] == "test"
        assert event.to_dict()["type"] == "text_delta"
