"""Metadata-only custom engine discovery and isolated AcpEngineBase proxies."""
import asyncio
from contextlib import suppress
from dataclasses import fields
import json
import logging
import os
from pathlib import Path

from engines.core.acp_base import AcpEngineBase
from engines.core.base import EngineCapabilities, EngineModel, EngineSkillPolicy
from engines.core.custom_package import load_manifest, declared_events, EXTENSION_EVENTS
from engines.core.custom_sdk import raw_config
from engines.core.custom_transport import CustomWorkerClient
from engines.core.events import InternalEvent
from engines.core.schema import EngineConfigField, EngineConfigOption
from services.config import config_store

logger = logging.getLogger(__name__)


def custom_root():
    from services.config import CONFIG_DIR
    return CONFIG_DIR / "runtime" / "engines"


def schema_fields(metadata):
    result = []
    for field in metadata.get("config", {}).get("fields", []):
        item = dict(field)
        if item.get("options") is not None:
            item["options"] = tuple(EngineConfigOption(**option) for option in item["options"])
        item["confirm_values"] = tuple(item.get("confirm_values") or ())
        result.append(EngineConfigField(**item))
    return result


class CustomEngineProxy(AcpEngineBase):
    _root: Path
    _metadata: dict

    def __init__(self):
        super().__init__()
        self._worker = None
        self._worker_lock = asyncio.Lock()
        self._idle_cleanup = None

    @classmethod
    def is_installed(cls):
        disabled = config_store.get("disabled_custom_engines", [])
        return bool(cls._metadata.get("installed")) and cls.ENGINE_ID not in disabled

    @classmethod
    def is_configured(cls):
        values = raw_config(cls.ENGINE_ID)
        return all(not field.required or bool(values.get(field.key, field.default))
                   for field in cls.config_schema())

    @classmethod
    def get_version(cls):
        return cls._metadata.get("version")

    @classmethod
    def resolve_binary(cls):
        return cls.get_binary_override() or cls._metadata.get("binary_path")

    @classmethod
    def config_schema(cls):
        return schema_fields(cls._metadata)

    @classmethod
    def supported_provider_protocols(cls):
        return set(cls._metadata.get("provider_protocols", []))

    @classmethod
    def provider_required(cls):
        return bool(cls._metadata.get("provider_required"))

    def get_config_values(self):
        values = raw_config(self.ENGINE_ID)
        return {field.key: "" if field.sensitive or field.type == "password"
                else values.get(field.key, field.default) for field in self.config_schema()}

    def get_config_secrets(self):
        values = raw_config(self.ENGINE_ID)
        return {field.key: bool(values.get(field.key)) for field in self.config_schema()
                if field.sensitive or field.type == "password"}

    def reveal_config_value(self, key):
        if key not in {field.key for field in self.config_schema() if field.sensitive or field.type == "password"}:
            return None
        return raw_config(self.ENGINE_ID).get(key)

    async def save_config_values(self, values, clear=None, confirmed=None):
        def save():
            with config_store._lock:
                previous = raw_config(self.ENGINE_ID)
                declared = {field.key: field for field in self.config_schema()}
                if set(values) - declared.keys():
                    raise ValueError("未知引擎配置字段")
                for key, field in declared.items():
                    if (clear or {}).get(key):
                        previous.pop(key, None)
                        continue
                    if key not in values or ((field.sensitive or field.type == "password") and not values[key]):
                        continue
                    value = values[key]
                    if field.confirm_values and value in field.confirm_values and not (confirmed or {}).get(key):
                        raise ValueError("此配置值需要确认")
                    if field.options and value not in {option.value for option in field.options}:
                        raise ValueError("配置选项无效")
                    if field.type == "number":
                        value = float(value)
                    elif field.type == "checkbox":
                        if value not in {True, False, "true", "false"}:
                            raise ValueError("复选框配置无效")
                        value = value is True or value == "true"
                    elif field.type == "json" and isinstance(value, str) and value:
                        json.loads(value)
                    previous[key] = value
                if any(field.required and not previous.get(field.key, field.default) for field in declared.values()):
                    raise ValueError("请补全必填配置")
                all_values = dict(config_store.get("custom_engine_config", {}))
                all_values[self.ENGINE_ID] = previous
                config_store.set("custom_engine_config", all_values)
                config_store.set_engine_verified(self.ENGINE_ID, False)
        await asyncio.to_thread(save)

    @property
    def capabilities(self):
        valid = {field.name for field in fields(EngineCapabilities)}
        values = {key: bool(value) for key, value in self._metadata.get("capabilities", {}).items() if key in valid}
        for key in ("supports_coordinator", "supports_resume", "supports_tool_disable", "supports_native_schema", "supports_live_step_message"):
            values.setdefault(key, False)
        return EngineCapabilities(**values)

    @property
    def skill_policy(self):
        return EngineSkillPolicy(self._metadata.get("skill_policy", "unsupported"))

    async def _client(self):
        idle = self._idle_cleanup
        if idle and idle is not asyncio.current_task():
            idle.cancel()
            self._idle_cleanup = None
        async with self._worker_lock:
            if not await asyncio.to_thread(self.is_installed):
                raise RuntimeError("自定义引擎未安装或已停用")
            if self._worker is None or self._worker.closed:
                expected = self._metadata.get("package_digest")
                if expected:
                    from engines.core.custom_package import digest
                    actual = await asyncio.to_thread(lambda: digest(self._root, load_manifest(self._root), dependencies=True))
                    if actual != expected:
                        raise RuntimeError("引擎文件或依赖已变化，请重新验收注册")
                self._worker = CustomWorkerClient(self._root)
            return self._worker

    async def _call(self, method, args=(), kwargs=None):
        client = await self._client()
        try:
            return await client.call(method, args, kwargs)
        except BaseException:
            await client.close()
            self._worker = None
            raise

    async def _stream(self, method, kwargs):
        client = await self._client()
        live_queue = kwargs.pop("live_message_queue", None)
        if live_queue is not None:
            kwargs["_live_queue"] = True
        pump = None
        self._running = True
        try:
            if live_queue is not None:
                await client.call("prepare_live_queue")
                async def forward():
                    while True:
                        item = await live_queue.get()
                        await client.call("live_queue", kwargs={"item": item})
                pump = asyncio.create_task(forward())
            async for message in client.stream(method, kwargs=kwargs):
                if "event" in message:
                    item = message["event"]
                    if not isinstance(item, dict) or item.get("type") not in declared_events(self):
                        raise ValueError("工作进程产生无效或未声明事件")
                    event = InternalEvent(type=item["type"], data=item.get("data", {}), timestamp=item.get("timestamp", 0))
                    from engines.core.custom_validation import check_event
                    check_event(event, declared_events(self))
                    yield event
        except Exception:
            await client.close()
            self._worker = None
            yield InternalEvent("error", {"message": "自定义引擎工作进程执行失败，请查看接入验收结果"})
        finally:
            self._running = False
            if pump:
                pump.cancel()
                with suppress(asyncio.CancelledError, Exception):
                    await pump
            # End-of-turn cleanup must not leave SDK clients/descendants alive.
            await client.close()
            self._worker = None

    async def spawn(self, prompt, cwd, model=None, session_id=None, images=None, **kwargs):
        async for event in self._stream("spawn", dict(prompt=prompt, cwd=cwd, model=model,
                                                    session_id=session_id, images=images, **kwargs)):
            yield event

    async def spawn_coordinator(self, prompt, cwd, **kwargs):
        async for event in self._stream("spawn_coordinator", dict(prompt=prompt, cwd=cwd, **kwargs)):
            yield event

    def _schedule_idle_cleanup(self):
        async def cleanup():
            await asyncio.sleep(30)
            await self.stop()
        self._idle_cleanup = asyncio.create_task(cleanup())

    async def stop(self):
        idle = self._idle_cleanup
        self._idle_cleanup = None
        if idle and idle is not asyncio.current_task():
            idle.cancel()
        worker = self._worker
        if worker:
            with suppress(Exception):
                await worker.call("stop", timeout=2)
            await worker.close()
            self._worker = None
        self._running = False

    async def list_models(self, cwd):
        values = await self._call("list_models", kwargs={"cwd": cwd})
        await self.stop()
        return [EngineModel(**value) for value in values]

    async def inspect_capabilities(self, project_root=None):
        result = await self._call("inspect_capabilities", kwargs={"project_root": project_root})
        await self.stop()
        return result

    async def install(self):
        # Install is routed to the shared manager so dependency updates are atomic.
        from services.custom_engines import custom_engine_manager
        from engines.core.base import EngineInstallResult
        result = await custom_engine_manager.run_operation("install", str(self._root))
        return EngineInstallResult(result.get("ok", False), "自定义引擎依赖安装完成" if result.get("ok") else "自定义引擎依赖安装失败")

    def build_resume_params(self, session_id):
        return {"session_id": session_id} if self.supports_resume else {}


def make_custom_engine(root: Path, metadata: dict):
    info = dict(metadata)
    namespace = {"ENGINE_ID": info["id"], "_root": root, "_metadata": info,
                 "workstep_events": frozenset(info.get("workstep_events", ())),
                 "acp_events": frozenset(info.get("acp_events", {"error"})),
                 "SYSTEM_PROMPT_MODE": info.get("system_prompt_mode", "body")}
    properties = {**info.get("properties", {}), **info.get("capabilities", {})}
    for name, value in properties.items():
        if name.startswith("supports_"):
            namespace[name] = property(lambda self, value=bool(value): value)
    cls = type(f"Custom_{info['id']}", (CustomEngineProxy,), namespace)
    return cls


# Generic methods retain their original argument shapes at the IPC boundary.
for _method in ("inject_response", "approve_tool", "approve_tool_option", "respond_interaction",
                "create_session", "load_session", "list_sessions", "resume_session", "fork_session",
                "close_session", "cancel_session", "set_config_option", "set_session_mode", "reset_options",
                "send_live_step_message", "send_live_stage_message", "set_permission_mode"):
    def make_method(name):
        async def invoke(self, *args, **kwargs):
            if name == "set_permission_mode":
                await AcpEngineBase.set_permission_mode(self, *args, **kwargs)
            result = await self._call(name, args, kwargs)
            if not self._running:
                if name in {"create_session", "load_session", "resume_session", "fork_session", "set_config_option", "set_session_mode", "reset_options", "set_permission_mode"}:
                    self._schedule_idle_cleanup()
                else:
                    await self.stop()
            return result
        return invoke
    setattr(CustomEngineProxy, _method, make_method(_method))


def discover_custom_engines():
    if os.environ.get("WORKSTEP_CUSTOM_WORKER") == "1" or os.environ.get("WORKSTEP_SKIP_CUSTOM_ENGINES") == "1":
        return {}
    root = custom_root()
    if not root.is_dir():
        return {}
    found = {}
    for target in sorted(root.iterdir()):
        if target.name.startswith(".") or not target.is_dir() or target.is_symlink():
            continue
        try:
            manifest = load_manifest(target)
            if manifest["id"] != target.name:
                raise ValueError("目录与引擎 ID 不一致")
            receipt = target / "installation.json"
            metadata = json.loads(receipt.read_text()) if receipt.is_file() and receipt.stat().st_size <= 256 * 1024 else {}
            if not isinstance(metadata, dict):
                raise ValueError("安装元数据无效")
            if metadata.get("installed") and (not isinstance(metadata.get("package_digest"), str) or len(metadata["package_digest"]) != 64):
                raise ValueError("缺少安装指纹")
            if not isinstance(metadata.get("version"), (str, type(None))):
                raise ValueError("版本元数据无效")
            if not isinstance(metadata.get("provider_protocols", []), list) or not all(isinstance(item, str) for item in metadata.get("provider_protocols", [])):
                raise ValueError("供应商元数据无效")
            metadata.update(id=manifest["id"], mode=manifest["mode"], name=manifest["name"], description=manifest.get("description", ""), custom=True)
            # Invalid/incomplete installs still have an unavailable settings card.
            metadata.setdefault("installed", False)
            cls = make_custom_engine(target, metadata)
            if not cls.workstep_events <= EXTENSION_EVENTS:
                raise ValueError("扩展事件元数据无效")
            cls.config_schema()
            cls().capabilities
            found[manifest["id"]] = cls
        except Exception:
            logger.warning("自定义引擎清单无效，已跳过：%s", target.name)
    return found
