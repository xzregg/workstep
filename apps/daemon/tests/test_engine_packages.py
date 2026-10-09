import os
import sys

from services.engine_packages import prepare_engine_package_dir


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
