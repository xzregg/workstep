"""Versioned runtime installation, with measured primary-package downloads.

Dependency resolution belongs to npm/uv/pip. Its bytes are deliberately not
mixed into the primary archive's download percentage.
"""
import asyncio
import importlib.metadata
import hashlib
import base64
import uuid
from datetime import datetime, timezone
from dataclasses import replace
from contextlib import asynccontextmanager
from tempfile import TemporaryDirectory
import json
import os
import shutil
import re
import sys
from pathlib import Path
from urllib.parse import quote

import httpx
from packaging.specifiers import SpecifierSet
from packaging.tags import sys_tags
from packaging.utils import canonicalize_name, parse_wheel_filename
from packaging.version import InvalidVersion, Version

from engines.core.packages import RuntimePackage
from engines.core.base import install_python_package, install_with_command
from engines.core.registry import list_all_engines
from services.config import CONFIG_DIR, config_store


class EngineRuntimeManager:
    def __init__(self, directory: Path, *, transport=None):
        self.directory = directory
        self.transport = transport
        self._task: asyncio.Task | None = None
        self._busy = False
        self._states: dict[str, dict] = {}

    def package(self, engine_id: str) -> RuntimePackage:
        engine = list_all_engines().get(engine_id)
        if engine is None:
            raise ValueError("未知引擎")
        if engine.RUNTIME_PACKAGE is None:
            raise ValueError("该引擎的版本由外部安装或项目依赖管理")
        return engine.RUNTIME_PACKAGE

    def installed_version(self, spec: RuntimePackage) -> str | None:
        if spec.kind == "pypi":
            try:
                return importlib.metadata.version(spec.name)
            except importlib.metadata.PackageNotFoundError:
                return None
        cls = next(c for c in list_all_engines().values() if c.RUNTIME_PACKAGE == spec)
        raw = cls.get_version() or ""
        match = re.search(r"\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?", raw)
        return match.group() if match else None

    async def releases(self, spec: RuntimePackage) -> tuple[list[dict], str | None]:
        url = (f"https://pypi.org/pypi/{quote(spec.name, safe='')}/json" if spec.kind == "pypi"
               else f"https://registry.npmjs.org/{quote(spec.name, safe='')}")
        async with httpx.AsyncClient(transport=self.transport, timeout=30) as client:
            response = await client.get(url)
            response.raise_for_status()
            data = response.json()
        entries = []
        tags = list(sys_tags())
        tag_rank = {tag: i for i, tag in enumerate(tags)}
        for version, value in data.get("releases" if spec.kind == "pypi" else "versions", {}).items():
            try:
                parsed = Version(version)
                if parsed < Version(spec.minimum):
                    continue
            except InvalidVersion:
                continue
            if spec.kind == "pypi":
                candidates = []
                for file in value:
                    if file.get("yanked") or not file.get("url"):
                        continue
                    requires = file.get("requires_python")
                    if requires and not SpecifierSet(requires).contains(".".join(map(str, sys.version_info[:3]))):
                        continue
                    filename = file["filename"]
                    # Wheels only: no arbitrary source builds or ambiguous size estimates.
                    try:
                        _, _, _, wheel_tags = parse_wheel_filename(filename)
                    except ValueError:
                        continue
                    rank = min((tag_rank[t] for t in wheel_tags if t in tag_rank), default=None)
                    if rank is not None:
                        candidates.append((rank, file))
                if not candidates:
                    continue
                file = min(candidates, key=lambda item: item[0])[1]
                entry = {"url": file["url"], "filename": file["filename"],
                         "size_bytes": file.get("size"), "sha256": file.get("digests", {}).get("sha256")}
            else:
                dist = value.get("dist", {})
                if not dist.get("tarball"):
                    continue
                entry = {"url": dist["tarball"], "filename": "package.tgz",
                         "size_bytes": None, "integrity": dist.get("integrity"), "shasum": dist.get("shasum")}
            entries.append({"version": version, "prerelease": parsed.is_prerelease, **entry})
        entries.sort(key=lambda e: Version(e["version"]), reverse=True)
        latest = data.get("info", {}).get("version") if spec.kind == "pypi" else data.get("dist-tags", {}).get("latest")
        versions = {e["version"] for e in entries}
        default = spec.default_version if spec.default_version in versions else latest
        if default not in versions:
            default = next((e["version"] for e in entries if not e["prerelease"]), None)
        return entries, default

    async def catalog(self, engine_id: str) -> dict:
        spec = self.package(engine_id)
        current = await asyncio.to_thread(self.installed_version, spec)
        error = None
        try:
            entries, default = await self.releases(spec)
        except (httpx.HTTPError, ValueError) as exc:
            entries, default = [], None
            error = f"读取版本列表失败，请重试：{exc}"
        record = await asyncio.to_thread(self._read, engine_id)
        cls = list_all_engines()[engine_id]
        override = await asyncio.to_thread(cls.get_binary_override)
        return {"engine_id": engine_id, "current_version": current,
                "rollback_version": record.get("rollback_version"), "history": record.get("history", []),
                "requires_terms": cls.requires_third_party_terms_acceptance(),
                "terms_url": cls.third_party_terms_url(), "configured_path": override,
                "default_version": default, "minimum_version": spec.minimum,
                "size_scope": "primary_package", "versions": [
                    {k: e[k] for k in ("version", "prerelease", "size_bytes")} for e in entries
                ], "error": error}


    def _read(self, engine_id: str) -> dict:
        path = self.directory / f"{engine_id}.json"
        if not path.exists():
            return {}
        return json.loads(path.read_text())

    def _save(self, engine_id: str, record: dict):
        self.directory.mkdir(parents=True, exist_ok=True)
        path = self.directory / f"{engine_id}.json"
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps(record, ensure_ascii=False, indent=2))
        temporary.replace(path)

    async def operation(self, engine_id: str) -> dict | None:
        self.package(engine_id)
        if engine_id in self._states:
            return dict(self._states[engine_id])
        record = await asyncio.to_thread(self._read, engine_id)
        state = record.get("operation")
        if state and state["status"] in ("queued", "running"):
            state.update(status="failed", stage="failed", message="后台服务已重启，安装中断；请重试或回退")
            await asyncio.to_thread(self._save, engine_id, record)
        return state

    async def start(self, engine_id: str, version: str | None, *, rollback=False, accept_terms=False) -> dict:
        spec = self.package(engine_id)
        if self._busy:
            raise RuntimeError("已有引擎安装任务正在执行，请等待完成")
        self._busy = True
        try:
            cls = list_all_engines()[engine_id]
            if cls.requires_third_party_terms_acceptance() and not accept_terms:
                raise ValueError("请先阅读并接受第三方服务条款")
            if await asyncio.to_thread(cls.get_binary_override):
                raise ValueError("当前使用自定义可执行文件路径，请先清除路径配置再管理版本")
            record = await asyncio.to_thread(self._read, engine_id)
            if rollback:
                version = record.get("rollback_version")
                if not version:
                    raise ValueError("没有可回退的版本")
            if not version or not re.fullmatch(r"[0-9][0-9A-Za-z.+-]{0,99}", version):
                raise ValueError("请选择确切的版本号")
            previous = await asyncio.to_thread(self.installed_version, spec)
            state = {"id": uuid.uuid4().hex, "engine_id": engine_id,
                     "action": "rollback" if rollback else "install", "target_version": version,
                     "previous_version": previous, "status": "queued", "stage": "preparing",
                     "downloaded_bytes": 0, "total_bytes": None, "size_scope": "primary_package",
                     "message": "", "started_at": datetime.now(timezone.utc).isoformat()}
            # Save the recovery target BEFORE changing anything in the environment.
            # A retry must not overwrite recovery with a partially installed version.
            failed = record.get("operation", {}).get("status") in ("failed", "running", "queued")
            if previous and previous != version and not (failed and record.get("rollback_version")):
                record["rollback_version"] = previous
            record["operation"] = state
            await asyncio.to_thread(self._save, engine_id, record)
            self._states[engine_id] = state
            self._task = asyncio.create_task(self._run(engine_id, spec, state, record))
            return dict(state)
        except BaseException:
            self._busy = False
            raise

    async def _download(self, entry: dict, destination: Path, state: dict):
        url = httpx.URL(entry["url"])
        if url.scheme != "https" or url.host not in {"files.pythonhosted.org", "registry.npmjs.org"}:
            raise ValueError("安装包地址不属于官方包仓库")
        expected = entry.get("sha256")
        algorithm = "sha256"
        if not expected and entry.get("integrity"):
            integrity = next((v for v in entry["integrity"].split() if v.startswith("sha512-")), "")
            if integrity:
                algorithm = "sha512"
                expected = base64.b64decode(integrity.split("-", 1)[1]).hex()
        if not expected and entry.get("shasum"):
            algorithm, expected = "sha1", entry["shasum"]
        if not expected:
            raise ValueError("包仓库未提供校验摘要，无法验证安装包")
        digest = hashlib.new(algorithm)
        state.update(stage="downloading", total_bytes=entry.get("size_bytes"))
        async with httpx.AsyncClient(transport=self.transport, timeout=60, headers={"Accept-Encoding": "identity"}) as client:
            async with client.stream("GET", str(url)) as response:
                response.raise_for_status()
                length = response.headers.get("content-length")
                if length and length.isdigit():
                    state["total_bytes"] = int(length)
                with destination.open("wb") as file:
                    async for chunk in response.aiter_bytes(256 * 1024):
                        await asyncio.to_thread(file.write, chunk)
                        digest.update(chunk)
                        state["downloaded_bytes"] += len(chunk)
        if state["total_bytes"] is not None and state["total_bytes"] != state["downloaded_bytes"]:
            raise ValueError("安装包下载不完整，请重试")
        if digest.hexdigest() != expected:
            raise ValueError("安装包校验失败，请重试")
        state["total_bytes"] = state["downloaded_bytes"]

    async def _install_python_archive(self, spec: RuntimePackage, archive: Path, version: str):
        package_dir = os.environ.get("WORKSTEP_ENGINE_PACKAGE_DIR", "").strip()
        if not package_dir:
            return await install_python_package(str(archive), upgrade=True)
        target = Path(package_dir).expanduser().resolve()
        await asyncio.to_thread(target.parent.mkdir, parents=True, exist_ok=True)
        # pip --target does not remove older dist-info. Stage the shared site,
        # then remove only metadata superseded by the installer report.
        with TemporaryDirectory(prefix=".workstep-packages-", dir=target.parent, ignore_cleanup_errors=True) as temporary:
            stage = Path(temporary) / "packages"
            report = Path(temporary) / "install-report.json"
            if await asyncio.to_thread(target.exists):
                await asyncio.to_thread(shutil.copytree, target, stage)
            else:
                stage.mkdir()
            result = await install_with_command([
                sys.executable, "-m", "pip", "install", "--upgrade", "--target", str(stage),
                "--report", str(report), str(archive),
            ], display=spec.name)
            if not result.success:
                return result

            def validate_and_switch():
                installed = {
                    canonicalize_name(item["metadata"]["name"]): item["metadata"]["version"]
                    for item in json.loads(report.read_text())["install"]
                }
                for info in stage.glob("*.dist-info"):
                    distribution = importlib.metadata.PathDistribution(info)
                    name = canonicalize_name(distribution.metadata.get("Name", ""))
                    if name in installed and distribution.version != installed[name]:
                        shutil.rmtree(info)
                current = next((d.version for d in importlib.metadata.distributions(path=[str(stage)])
                                if canonicalize_name(d.metadata.get("Name", "")) == canonicalize_name(spec.name)), None)
                if current != version:
                    raise ValueError("临时安装目录版本校验失败，原安装保持不变")
                backup = Path(temporary) / "previous"
                had_target = target.exists()
                if had_target:
                    target.rename(backup)
                try:
                    stage.rename(target)
                except BaseException:
                    if had_target:
                        backup.rename(target)
                    raise
            await asyncio.to_thread(validate_and_switch)
            return result

    async def _run(self, engine_id: str, spec: RuntimePackage, state: dict, record: dict):
        terminal = {}
        try:
            state["status"] = "running"
            async with asyncio.timeout(900):
                release_spec = replace(spec, minimum="0") if state["action"] == "rollback" else spec
                entries, _ = await self.releases(release_spec)
                entry = next((e for e in entries if e["version"] == state["target_version"]), None)
                if entry is None:
                    raise ValueError("该版本不可用或不满足当前平台和最低版本要求，请刷新版本列表")
                with TemporaryDirectory(prefix="workstep-engine-") as directory:
                    destination = Path(directory) / entry["filename"]
                    if destination.parent != Path(directory):
                        raise ValueError("无效的安装包文件名")
                    await self._download(entry, destination, state)
                    state["stage"] = "installing"
                    await asyncio.to_thread(self._save, engine_id, record)
                    if spec.kind == "pypi":
                        result = await self._install_python_archive(spec, destination, state["target_version"])
                    else:
                        result = await install_with_command(["npm", "install", "-g", str(destination)], display=spec.name)
                    if not result.success:
                        raise ValueError(result.message)
                    state["stage"] = "verifying"
                    current = await asyncio.to_thread(self.installed_version, spec)
                    if current != state["target_version"]:
                        raise ValueError(f"安装后版本校验未通过：期望 {state['target_version']}，实际 {current or '未找到'}；可重试或回退")
            await asyncio.to_thread(config_store.set_engine_verified, engine_id, False)
            from engines.core.registry import refresh_registry
            await asyncio.to_thread(refresh_registry)
            record.setdefault("history", []).append({"from_version": state["previous_version"],
                "to_version": state["target_version"], "action": state["action"], "at": state["started_at"]})
            record["history"] = record["history"][-20:]
            if state["action"] == "rollback":
                previous = state["previous_version"]
                record["rollback_version"] = previous if previous != state["target_version"] else None
            terminal = dict(status="succeeded", stage="completed", message=(
                "版本切换完成，请重启后台服务后重新扫描和测试引擎" if spec.kind == "pypi"
                else "版本切换完成，请重新测试引擎"))
        except asyncio.CancelledError:
            terminal = dict(status="failed", stage="failed", message="安装已中断，可重试或回退")
            raise
        except Exception as exc:
            terminal = dict(status="failed", stage="failed", message=str(exc) or "安装失败或超时，可重试或回退")
        finally:
            # Publish completion only after the recovery record is durable.
            record["operation"] = {**state, **terminal}
            try:
                await asyncio.to_thread(self._save, engine_id, record)
            except Exception as exc:
                state.update(status="failed", stage="failed", message=f"安装结果保存失败，请检查磁盘后重新扫描：{exc}")
            else:
                state.update(terminal)
            finally:
                self._busy = False

    @asynccontextmanager
    async def legacy_operation(self):
        if self._busy:
            raise RuntimeError("已有引擎安装任务正在执行，请等待完成")
        self._busy = True
        try:
            yield
        finally:
            self._busy = False

    async def shutdown(self):
        if self._task and not self._task.done():
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)


runtime_manager = EngineRuntimeManager(CONFIG_DIR / "engine-runtimes")
