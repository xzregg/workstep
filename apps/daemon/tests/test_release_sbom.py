from pathlib import Path
import sys


sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from scripts.generate_release_sbom import build_bom  # noqa: E402


def test_release_sbom_covers_bundled_python_and_javascript_dependencies():
    bom = build_bom("1.2.3")
    components = {(item["name"], item.get("version")) for item in bom["components"]}

    assert bom["bomFormat"] == "CycloneDX"
    assert bom["metadata"]["component"]["version"] == "1.2.3"
    assert any(name == "fastapi" for name, _version in components)
    assert any(name == "electron" for name, _version in components)
    assert any(name == "electron-updater" for name, _version in components)
    assert any(name == "react" for name, _version in components)


def test_release_sbom_is_stably_sorted():
    bom = build_bom("1.2.3")
    identities = [(item["purl"], item["name"]) for item in bom["components"]]

    assert identities == sorted(identities)
