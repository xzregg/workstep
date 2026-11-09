import importlib
import os
import sys

from services.engine_packages import managed_package_version, prepare_engine_package_dir


def test_engine_packages_live_outside_uv_environment(tmp_path, monkeypatch):
    monkeypatch.setenv("WORKSTEP_CONFIG_DIR", str(tmp_path))
    monkeypatch.delenv("WORKSTEP_ENGINE_PACKAGE_DIR", raising=False)
    original_dir = os.environ.get("WORKSTEP_ENGINE_PACKAGE_DIR")
    original_path = list(sys.path)
    try:
        package_dir = prepare_engine_package_dir()
        assert package_dir == tmp_path / "runtime" / "python-packages"
        assert package_dir.is_dir()
        assert os.environ["WORKSTEP_ENGINE_PACKAGE_DIR"] == str(package_dir)
        assert sys.path[-1] == str(package_dir)
    finally:
        sys.path[:] = original_path
        if original_dir is None:
            os.environ.pop("WORKSTEP_ENGINE_PACKAGE_DIR", None)
        else:
            os.environ["WORKSTEP_ENGINE_PACKAGE_DIR"] = original_dir


def test_engine_packages_respect_explicit_directory(tmp_path, monkeypatch):
    package_dir = tmp_path / "custom"
    monkeypatch.setenv("WORKSTEP_ENGINE_PACKAGE_DIR", str(package_dir))
    original_path = list(sys.path)
    try:
        assert prepare_engine_package_dir() == package_dir
        assert sys.path.count(str(package_dir)) == 1
        assert prepare_engine_package_dir() == package_dir
        assert sys.path.count(str(package_dir)) == 1
    finally:
        sys.path[:] = original_path


def test_managed_engine_package_overrides_bundled_engine_only(tmp_path, monkeypatch):
    bundled = tmp_path / "bundled"
    managed = tmp_path / "managed"
    (bundled / "openai_codex").mkdir(parents=True)
    (managed / "openai_codex").mkdir(parents=True)
    (bundled / "openai_codex" / "__init__.py").write_text("SOURCE = 'bundled'\n")
    (managed / "openai_codex" / "__init__.py").write_text("SOURCE = 'managed'\n")
    (bundled / "shared_dependency.py").write_text("SOURCE = 'bundled'\n")
    (managed / "shared_dependency.py").write_text("SOURCE = 'managed'\n")
    monkeypatch.setenv("WORKSTEP_ENGINE_PACKAGE_DIR", str(managed))
    original_path = list(sys.path)
    original_meta_path = list(sys.meta_path)
    sys.path.insert(0, str(bundled))
    try:
        prepare_engine_package_dir()
        sys.modules.pop("openai_codex", None)
        sys.modules.pop("shared_dependency", None)
        assert importlib.import_module("openai_codex").SOURCE == "managed"
        assert importlib.import_module("shared_dependency").SOURCE == "bundled"
    finally:
        sys.modules.pop("openai_codex", None)
        sys.modules.pop("shared_dependency", None)
        sys.path[:] = original_path
        sys.meta_path[:] = original_meta_path


def test_managed_package_version_precedes_bundled_metadata(tmp_path, monkeypatch):
    package_dir = tmp_path / "managed"
    metadata = package_dir / "openai_codex-0.167.0.dist-info"
    metadata.mkdir(parents=True)
    (metadata / "METADATA").write_text(
        "Metadata-Version: 2.1\nName: openai-codex\nVersion: 0.167.0\n"
    )
    monkeypatch.setenv("WORKSTEP_ENGINE_PACKAGE_DIR", str(package_dir))
    assert managed_package_version("openai-codex") == "0.167.0"
