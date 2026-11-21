"""Custom engine installation, acceptance and portable package operations."""
import asyncio
from contextlib import suppress
from datetime import datetime, timezone
import io
import hashlib
import hmac
import json
import os
from pathlib import Path
import shutil
import uuid
import zipfile

from engines.core.custom_package import digest, exported_files, load_manifest, package_root, safe_file
from engines.core.custom_proxy import custom_root, make_custom_engine
from engines.core.custom_transport import CustomWorkerClient
from services.config import config_store


class CustomEngineManager:
    def __init__(self):
        self.operations = {}
        self.tasks = {}
        self.locks = {}

    def root(self):
        return custom_root()

    async def _close_cached_workers(self, root, *, include_busy=False):
        pools = getattr(asyncio.get_running_loop(), '_workstep_session_pools', {})
        for name, pool in list(pools.items()):
            if name.startswith('custom:'):
                for entry in list(pool._entries.values()):
                    if entry.client.root == root and (include_busy or not entry.busy):
                        await pool.discard(entry)

    def _load(self, path):
        root = package_root(path)
        manifest = load_manifest(root)
        from engines.core.registry import list_all_engines
        existing = list_all_engines().get(manifest["id"])
        if existing is not None and not getattr(existing, "_metadata", {}).get("custom"):
            raise ValueError("Cannot overwrite built-in engine ID")
        return root, manifest

    async def inspect(self, path, timeout=15):
        root, manifest = await asyncio.to_thread(self._load, path)
        worker = CustomWorkerClient(root)
        try:
            metadata = await worker.call("describe", timeout=timeout)
        finally:
            await worker.close()
        target = self.root() / manifest["id"]
        registered = await asyncio.to_thread(target.is_dir)
        return {"engine": metadata, "path": str(root), "registered": registered,
                "same_package": registered and await asyncio.to_thread(self._same, root, target),
                "dependencies_directory": str(root / "dependencies")}

    def _same(self, left, right):
        try:
            return digest(left, load_manifest(left)) == digest(right, load_manifest(right))
        except Exception:
            return False

    def _fingerprint(self, root, manifest):
        from engines.core.custom_sdk import raw_config
        import hashlib
        # Secrets are hashed only; no raw values are written into reports.
        configured = {
            "values": raw_config(manifest["id"]),
            "provider": config_store.get_engine_provider(manifest["id"]),
            "model": config_store.get_engine_default_model(manifest["id"]),
            "providers": config_store.get_providers(),
        }
        return {"package_digest": digest(root, manifest, dependencies=True),
                "config_digest": hashlib.sha256(json.dumps(configured, sort_keys=True).encode()).hexdigest()}

    def _seal(self, report):
        key = config_store.get("custom_validation_key")
        if not key:
            key = uuid.uuid4().hex + uuid.uuid4().hex
            config_store.set("custom_validation_key", key)
        payload = {name: value for name, value in report.items() if name != "signature"}
        return hmac.new(key.encode(), json.dumps(payload, sort_keys=True).encode(), hashlib.sha256).hexdigest()

    async def configure(self, path, values, clear=None, confirmed=None, provider_id=None, model=None):
        info = await self.inspect(path)
        engine = make_custom_engine(Path(info["path"]), info["engine"])()
        await engine.save_full_config_values({**values, **({"provider_id": provider_id} if provider_id is not None else {})}, clear, confirmed)
        if model is not None:
            await asyncio.to_thread(config_store.set_engine_default_model, engine.ENGINE_ID, model)
        return {"ok": True, "engine_id": engine.ENGINE_ID}

    async def start_operation(self, action, path):
        if action not in {"install", "validate"}:
            raise ValueError("Unsupported access operation")
        root, _ = await asyncio.to_thread(self._load, path)
        for operation in self.operations.values():
            if operation["path"] == str(root) and operation["status"] == "running":
                if operation["action"] == action:
                    return dict(operation)
                raise ValueError("An installation or acceptance operation is already in progress for this engine:")
        key = uuid.uuid4().hex
        operation = {"id": key, "action": action, "path": str(root), "status": "running", "result": None}
        self.operations[key] = operation
        await asyncio.to_thread(self._save_operation, operation)
        task = asyncio.create_task(self._operate(key))
        self.tasks[key] = task
        return dict(operation)

    def _save_operation(self, operation):
        from services.config import CONFIG_DIR
        directory = CONFIG_DIR / "runtime" / "engine-operations"
        directory.mkdir(parents=True, exist_ok=True)
        self._write_json(directory / f"{operation['id']}.json", operation)

    async def get_operation(self, key):
        if key in self.operations:
            return dict(self.operations[key])
        def read():
            from services.config import CONFIG_DIR
            if not key.isalnum() or len(key) != 32:
                raise ValueError("Invalid operation ID")
            file = CONFIG_DIR / "runtime" / "engine-operations" / f"{key}.json"
            if not file.is_file():
                raise ValueError("Operation does not exist")
            operation = json.loads(file.read_text())
            if operation["status"] == "running":
                operation.update(status="interrupted", result={"ok": False, "error": "Background restart, operation interrupted"})
            return operation
        return await asyncio.to_thread(read)

    async def cancel_operation(self, key):
        task = self.tasks.get(key)
        if task and not task.done():
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task
        return await self.get_operation(key)

    async def _operate(self, key):
        operation = self.operations[key]
        try:
            result = await self.run_operation(operation["action"], operation["path"])
            operation.update(status="completed" if result.get("ok") else "failed", result=result)
        except asyncio.CancelledError:
            operation.update(status="cancelled", result={"ok": False, "error": "Operation stopped"})
        except Exception as exc:
            operation.update(status="failed", result={"ok": False, "error": str(exc)})
        finally:
            await asyncio.to_thread(self._save_operation, operation)
            self.tasks.pop(key, None)
            # Bounded in-memory history; persisted operations remain queryable.
            completed = [key for key, value in self.operations.items() if value["status"] != "running"]
            for old in completed[:-100]:
                self.operations.pop(old, None)

    async def run_operation(self, action, path):
        root, manifest = await asyncio.to_thread(self._load, path)
        lock = self.locks.setdefault(manifest["id"], asyncio.Lock())
        async with lock:
            if action == "install":
                return await self._install(root, manifest)
            if action == "validate":
                return await self._validate(root, manifest)
            raise ValueError("Unsupported access operation")

    async def _install(self, root, manifest):
        await self._close_cached_workers(root)
        from engines.core.custom_transport import ACTIVE_CLIENTS
        if any(client.root == root and not client.closed for client in ACTIVE_CLIENTS):
            raise ValueError("Engine is running, cannot replace dependencies")
        stage = root / f".dependencies-{uuid.uuid4().hex}"
        previous = root / "dependencies"
        backup = root / f".dependencies-backup-{uuid.uuid4().hex}"
        def prepare():
            stage.mkdir()
            (root / "cache").mkdir(exist_ok=True)
            if previous.exists():
                shutil.copytree(previous, stage, dirs_exist_ok=True, symlinks=True)
        await asyncio.to_thread(prepare)
        worker = CustomWorkerClient(root, dependencies=stage)
        switched = False
        try:
            result = await worker.call("install", timeout=900)
            if not isinstance(result, dict) or result.get("success") is not True:
                raise ValueError("Custom install did not complete successfully")
            await worker.close()
            worker = CustomWorkerClient(root, dependencies=stage)
            metadata = await worker.call("describe", timeout=15)
            if not metadata.get("installed"):
                raise ValueError("Actual dependency check failed after installation")
            await worker.close()
            def switch():
                if previous.exists():
                    previous.rename(backup)
                try:
                    stage.rename(previous)
                except BaseException:
                    if backup.exists():
                        backup.rename(previous)
                    raise
            await asyncio.to_thread(switch)
            switched = True
            await asyncio.to_thread(self._write_json, root / "dependency-installation.json", {
                "version": metadata.get("version"), "api_version": 1,
                "system": __import__("platform").system(), "architecture": __import__("platform").machine(),
            })
            await asyncio.to_thread((root / "validation.json").unlink, missing_ok=True)
            await asyncio.to_thread(config_store.set_engine_verified, manifest["id"], False)
            return {"ok": True, "engine_id": manifest["id"], "version": metadata.get("version")}
        except BaseException:
            if switched:
                await asyncio.to_thread(shutil.rmtree, previous, ignore_errors=True)
                if await asyncio.to_thread(backup.exists):
                    await asyncio.to_thread(backup.rename, previous)
            raise
        finally:
            await worker.close()
            await asyncio.to_thread(shutil.rmtree, stage, ignore_errors=True)
            await asyncio.to_thread(shutil.rmtree, backup, ignore_errors=True)

    async def _validate(self, root, manifest):
        before = await asyncio.to_thread(self._fingerprint, root, manifest)
        worker = CustomWorkerClient(root)
        try:
            metadata = await worker.call("describe")
            report = await worker.call("validate", timeout=1500)
        finally:
            await worker.close()
        after = await asyncio.to_thread(self._fingerprint, root, manifest)
        if before != after:
            report["ok"] = False
            report.setdefault("checks", []).append({"name": "unchanged_during_validation", "status": "failed"})
        report.update(**before, validated_path=str(root), engine_id=manifest["id"], version=metadata.get("version"),
                      tested_at=datetime.now(timezone.utc).isoformat(), metadata=metadata)
        report["signature"] = await asyncio.to_thread(self._seal, report)
        await asyncio.to_thread(self._write_json, root / "validation.json", report)
        return report

    @staticmethod
    def _write_json(file, value):
        temporary = file.with_name(f".{file.name}.{uuid.uuid4().hex}.tmp")
        temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.chmod(0o600)
        os.replace(temporary, file)

    async def register(self, path, *, replace=False):
        root, manifest = await asyncio.to_thread(self._load, path)
        lock = self.locks.setdefault(manifest["id"], asyncio.Lock())
        async with lock:
            target = self.root() / manifest["id"]
            if await asyncio.to_thread(target.exists) and root != target and not replace:
                raise ValueError("Engine has been connected; update must specify replace")
            def verified():
                file = root / "validation.json"
                if not file.is_file():
                    raise ValueError("Please complete the public acceptance first")
                report = json.loads(file.read_text())
                if not hmac.compare_digest(str(report.get("signature", "")), self._seal(report)):
                    raise ValueError("The acceptance report signature is invalid. Please re-accept.")
                if report.get("ok") is not True or report.get("api_version") != 1:
                    raise ValueError("Public acceptance failed")
                current = self._fingerprint(root, manifest)
                if any(report.get(key) != value for key, value in current.items()):
                    raise ValueError("Acceptance has expired, please re-accept")
                if not report.get("metadata", {}).get("installed"):
                    raise ValueError("Actual runtime environment has not passed acceptance")
                return report
            report = await asyncio.to_thread(verified)
            await self._close_cached_workers(target)
            from engines.core.custom_transport import ACTIVE_CLIENTS
            if any(client.root == target and not client.closed for client in ACTIVE_CLIENTS):
                raise ValueError("Engine is running, cannot replace adapter")
            def copy():
                self.root().mkdir(parents=True, exist_ok=True)
                metadata = dict(report["metadata"], package_digest=report["package_digest"])
                binary = metadata.get("binary_path")
                validated_root = Path(report.get("validated_path", str(root)))
                if binary and Path(binary).is_relative_to(validated_root):
                    metadata["binary_path"] = str(target / Path(binary).relative_to(validated_root))
                if root == target:
                    self._write_json(target / "installation.json", metadata)
                    return
                stage = self.root() / f".stage-{uuid.uuid4().hex}"
                backup = self.root() / f".previous-{manifest['id']}"
                try:
                    stage.mkdir()
                    for name in exported_files(root, manifest):
                        destination = stage / name
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(safe_file(root, name), destination)
                    if (root / "dependencies").exists():
                        shutil.copytree(root / "dependencies", stage / "dependencies", symlinks=True)
                    self._write_json(stage / "validation.json", report)
                    self._write_json(stage / "installation.json", metadata)
                    if digest(stage, manifest, dependencies=True) != report["package_digest"]:
                        raise ValueError("File changed during copy, validation failed")
                    if backup.exists():
                        shutil.rmtree(backup)
                    if target.exists():
                        target.rename(backup)
                    try:
                        stage.rename(target)
                    except Exception:
                        if backup.exists():
                            backup.rename(target)
                        raise
                finally:
                    shutil.rmtree(stage, ignore_errors=True)
            await asyncio.to_thread(copy)
            await asyncio.to_thread(config_store.set_engine_verified, manifest["id"], True)
            return {"ok": True, "engine_id": manifest["id"], "path": str(target), "restart_required": False, "refresh_required": True}

    async def disable(self, engine_id, disabled=True):
        import re
        if not re.fullmatch(r"[a-z][a-z0-9_]{0,63}", engine_id):
            raise ValueError("Invalid engine ID")
        def save():
            if not (self.root() / engine_id / "manifest.json").is_file():
                raise ValueError("Custom engine does not exist")
            with config_store._lock:
                values = set(config_store.get("disabled_custom_engines", []))
                if disabled:
                    values.add(engine_id)
                else:
                    values.discard(engine_id)
                config_store.set("disabled_custom_engines", sorted(values))
        await asyncio.to_thread(save)
        if disabled:
            await self._close_cached_workers(self.root() / engine_id, include_busy=True)
        from engines.core.custom_transport import ACTIVE_CLIENTS
        for client in list(ACTIVE_CLIENTS):
            if client.root == self.root() / engine_id and disabled:
                await client.close()
        from engines.core.registry import refresh_registry
        await asyncio.to_thread(refresh_registry)
        return {"ok": True, "engine_id": engine_id, "disabled": disabled}

    async def rollback(self, engine_id):
        import re
        if not re.fullmatch(r"[a-z][a-z0-9_]{0,63}", engine_id):
            raise ValueError("Invalid engine ID")
        target = self.root() / engine_id
        backup = self.root() / f".previous-{engine_id}"
        await self._close_cached_workers(target)
        from engines.core.custom_transport import ACTIVE_CLIENTS
        if any(client.root == target and not client.closed for client in ACTIVE_CLIENTS):
            raise ValueError("Engine is running")
        def swap():
            if not backup.is_dir():
                raise ValueError("No previous version")
            temporary = self.root() / f".rollback-{uuid.uuid4().hex}"
            target.rename(temporary)
            try:
                backup.rename(target)
            except Exception:
                temporary.rename(target)
                raise
            temporary.rename(backup)
        await asyncio.to_thread(swap)
        await asyncio.to_thread(config_store.set_engine_verified, engine_id, False)
        return {"ok": True, "restart_required": True}

    async def export(self, engine_id):
        import re
        if not re.fullmatch(r"[a-z][a-z0-9_]{0,63}", engine_id):
            raise ValueError("Invalid engine ID")
        def pack():
            root, manifest = self._load(self.root() / engine_id)
            buffer = io.BytesIO()
            with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
                total = 0
                for name in exported_files(root, manifest):
                    source = safe_file(root, name)
                    total += source.stat().st_size
                    if total > 32 * 1024 * 1024:
                        raise ValueError("Adaptation package source code and resources exceed 32 MiB")
                    if source.name in {"auth.json", "config.json", ".env", "credentials.json"}:
                        raise ValueError("Authentication and local profile cannot be exported")
                    archive.write(source, name)
                # Only safe summary fields; never include full diagnostics/config.
                report = root / "validation.json"
                if report.is_file():
                    data = json.loads(report.read_text())
                    safe = {key: data.get(key) for key in ("api_version", "engine_id", "version", "tested_at", "observed_events", "declared_events")}
                    archive.writestr("validation-summary.json", json.dumps(safe, ensure_ascii=False))
            return buffer.getvalue()
        return await asyncio.to_thread(pack)

    async def shutdown(self):
        for task in list(self.tasks.values()):
            task.cancel()
        await asyncio.gather(*list(self.tasks.values()), return_exceptions=True)
        from engines.core.custom_transport import ACTIVE_CLIENTS
        await asyncio.gather(*(client.close() for client in list(ACTIVE_CLIENTS)), return_exceptions=True)


custom_engine_manager = CustomEngineManager()
