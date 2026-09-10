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
