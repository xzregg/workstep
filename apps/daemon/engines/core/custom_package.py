"""Non-executing manifest and package checks shared by daemon and workers."""
import hashlib
import json
import re
import os
from pathlib import Path

API_VERSION = 1
EXTENSION_EVENTS = frozenset({"goal_update"})


def declared_events(engine):
    return set(engine.acp_events) | set(getattr(engine, "workstep_events", ()))

MAX_MANIFEST_BYTES = 256 * 1024
EXCLUDED = {"dependencies", "cache", ".workstep", ".git", "__pycache__"}


def package_root(path: str | Path) -> Path:
    root = Path(path).expanduser().resolve()
    if root.is_file():
        if root.suffix != ".py":
            raise ValueError("The specified path must be a Python file or engine directory")
        root = root.parent
    if not root.is_dir():
        raise ValueError("Engine directory does not exist")
    return root


def safe_file(root: Path, name: str) -> Path:
    path = Path(name)
    if path.is_absolute() or not path.parts or any(part in {"..", "."} for part in path.parts):
        raise ValueError("Invalid file path within package")
    if path.parts[0] in EXCLUDED or path.name in {"validation.json", "installation.json", "dependency-installation.json", "validation-summary.json", "auth.json", "config.json", ".env", "credentials.json"}:
        raise ValueError("Dependencies, cache, and runtime data cannot be listed as export files")
    target = root / path
    if any(parent.is_symlink() for parent in [target, *target.parents] if parent != root.parent):
        raise ValueError("Files within the package cannot use symbolic links")
    if not target.is_file() or not target.resolve().is_relative_to(root):
        raise ValueError("File does not exist or exceeds the engine directory")
    return target


def load_manifest(root: Path) -> dict:
    file = root / "manifest.json"
    if file.is_symlink() or not file.is_file() or file.stat().st_size > MAX_MANIFEST_BYTES:
        raise ValueError("A valid manifest.json is required (no larger than 256 KiB):")
    data = json.loads(file.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or data.get("api_version") != API_VERSION:
        raise ValueError("Unsupported custom engine interface version")
    if not re.fullmatch(r"[a-z][a-z0-9_]{0,63}", str(data.get("id", ""))):
        raise ValueError("Engine ID must be lowercase letters, numbers, and underscores")
    if not re.fullmatch(r"[A-Za-z_]\w*", str(data.get("class_name", ""))):
        raise ValueError("Need a valid class_name")
    if data.get("mode") not in {"cli", "acp", "sdk", "agent"}:
        raise ValueError("Invalid engine mode")
    if not isinstance(data.get("name"), str) or not data["name"].strip():
        raise ValueError("Engine name required")
    entry = data.get("entry", "engine.py")
    if not isinstance(entry, str) or not entry.endswith(".py"):
        raise ValueError("The entry point must be a Python file")
    data["entry"] = entry
    files = data.get("files", [])
    if not isinstance(files, list) or len(files) > 1000 or not all(isinstance(item, str) for item in files):
        raise ValueError("files must be a list of file paths within the package (up to 1000 items)")
    declared = {entry, *files}
    for current, directories, filenames in os.walk(root, followlinks=False):
        directories[:] = [name for name in directories if name not in EXCLUDED and not name.startswith(".dependencies")]
        for name in filenames:
            file = Path(current) / name
            if file.suffix == ".py" and file.relative_to(root).as_posix() not in declared:
                raise ValueError("All Python source files must be listed in files")
    tests = root / "tests"
    if tests.exists():
        for file in tests.rglob("*"):
            if file.is_file() and file.suffix in {".py", ".json"} and "__pycache__" not in file.parts:
                if file.relative_to(root).as_posix() not in declared:
                    raise ValueError("Test and scenario files must be listed in files")
    if not isinstance(data.get("description", ""), str):
        raise ValueError("description must be a string")
    for name in declared:
        safe_file(root, name)
    return data


def exported_files(root: Path, manifest: dict) -> list[str]:
    return sorted({"manifest.json", manifest["entry"], *manifest.get("files", [])})


def digest(root: Path, manifest: dict, *, dependencies: bool = False) -> str:
    value = hashlib.sha256()
    for name in exported_files(root, manifest):
        target = safe_file(root, name)
        value.update(name.encode())
        with target.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                value.update(chunk)
    if dependencies and (root / "dependencies").exists():
        dependency_root = (root / "dependencies").resolve()
        for target in sorted((root / "dependencies").rglob("*")):
            if target.is_symlink():
                link = target.readlink()
                if link.is_absolute() or not target.resolve().is_relative_to(dependency_root) or not target.exists():
                    raise ValueError("Dependency symbolic links must be relative paths within the directory")
                value.update(str(target.relative_to(root)).encode())
                value.update(str(link).encode())
            if target.is_file() and "__pycache__" not in target.parts and not target.name.endswith(".pyc"):
                value.update(str(target.relative_to(root)).encode())
                with target.open("rb") as source:
                    for chunk in iter(lambda: source.read(1024 * 1024), b""):
                        value.update(chunk)
    return value.hexdigest()
