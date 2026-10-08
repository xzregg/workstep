"""Resolve project data from its portable identity marker (synchronous I/O)."""
import json
import re
from pathlib import Path

from services import config
from settings import settings


def identity_file(root: str | Path) -> Path:
    return Path(root) / settings.workstep_dir / "project.json"


def read_identity(root: str | Path) -> dict:
    marker = identity_file(root)
    if marker.is_symlink() or marker.parent.is_symlink():
        raise ValueError("项目身份目录不能是符号链接")
    if not marker.exists():
        return {}
    payload = json.loads(marker.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("项目身份文件无效")
    project_id = payload.get("id")
    if project_id is not None and not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", str(project_id)):
        raise ValueError("项目 ID 无效")
    if type(payload.get("follow_project", True)) is not bool:
        raise ValueError("项目存储设置无效")
    return payload


def external_directory(project_id: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", project_id):
        raise ValueError("项目 ID 无效")
    return config.CONFIG_DIR / "projects" / project_id


def data_directory(root: str | Path) -> Path:
    identity = read_identity(root)
    if identity.get("follow_project", True):
        return Path(root) / settings.workstep_dir
    if not identity.get("id"):
        raise ValueError("外置项目缺少项目 ID")
    return external_directory(identity["id"])


def write_identity(root: str | Path, project_id: str, follow_project: bool) -> None:
    marker = identity_file(root)
    marker.parent.mkdir(parents=True, exist_ok=True)
    temporary = marker.with_suffix(".json.tmp")
    if temporary.is_symlink():
        raise ValueError("项目身份临时文件不能是符号链接")
    temporary.write_text(json.dumps({"id": project_id, "follow_project": follow_project}) + "\n", encoding="utf-8")
    temporary.replace(marker)


def relocate_snapshot(value, source: Path, target: Path):
    """Update structured artifact path fields, preserving historical prose."""
    if isinstance(value, list):
        return [relocate_snapshot(item, source, target) for item in value]
    if isinstance(value, dict):
        result = {}
        for key, item in value.items():
            if key == "path" and isinstance(item, str):
                path = Path(item)
                if path.is_absolute() and path.is_relative_to(source):
                    item = str(target / path.relative_to(source))
            result[key] = relocate_snapshot(item, source, target)
        return result
    return value
