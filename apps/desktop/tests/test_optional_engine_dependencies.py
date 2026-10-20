import json
from pathlib import Path
import subprocess


DESKTOP_DIR = Path(__file__).resolve().parents[1]


def test_desktop_base_requirements_match_frozen_daemon_export(tmp_path):
    exported = tmp_path / "requirements.txt"
    subprocess.run([
        "uv", "export", "--project", "apps/daemon", "--frozen", "--no-dev",
        "--no-emit-project", "--no-emit-local", "--no-emit-package", "openai-codex",
        "--no-emit-package", "openai-codex-cli-bin", "--no-emit-package", "claude-agent-sdk",
        "--no-header", "--quiet", "--output-file", str(exported),
    ], cwd=DESKTOP_DIR.parents[1], check=True, timeout=30)
    # Ignore only the generated command header; compare every package/hash/marker.
    current = (DESKTOP_DIR / "backend/requirements-prod.txt").read_text().splitlines()[2:]
    assert current == exported.read_text().splitlines(), "Regenerate desktop requirements from the daemon lock"


def test_desktop_base_requirements_exclude_click_installed_sdk_engines():
    requirements = (DESKTOP_DIR / "backend" / "requirements-prod.txt").read_text()

    for package in (
        "claude-agent-sdk==",
        "openai-codex==",
        "openai-codex-cli-bin==",
    ):
        assert package not in requirements


def test_desktop_build_does_not_freeze_optional_engine_sdks():
    for script_name in ("build-backend.sh", "build-backend.ps1"):
        script = (DESKTOP_DIR / script_name).read_text()
        assert "Nuitka" not in script
        assert "--include-package=openai_codex" not in script
        assert "--include-package=claude_agent_sdk" not in script


def test_desktop_python_install_requirements_are_hash_locked():
    for requirements_name in ("requirements-prod.txt", "requirements-bootstrap.txt"):
        requirements = (DESKTOP_DIR / "backend" / requirements_name).read_text()
        package_lines = [
            line for line in requirements.splitlines()
            if line and not line.startswith((" ", "#"))
        ]
        assert package_lines
        assert all(line.endswith("\\") for line in package_lines)
        assert "--hash=sha256:" in requirements


def test_desktop_package_enables_restrictive_electron_fuses():
    package = json.loads((DESKTOP_DIR / "package.json").read_text())
    fuses = package["build"]["electronFuses"]

    assert fuses["runAsNode"] is False
    assert fuses["enableNodeOptionsEnvironmentVariable"] is False
    assert fuses["enableNodeCliInspectArguments"] is False
    assert fuses["enableEmbeddedAsarIntegrityValidation"] is True
    assert fuses["onlyLoadAppFromAsar"] is True
    assert fuses["grantFileProtocolExtraPrivileges"] is False


def test_desktop_package_uses_branded_icons_for_every_platform():
    package = json.loads((DESKTOP_DIR / "package.json").read_text())
    build = package["build"]

    assert build["mac"]["icon"] == "build/icon.icns"
    assert build["win"]["icon"] == "build/icon.ico"
    assert build["linux"]["icon"] == "build/icons"
    assert (DESKTOP_DIR / "build" / "icon.icns").is_file()
    assert (DESKTOP_DIR / "build" / "icon.ico").is_file()
    assert (DESKTOP_DIR / "build" / "icons" / "512x512.png").is_file()
