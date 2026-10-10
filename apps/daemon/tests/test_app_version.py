import json
from pathlib import Path

from version import normalize_version


def test_release_version_normalizes_tag_prefix():
    assert normalize_version("v1.2.3") == "1.2.3"
    assert normalize_version("1.2.3-rc.1") == "1.2.3-rc.1"


def test_empty_release_version_uses_shared_application_version():
    version = json.loads((Path(__file__).parents[2] / 'desktop/package.json').read_text())["version"]
    assert normalize_version("") == version
    assert normalize_version(None) == version
