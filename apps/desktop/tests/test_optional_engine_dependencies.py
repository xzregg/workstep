import json
from pathlib import Path


DESKTOP_DIR = Path(__file__).resolve().parents[1]


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
