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
