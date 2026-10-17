"""Global JSON role library, seeded like workflow templates.

All methods are synchronous complete file work units. Async callers must use
asyncio.to_thread. A team stores role IDs and duties, never role prompt copies.
"""
import hashlib
import json
import logging
import os
import re
import tempfile
import threading
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from schemas.role_center import RoleDocument, RoleWrite, TeamDocument, TeamWrite

logger = logging.getLogger(__name__)
SHIPPED_DIR = Path(__file__).resolve().parents[1] / "data" / "role-center"
ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")


class RoleConflict(ValueError):
    pass


class RoleCenter:
    def __init__(self, root: Path | None = None):
        self._root = root
        self._lock = threading.RLock()
        self._catalog_cache = None
        self._catalog_root = None

    @property
    def root(self):
        from services import config
        return self._root if self._root is not None else config.CONFIG_DIR / "data" / "role-center"

    def _directory(self, kind):
        directory = self.root / kind
        if self.root.is_symlink() or directory.is_symlink():
            raise ValueError("角色中心不能使用符号链接目录")
        return directory

    def _path(self, kind, asset_id):
        if not ID_PATTERN.fullmatch(asset_id):
            raise ValueError("角色或专家团 ID 格式不正确")
        path = self._directory(kind) / (asset_id + ".json")
        if path.is_symlink():
            raise ValueError("角色文件不能是符号链接")
        return path

    def _atomic_write(self, path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                             prefix=".role-pending-", delete=False) as stream:
                temp = Path(stream.name)
                json.dump(data, stream, ensure_ascii=False, indent=2)
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp, path)
        finally:
            if temp is not None:
                temp.unlink(missing_ok=True)

    def ensure_defaults(self):
        with self._lock:
            self._catalog_cache = None
            # Only populate missing files. Edited shipped roles stay editable.
            for kind in ("roles", "teams"):
                directory = self._directory(kind)
                directory.mkdir(parents=True, exist_ok=True)
                for src in (SHIPPED_DIR / kind).glob("*.json"):
                    target = self._path(kind, src.stem)
                    if not target.exists():
                        self._atomic_write(target, json.loads(src.read_text(encoding="utf-8")))
            for name in ("categories.json", "source.json", "LICENSE.agency-agents.txt"):
                target = self.root / name
                if target.is_symlink():
                    raise ValueError("角色中心元数据不能是符号链接")
                if not target.exists():
                    target.write_bytes((SHIPPED_DIR / name).read_bytes())

    def _read(self, kind, asset_id):
        path = self._path(kind, asset_id)
        if not path.exists():
            raise FileNotFoundError(asset_id)
        if path.stat().st_size > 2_000_000:
            raise ValueError("角色文件过大")
        raw = path.read_bytes()
        data = json.loads(raw)
        model = RoleDocument if kind == "roles" else TeamDocument
        data = model.model_validate(data).model_dump()
        if data["id"] != asset_id:
            raise ValueError("角色文件 ID 与文件名不一致")
        data["revision"] = hashlib.sha256(raw).hexdigest()
        return data

    def get_role(self, role_id):
        with self._lock:
            return self._read("roles", role_id)

    def get_team(self, team_id):
        with self._lock:
            return self._read("teams", team_id)

    def _list(self, kind, warnings):
        documents = []
        for path in sorted(self._directory(kind).glob("*.json")):
            try:
                documents.append(self._read(kind, path.stem))
            except (ValueError, OSError) as exc:
                logger.warning("Cannot read role center asset %s: %s", path.name, exc)
                warnings.append(path.name)
        return documents

    def catalog(self):
        with self._lock:
            root = self.root
            if self._catalog_cache is not None and self._catalog_root == root:
                return deepcopy(self._catalog_cache)
            warnings = []
            roles, teams = self._list("roles", warnings), self._list("teams", warnings)
            path = self.root / "categories.json"
            if path.is_symlink():
                raise ValueError("分类文件不能是符号链接")
            categories = json.loads(path.read_text(encoding="utf-8")) if path.exists() else []
            known = {item["id"] for item in categories}
            for item in roles:
                if item["category"] not in known:
                    categories.append({"id": item["category"], "name": item["category"]})
                    known.add(item["category"])
            # Catalog reads do not send hundreds of full prompts to the client.
            catalog = {
                "categories": categories,
                "roles": [{key: value for key, value in item.items() if key != "prompt"} for item in roles],
                "teams": [{key: value for key, value in item.items() if key != "prompt"} for item in teams],
                "warnings": warnings,
            }
            self._catalog_cache = catalog
            self._catalog_root = root
            return deepcopy(catalog)

    def _save(self, kind, asset_id, request):
        with self._lock:
            existing = self._read(kind, asset_id) if asset_id else None
            if existing:
                if request.expected_revision != existing["revision"]:
                    raise RoleConflict("内容已被其他窗口修改，请重新打开后再保存")
            elif request.expected_revision:
                raise ValueError("新建角色或专家团不能带已有版本")
            warnings = []
            if any(item["id"] != asset_id and item["name"].casefold() == request.name.casefold()
                   for item in self._list(kind, warnings)):
                raise RoleConflict("名称已存在")
            if kind == "teams":
                for member in request.members:
                    try:
                        self._read("roles", member.role_id)
                    except FileNotFoundError as exc:
                        raise ValueError("成员角色不存在：" + member.role_id) from exc
            asset_id = asset_id or uuid4().hex
            data = request.model_dump(exclude={"expected_revision"})
            data.update(id=asset_id, updated_at=datetime.now(timezone.utc).isoformat())
            if kind == "roles":
                data.update(builtin=existing["builtin"] if existing else False,
                            source=existing["source"] if existing else None)
            self._atomic_write(self._path(kind, asset_id), data)
            self._catalog_cache = None
            return self._read(kind, asset_id)

    def save_role(self, request: RoleWrite, role_id=None):
        return self._save("roles", role_id, request)

    def save_team(self, request: TeamWrite, team_id=None):
        return self._save("teams", team_id, request)


role_center = RoleCenter()
