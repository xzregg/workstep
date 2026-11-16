from pathlib import Path

import pytest

from services import manual_location


@pytest.mark.parametrize("layout", ["source", "container"])
def test_default_location_is_relative_to_daemon_not_project(tmp_path, monkeypatch, layout):
    root = tmp_path / layout / "apps"
    daemon = root / "daemon"
    (daemon / "services").mkdir(parents=True)
    directory = root / "landing" / "dist"
    directory.mkdir(parents=True)
    entry = directory / "index.html"
    entry.write_text("<html>操作手册</html>")
    monkeypatch.setattr(manual_location, "__file__", str(daemon / "services/manual_location.py"))
    monkeypatch.setattr(manual_location.settings, "landing_dist", "../landing/dist")
    project = tmp_path / "project"
    project.mkdir()
    monkeypatch.chdir(project)

    assert manual_location.get_manual_location() == {
        "available": True, "directory": str(directory),
        "entry_path": str(entry), "reason": None,
    }


def test_configured_desktop_location_can_contain_spaces(tmp_path, monkeypatch):
    directory = tmp_path / "WorkStep Test.app/Contents/Resources/backend/landing_dist"
    directory.mkdir(parents=True)
    (directory / "index.html").write_text("manual")
    monkeypatch.setattr(manual_location.settings, "landing_dist", str(directory))

    result = manual_location.get_manual_location()

    assert result["available"] is True
    assert result["entry_path"] == str(directory / "index.html")


def test_missing_build_does_not_advertise_a_readable_entry(tmp_path, monkeypatch):
    monkeypatch.setattr(manual_location.settings, "landing_dist", str(tmp_path / "missing"))
    result = manual_location.get_manual_location()
    assert result["available"] is False
    assert result["entry_path"] is None
    assert result["reason"] == "not_found"


def test_directory_named_index_html_is_not_a_manual(tmp_path, monkeypatch):
    (tmp_path / "index.html").mkdir()
    monkeypatch.setattr(manual_location.settings, "landing_dist", str(tmp_path))
    assert manual_location.get_manual_location()["reason"] == "not_found"


def test_unreadable_manual_is_reported_without_reading_the_whole_file(tmp_path, monkeypatch):
    entry = tmp_path / "index.html"
    entry.write_text("manual")
    monkeypatch.setattr(manual_location.settings, "landing_dist", str(tmp_path))
    original = Path.open

    def denied(path, *args, **kwargs):
        if path == entry:
            raise PermissionError("denied")
        return original(path, *args, **kwargs)

    monkeypatch.setattr(Path, "open", denied)
    result = manual_location.get_manual_location()
    assert result["available"] is False
    assert result["entry_path"] is None
    assert result["reason"] == "unreadable"
