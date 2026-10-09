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
            raise ValueError("指定路径必须是 Python 文件或引擎目录")
        root = root.parent
    if not root.is_dir():
        raise ValueError("引擎目录不存在")
    return root


def safe_file(root: Path, name: str) -> Path:
    path = Path(name)
    if path.is_absolute() or not path.parts or any(part in {"..", "."} for part in path.parts):
        raise ValueError("包内文件路径无效")
    if path.parts[0] in EXCLUDED or path.name in {"validation.json", "installation.json", "dependency-installation.json", "validation-summary.json", "auth.json", "config.json", ".env", "credentials.json"}:
        raise ValueError("依赖、缓存和运行数据不能列为导出文件")
    target = root / path
    if any(parent.is_symlink() for parent in [target, *target.parents] if parent != root.parent):
        raise ValueError("包内文件不能使用符号链接")
    if not target.is_file() or not target.resolve().is_relative_to(root):
        raise ValueError("包内文件不存在或超出引擎目录")
    return target


def load_manifest(root: Path) -> dict:
    file = root / "manifest.json"
    if file.is_symlink() or not file.is_file() or file.stat().st_size > MAX_MANIFEST_BYTES:
        raise ValueError("需要有效的 manifest.json（不超过 256 KiB）")
    data = json.loads(file.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or data.get("api_version") != API_VERSION:
        raise ValueError("不支持的自定义引擎接口版本")
    if not re.fullmatch(r"[a-z][a-z0-9_]{0,63}", str(data.get("id", ""))):
        raise ValueError("引擎 ID 必须是小写字母、数字和下划线")
    if not re.fullmatch(r"[A-Za-z_]\w*", str(data.get("class_name", ""))):
        raise ValueError("需要有效的 class_name")
    if data.get("mode") not in {"cli", "acp", "sdk", "agent"}:
        raise ValueError("引擎 mode 无效")
    if not isinstance(data.get("name"), str) or not data["name"].strip():
        raise ValueError("需要引擎名称")
    entry = data.get("entry", "engine.py")
    if not isinstance(entry, str) or not entry.endswith(".py"):
        raise ValueError("入口必须是 Python 文件")
    data["entry"] = entry
    files = data.get("files", [])
    if not isinstance(files, list) or len(files) > 1000 or not all(isinstance(item, str) for item in files):
        raise ValueError("files 必须是包内文件路径列表（最多 1000 项）")
    declared = {entry, *files}
    for current, directories, filenames in os.walk(root, followlinks=False):
        directories[:] = [name for name in directories if name not in EXCLUDED and not name.startswith(".dependencies")]
        for name in filenames:
            file = Path(current) / name
            if file.suffix == ".py" and file.relative_to(root).as_posix() not in declared:
                raise ValueError("所有 Python 源码必须列入 files")
    tests = root / "tests"
    if tests.exists():
        for file in tests.rglob("*"):
            if file.is_file() and file.suffix in {".py", ".json"} and "__pycache__" not in file.parts:
                if file.relative_to(root).as_posix() not in declared:
                    raise ValueError("测试和场景文件必须列入 files")
    if not isinstance(data.get("description", ""), str):
        raise ValueError("description 必须是文本")
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
                    raise ValueError("依赖符号链接必须为目录内部的相对路径")
                value.update(str(target.relative_to(root)).encode())
                value.update(str(link).encode())
            if target.is_file() and "__pycache__" not in target.parts and not target.name.endswith(".pyc"):
                value.update(str(target.relative_to(root)).encode())
                with target.open("rb") as source:
                    for chunk in iter(lambda: source.read(1024 * 1024), b""):
                        value.update(chunk)
    return value.hexdigest()
