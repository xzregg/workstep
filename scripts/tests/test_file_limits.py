"""Resource limit configuration in an isolated shell (never starts services)."""
import os
from pathlib import Path
import resource
import subprocess

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "file-limits.sh"


@pytest.mark.parametrize("requested,soft,hard,expected", [
    ("", 64, 8192, 4096), ("2048", 64, 8192, 2048),
    ("4096", 64, 128, 128), ("4096", 8192, 8192, 8192),
    ("65536", 64, 65536, 65536),
])
def test_limit_is_raised_clamped_and_never_lowered(requested, soft, hard, expected):
    def limits():
        resource.setrlimit(resource.RLIMIT_NOFILE, (soft, hard))
    result = subprocess.run(["bash", "-c", 'source "$1"; ulimit -Sn', "bash", str(SCRIPT)],
                            env={**os.environ, "WORKSTEP_NOFILE_LIMIT": requested},
                            preexec_fn=limits, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    assert int(result.stdout.splitlines()[-1]) == expected


@pytest.mark.parametrize("requested", ["0", "-1", "abc", "999999999999999999999999"])
def test_invalid_limit_is_rejected(requested):
    result = subprocess.run(["bash", "-c", 'source "$1"', "bash", str(SCRIPT)],
                            env={**os.environ, "WORKSTEP_NOFILE_LIMIT": requested},
                            capture_output=True, text=True)
    assert result.returncode != 0
    assert "WORKSTEP_NOFILE_LIMIT" in result.stderr


def test_macos_packaging_raises_limits_in_the_builder_shell():
    root = SCRIPT.parent.parent
    for workflow in ("desktop-release.yml", "desktop-package-smoke.yml"):
        source = (root / ".github/workflows" / workflow).read_text()
        command = "WORKSTEP_NOFILE_LIMIT=65536 source ../../scripts/file-limits.sh"
        assert command in source
        assert source.index(command) < source.index("--mac dmg")
    local = (root / "apps/desktop/package-local-macos.sh").read_text()
    command = 'WORKSTEP_NOFILE_LIMIT=65536 source "$repo_dir/scripts/file-limits.sh"'
    assert command in local
    assert local.index(command) < local.index("run_yarn dist:mac:local")


def test_macos_builders_patch_descriptor_exhaustion_before_loading_cli():
    import json
    root = SCRIPT.parent.parent
    sources = [(root / ".github/workflows" / name).read_text()
               for name in ("desktop-release.yml", "desktop-package-smoke.yml")]
    sources.append(json.loads((root / "apps/desktop/package.json").read_text())["scripts"]["dist:mac:local"])
    for source in sources:
        assert "gracefulify" in source
        assert source.index("gracefulify") < source.index('require.resolve(\"electron-builder/cli.js\")')


@pytest.mark.parametrize("patched", [False, True])
def test_packaging_fs_queues_real_opens_under_descriptor_pressure(patched):
    root = SCRIPT.parent.parent
    prelude = 'require("graceful-fs").gracefulify(require("fs"));' if patched else ''
    js = prelude + '''
const fs = require("fs"), {promisify} = require("util");
const open = promisify(fs.open), close = promisify(fs.close);
Promise.all(Array.from({length:512}, async () => {
  const fd = await open(process.argv[1], "r");
  await new Promise(setImmediate);
  await close(fd);
})).catch(error => { console.error(error.code); process.exitCode = 1; });
'''
    result = subprocess.run(["node", "-e", js, str(SCRIPT)], cwd=root / "apps/desktop",
                            preexec_fn=lambda: resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128)),
                            capture_output=True, text=True, timeout=30)
    if patched:
        assert result.returncode == 0, result.stderr
    else:
        assert result.returncode != 0
        assert "EMFILE" in result.stderr
