from __future__ import annotations

import os
from pathlib import Path
import shutil
import stat
import subprocess


REPO_DIR = Path(__file__).resolve().parents[3]
BUILD_SCRIPT = REPO_DIR / "build.sh"
LOCAL_MACOS_PACKAGE_SCRIPT = REPO_DIR / "apps" / "desktop" / "package-local-macos.sh"
PACKAGE_ACTION_SCRIPT = REPO_DIR / "apps" / "desktop" / "package-macos-action.sh"
BACKEND_BUILD_SCRIPTS = (
    REPO_DIR / "apps" / "desktop" / "build-backend.sh",
    REPO_DIR / "apps" / "desktop" / "build-backend.ps1",
)


def _write_executable(path: Path, content: str) -> None:
    path.write_text(content, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)


def _fake_repo(tmp_path: Path, *, include_corepack: bool = True) -> tuple[Path, Path]:
    repo = tmp_path / "repo"
    web_dir = repo / "apps" / "web"
    desktop_dir = repo / "apps" / "desktop"
    bin_dir = tmp_path / "bin"
    (web_dir / "node_modules" / ".bin").mkdir(parents=True)
    desktop_dir.mkdir(parents=True)
    bin_dir.mkdir()

    shutil.copy2(BUILD_SCRIPT, repo / "build.sh")
    _write_executable(
        web_dir / "node_modules" / ".bin" / "vite",
        "#!/usr/bin/env bash\nexit 0\n",
    )
    _write_executable(
        bin_dir / "yarn",
        """#!/usr/bin/env bash
set -euo pipefail
echo "yarn:$*" >> "$BUILD_LOG"
if [[ "${1:-}" == "build" ]]; then
  mkdir -p "$PWD/dist"
  printf '<html>web dist</html>\n' > "$PWD/dist/index.html"
fi
""",
    )
    if include_corepack:
        _write_executable(
            bin_dir / "corepack",
            """#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" != "yarn" ]]; then
  exit 2
fi
shift
exec yarn "$@"
""",
        )
    _write_executable(
        desktop_dir / "build-backend.sh",
        """#!/usr/bin/env bash
set -euo pipefail
test -f "$(cd "$(dirname "${BASH_SOURCE[0]}")/../web" && pwd)/dist/index.html"
echo "backend" >> "$BUILD_LOG"
""",
    )
    return repo, bin_dir


def _run_build(
    repo: Path,
    bin_dir: Path,
    *args: str,
    clean_path: bool = False,
) -> subprocess.CompletedProcess[str]:
    log_path = repo / "build.log"
    env = os.environ.copy()
    env["PATH"] = f"{bin_dir}:/usr/bin:/bin" if clean_path else f"{bin_dir}:{env['PATH']}"
    env["BUILD_LOG"] = str(log_path)
    result = subprocess.run(
        ["bash", str(repo / "build.sh"), *args],
        cwd=repo,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    result.build_log = log_path.read_text(encoding="utf-8") if log_path.exists() else ""
    return result


def test_with_web_builds_dist_before_backend(tmp_path: Path) -> None:
    repo, bin_dir = _fake_repo(tmp_path)

    result = _run_build(repo, bin_dir, "--with-web")

    assert result.returncode == 0, result.stderr
    assert result.build_log == "yarn:build\nbackend\n"


def test_web_builds_only_web_dist(tmp_path: Path) -> None:
    repo, bin_dir = _fake_repo(tmp_path)

    result = _run_build(repo, bin_dir, "web")

    assert result.returncode == 0, result.stderr
    assert result.build_log == "yarn:build\n"


def test_with_web_falls_back_to_yarn_when_corepack_is_unavailable(tmp_path: Path) -> None:
    repo, bin_dir = _fake_repo(tmp_path, include_corepack=False)

    result = _run_build(repo, bin_dir, "--with-web", clean_path=True)

    assert result.returncode == 0, result.stderr
    assert "未找到 Corepack" in result.stdout
    assert result.build_log == "yarn:--version\nyarn:build\nbackend\n"


def test_without_web_reuses_existing_dist(tmp_path: Path) -> None:
    repo, bin_dir = _fake_repo(tmp_path)
    dist_dir = repo / "apps" / "web" / "dist"
    dist_dir.mkdir()
    (dist_dir / "index.html").write_text("<html>existing</html>\n", encoding="utf-8")

    result = _run_build(repo, bin_dir, "--no-web")

    assert result.returncode == 0, result.stderr
    assert result.build_log == "backend\n"


def test_without_web_requires_existing_dist(tmp_path: Path) -> None:
    repo, bin_dir = _fake_repo(tmp_path)

    result = _run_build(repo, bin_dir, "--no-web")

    assert result.returncode != 0
    assert "apps/web/dist/index.html" in result.stderr


def test_unknown_option_is_rejected(tmp_path: Path) -> None:
    repo, bin_dir = _fake_repo(tmp_path)

    result = _run_build(repo, bin_dir, "--unknown")

    assert result.returncode == 2
    assert "Unknown option" in result.stderr


def test_desktop_backend_includes_legal_notices_and_sbom() -> None:
    for script in BACKEND_BUILD_SCRIPTS:
        text = script.read_text(encoding="utf-8")
        assert "LICENSE" in text
        assert "NOTICE" in text
        assert "THIRD_PARTY_NOTICES.md" in text
        assert "generate_release_sbom.py" in text
        assert "--require-hashes" in text
        assert "requirements-bootstrap.txt" in text
        assert "requirements-gateway.txt" in text
        assert "workstep_gateway_protocol" in text
        assert "cli.py" in text


def test_sbom_generation_uses_the_bundled_python_runtime() -> None:
    shell = BACKEND_BUILD_SCRIPTS[0].read_text(encoding="utf-8")
    powershell = BACKEND_BUILD_SCRIPTS[1].read_text(encoding="utf-8")

    assert '"$python_bin" "$repo_dir/scripts/generate_release_sbom.py"' in shell
    assert '& $Python (Join-Path $RepoDir "scripts/generate_release_sbom.py")' in powershell


def test_sandbox_web_build_uses_github_reachable_npm_registry() -> None:
    dockerfile = (REPO_DIR / "Dockerfile").read_text(encoding="utf-8")
    web_build = dockerfile.split("# Git 2.48+", maxsplit=1)[0]

    assert "FROM node:24-bookworm AS web-build" in web_build
    assert web_build.count("--network-timeout 600000 --network-concurrency 4") == 3
    # 本地构建保留镜像默认值，GitHub 发布显式选择其可达的官方仓库。
    workflow = (REPO_DIR / ".github/workflows/desktop-release.yml").read_text(encoding="utf-8")
    assert "ARG NPM_REGISTRY=" in web_build
    assert "--build-arg NPM_REGISTRY=https://registry.npmjs.org" in workflow
    assert 'yarn config set registry "$NPM_REGISTRY"' in web_build
    assert web_build.count('${NPM_REGISTRY%/}/#g') == 6


def test_local_macos_package_script_rebuilds_version_icons_and_runtime() -> None:
    script = LOCAL_MACOS_PACKAGE_SCRIPT.read_text(encoding="utf-8")
    package = (REPO_DIR / "apps" / "desktop" / "package.json").read_text(encoding="utf-8")

    import json
    import tomllib
    version = json.loads(package)["version"]
    daemon = tomllib.loads((REPO_DIR / "apps" / "daemon" / "pyproject.toml").read_text(encoding="utf-8"))
    assert daemon["project"]["version"] == version
    assert 'npm version "$version" --no-git-tag-version --allow-same-version' in script
    assert 'run_yarn icons' in script
    assert 'WORKSTEP_BUILD_VERSION="$version" "$repo_dir/build.sh" --with-web' in script
    assert 'BUILD_PLATFORM=mac "$desktop_dir/inject-backend.sh"' in script
    assert 'run_yarn dist:mac:local \\\n' in script
    assert r'--config.mac.artifactName="WorkStep-${version}-macos-\${arch}.\${ext}"' in script
    assert '--config.electronFuses.enableCookieEncryption=false' in script
    assert 'codesign --verify --deep --strict' in script
    assert 'rm -rf "$desktop_dir/dist/mac-arm64"' in script
    assert 'shasum -a 256' in script
    assert 'find "$desktop_dir/dist"' in script
    assert "-name 'WorkStep-*-macos-arm64.zip'" in script
    assert '"$desktop_dir/dist/WorkStep-$version-macos-arm64.dmg"' in script

    assert 'electron-builder --mac dmg --arm64' in package
    assert 'electron-builder --mac dmg zip --arm64' not in package
    assert '"artifactName": "WorkStep-macos-${arch}.${ext}"' in package


def test_package_action_uses_current_version_when_input_is_empty() -> None:
    script = PACKAGE_ACTION_SCRIPT.read_text(encoding="utf-8")

    assert 'if [[ -n "$version" ]]' in script
    assert 'exec ./apps/desktop/package-local-macos.sh "$version"' in script
    assert 'exec ./apps/desktop/package-local-macos.sh\n' in script
    assert "请输入桌面版本号" not in script
