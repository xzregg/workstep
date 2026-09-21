import importlib.util
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location(
    "workstep_generate_release_sbom",
    ROOT / "scripts" / "generate_release_sbom.py",
)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

build_bom = MODULE.build_bom


def test_release_sbom_covers_bundled_python_and_javascript_dependencies():
    bom = build_bom("1.2.3")
    components = {(item["name"], item.get("version")) for item in bom["components"]}

    assert bom["bomFormat"] == "CycloneDX"
    assert bom["metadata"]["component"]["version"] == "1.2.3"
    assert any(name == "fastapi" for name, _version in components)
    assert any(name == "electron" for name, _version in components)
    assert any(name == "electron-updater" for name, _version in components)
    assert any(name == "react" for name, _version in components)
    assert any(name == "@electron/get" for name, _version in components)
    assert all(not version.startswith(("^", "~", ">", "<", "=")) for _name, version in components)
    assert bom["metadata"]["component"]["licenses"] == [{"license": {"id": "Apache-2.0"}}]


def test_release_sbom_is_stably_sorted():
    bom = build_bom("1.2.3")
    identities = [(item["purl"], item["name"]) for item in bom["components"]]

    assert identities == sorted(identities)
