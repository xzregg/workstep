from version import normalize_version


def test_release_version_normalizes_tag_prefix():
    assert normalize_version("v1.2.3") == "1.2.3"
    assert normalize_version("1.2.3-rc.1") == "1.2.3-rc.1"


def test_empty_release_version_uses_development_fallback():
    assert normalize_version("") == "0.1.0"
