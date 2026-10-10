import json
import os
from pathlib import Path
import subprocess
import sys

DAEMON_DIR = Path(__file__).resolve().parents[1]


def runtime_version(override=None):
    env = dict(os.environ)
    env.pop("WORKSTEP_VERSION", None)
    if override is not None:
        env["WORKSTEP_VERSION"] = override
    return subprocess.check_output(
        [sys.executable, "-c", "from version import APP_VERSION; print(APP_VERSION)"],
        cwd=DAEMON_DIR, env=env, text=True,
    ).strip()


def test_source_launch_uses_repository_app_version():
    expected = json.loads((DAEMON_DIR.parent / "desktop/package.json").read_text())["version"]
    assert runtime_version() == expected
    assert runtime_version("  ") == expected


def test_packaged_launcher_version_takes_precedence():
    assert runtime_version("v2.3.4") == "2.3.4"


def test_daemon_package_version_matches_app():
    import tomllib
    expected = json.loads((DAEMON_DIR.parent / "desktop/package.json").read_text())["version"]
    assert tomllib.loads((DAEMON_DIR / "pyproject.toml").read_text())["project"]["version"] == expected
    lock = tomllib.loads((DAEMON_DIR / "uv.lock").read_text())
    assert next(p for p in lock["package"] if p["name"] == "workstep-daemon")["version"] == expected


def test_packaged_daemon_reads_bundled_version(tmp_path):
    import shutil
    shutil.copy(DAEMON_DIR / "version.py", tmp_path / "version.py")
    (tmp_path / "app-version.json").write_text('{"version": "3.4.5"}')
    env = dict(os.environ)
    env.pop("WORKSTEP_VERSION", None)
    result = subprocess.check_output([sys.executable, "-c", "from version import APP_VERSION; print(APP_VERSION)"], cwd=tmp_path, env=env, text=True)
    assert result.strip() == "3.4.5"
