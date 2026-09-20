from pathlib import Path
import sys


sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from scripts.check_secrets import matching_kinds  # noqa: E402


def test_high_confidence_secret_patterns_are_detected():
    assert matching_kinds("token=" + "AK" + "IA" + "A" * 16) == ["AWS access key"]
    assert matching_kinds("github" + "_pat_" + "a" * 40) == ["GitHub token"]
    assert matching_kinds("sk" + "-proj-" + "a" * 30) == ["OpenAI key"]
    assert matching_kinds("-----BEGIN " + "PRIVATE KEY-----") == ["private key"]


def test_source_like_words_do_not_trigger_secret_scan():
    assert matching_kinds("task-stage-progress") == []
    assert matching_kinds("api_key = provider.get('api_key')") == []
    assert matching_kinds("${{ secrets.MAC_CSC_LINK }}") == []
