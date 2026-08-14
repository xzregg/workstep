import json
import os
from pathlib import Path
import subprocess
import sys


DAEMON_DIR = Path(__file__).resolve().parents[1]


def _config_paths(env: dict[str, str]) -> dict[str, str]:
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            (
                "import json; "
                "from services.config import CONFIG_DIR, CONFIG_FILE; "
                "print(json.dumps({'dir': str(CONFIG_DIR), 'file': str(CONFIG_FILE)}))"
            ),
        ],
        cwd=DAEMON_DIR,
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)


def test_workstep_config_dir_selects_the_startup_config_location(tmp_path):
    config_dir = tmp_path / "second-device"
    env = os.environ.copy()
    env["WORKSTEP_CONFIG_DIR"] = str(config_dir)

    assert _config_paths(env) == {
        "dir": str(config_dir),
        "file": str(config_dir / "config.json"),
    }


def test_config_directory_defaults_to_dot_workstep_in_the_user_home():
    env = os.environ.copy()
    env.pop("WORKSTEP_CONFIG_DIR", None)

    assert _config_paths(env) == {
        "dir": str(Path.home() / ".workstep"),
        "file": str(Path.home() / ".workstep" / "config.json"),
    }
