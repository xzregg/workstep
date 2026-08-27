from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from desktop_main import local_path_for_protocol_url, parse_workstep_url


def test_open_protocol_targets_local_home():
    parsed = parse_workstep_url("workstep://open")

    assert parsed.action == "open"
    assert local_path_for_protocol_url("workstep://open") == "/"


def test_remote_project_protocol_is_forwarded_to_local_web_app():
    value = "workstep://remote-project/v1/example-token"

    assert parse_workstep_url(value).action == "remote-project"
    assert local_path_for_protocol_url(value).startswith("/?workstep_url=")


def test_unknown_or_web_urls_are_rejected():
    for value in ("https://example.com", "workstep://unknown"):
        try:
            parse_workstep_url(value)
        except ValueError:
            pass
        else:
            raise AssertionError(f"expected {value!r} to be rejected")
