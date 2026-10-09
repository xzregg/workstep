"""User adapter process. Never imported by the daemon for discovery."""
import asyncio
from contextlib import suppress
from dataclasses import asdict, is_dataclass
import importlib.util
import inspect
import json
import os
from pathlib import Path
import sys

# Executed as a script so the bundled daemon sources are always importable.
DAEMON_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(DAEMON_ROOT))
os.environ["WORKSTEP_CUSTOM_WORKER"] = "1"
PROTOCOL_OUTPUT = sys.stdout
sys.stdout = sys.stderr

from engines.core.acp_base import AcpEngineBase, ACP_EVENTS
from engines.core.events import InternalEvent
from engines.core.custom_package import load_manifest, package_root, EXTENSION_EVENTS, declared_events
from engines.core.schema import EngineImage
from services.config import config_store

ALLOWED_METHODS = frozenset({
    "spawn", "spawn_coordinator", "stop", "inject_response", "approve_tool", "approve_tool_option",
    "respond_interaction", "create_session", "load_session", "list_sessions", "resume_session",
    "fork_session", "close_session", "cancel_session", "set_config_option", "set_session_mode",
    "reset_options", "send_live_stage_message", "send_live_step_message", "list_models",
    "inspect_capabilities", "set_permission_mode", "test_connection", "install",
})
EXTRA_PROPERTIES = ("supports_message_history", "supports_interactive", "supports_resume",
                    "supports_sessions", "supports_tool_approval", "supports_live_stage_message")


def plain(value):
    if is_dataclass(value):
        return plain(asdict(value))
    if isinstance(value, dict):
        return {key: plain(item) for key, item in value.items()}
    if isinstance(value, (tuple, list, set, frozenset)):
        return [plain(item) for item in value]
    if isinstance(value, Path):
        return str(value)
    return value


def load_adapter(root, manifest):
    deps = Path(os.environ.get("WORKSTEP_CUSTOM_DEPENDENCIES", str(root / "dependencies")))
    # WorkStep's own modules win; user dependencies are isolated to this process.
    sys.path.insert(1, str(root))
    sys.path.insert(1, str(deps / "python"))
    sys.path.insert(1, str(deps))
    spec = importlib.util.spec_from_file_location("workstep_user_adapter", root / manifest["entry"])
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    cls = getattr(module, manifest["class_name"], None)
    if not isinstance(cls, type) or not issubclass(cls, AcpEngineBase) or cls.ENGINE_ID != manifest["id"]:
        raise ValueError("适配器必须继承 AcpEngineBase 且 ENGINE_ID 与清单一致")
    cls.set_binary_override(config_store.get_engine_binary_path(manifest["id"]) or None)
    engine = cls()
    if not isinstance(getattr(engine, "_pending_approvals", None), dict):
        raise ValueError("构造函数必须调用 super().__init__()")
    return engine


def describe(engine, manifest):
    schema = [asdict(field) for field in engine.config_schema()]
    keys = [field["key"] for field in schema]
    if len(keys) != len(set(keys)) or any(not key for key in keys):
        raise ValueError("配置字段 key 不能为空或重复")
    if any((field["sensitive"] or field["type"] == "password") and field["default"] for field in schema):
        raise ValueError("敏感配置不能包含默认值")
    supported_types = {"text", "password", "select", "textarea", "json", "number", "checkbox", "model_map"}
    if any(field["type"] not in supported_types for field in schema):
        raise ValueError("配置字段类型不受支持")
    events = set(engine.acp_events)
    if not events or not events <= set(ACP_EVENTS):
        raise ValueError("acp_events 必须声明有效事件集合")
    if not engine._is_acp_native and events == set(ACP_EVENTS):
        raise ValueError("非 ACP 原生引擎不能宣称支持全部事件")
    for name in ALLOWED_METHODS:
        if not callable(getattr(engine, name, None)):
            # Legacy live-stage name is optional; step live-message is canonical.
            if name != "send_live_stage_message":
                raise ValueError(f"缺少接口：{name}")
    signature = inspect.signature(engine.spawn)
    for key in ("prompt", "cwd", "model", "session_id", "images", "config_overrides"):
        if key not in signature.parameters and not any(p.kind == p.VAR_KEYWORD for p in signature.parameters.values()):
            raise ValueError(f"spawn 缺少参数：{key}")
    extensions = set(getattr(engine, "workstep_events", ()))
    if not extensions <= EXTENSION_EVENTS:
        raise ValueError("WorkStep 扩展事件声明无效")
    caps = asdict(engine.capabilities)
    if caps.get("supports_tool_approval") and "interaction_request" not in events:
        raise ValueError("审批能力必须声明 interaction_request")
    return {
        "id": manifest["id"], "name": manifest["name"], "description": manifest.get("description", ""),
        "mode": manifest["mode"], "custom": True, "installed": bool(engine.is_installed()),
        "configured": bool(engine.is_configured()), "version": engine.get_version(),
        "binary_path": engine.resolve_binary(), "capabilities": caps,
        "properties": {key: bool(getattr(engine, key, False)) for key in EXTRA_PROPERTIES},
        "workstep_events": sorted(extensions),
        "acp_events": sorted(events), "provider_protocols": sorted(engine.supported_provider_protocols()),
        "provider_required": engine.provider_required(), "system_prompt_mode": engine.SYSTEM_PROMPT_MODE,
        "config": {"fields": schema}, "installable": True,
        "skill_policy": engine.skill_policy.value,
        "supports_controlled_skills": engine.supports_controlled_skills,
    }


class Worker:
    def __init__(self, root, manifest):
        self.root, self.manifest = root, manifest
        self.engine = None
        self.output_lock = asyncio.Lock()
        self.init_lock = asyncio.Lock()
        self.turns = {}
        self.live_queue = None

    async def send(self, value):
        line = json.dumps(plain(value), ensure_ascii=False, allow_nan=False) + "\n"
        async with self.output_lock:
            def write():
                PROTOCOL_OUTPUT.write(line)
                PROTOCOL_OUTPUT.flush()
            await asyncio.to_thread(write)

    async def request(self, request):
        key = request["id"]
        try:
            # One engine instance per worker, maintained across session methods.
            async with self.init_lock:
                if self.engine is None:
                    config_store._cache = request.get("config", {})
                    self.engine = await asyncio.to_thread(load_adapter, self.root, self.manifest)
                elif request.get("config") is not None and request.get("method") not in {"live_queue", "stop"}:
                    config_store._cache = request["config"]
            method = request["method"]
            if method == "describe":
                result = await asyncio.to_thread(describe, self.engine, self.manifest)
            elif method == "validate":
                from engines.core.custom_validation import validate_adapter
                result = await validate_adapter(self.engine, self.root, self.manifest)
            elif method == "prepare_live_queue":
                self.live_queue = asyncio.Queue()
                result = True
            elif method == "live_queue":
                if self.live_queue is None:
                    raise ValueError("没有活跃的消息队列")
                await self.live_queue.put(request.get("kwargs", {}).get("item"))
                result = True
            elif method in ALLOWED_METHODS:
                kwargs = dict(request.get("kwargs") or {})
                args = request.get("args") or []
                if kwargs.get("images") is not None:
                    kwargs["images"] = [EngineImage(**item) for item in kwargs["images"]]
                if kwargs.pop("_live_queue", False):
                    if self.live_queue is None:
                        self.live_queue = asyncio.Queue()
                    kwargs["live_message_queue"] = self.live_queue
                function = getattr(self.engine, method)
                inspect.signature(function).bind(*args, **kwargs)
                if inspect.isasyncgenfunction(function):
                    async for event in function(*args, **kwargs):
                        if not isinstance(event, InternalEvent):
                            raise ValueError("引擎必须返回 InternalEvent")
                        if event.type not in declared_events(self.engine):
                            raise ValueError(f"产生未声明事件：{event.type}")
                        await self.send({"id": key, "event": event.to_dict()})
                    result = None
                elif inspect.iscoroutinefunction(function):
                    result = await function(*args, **kwargs)
                else:
                    result = await asyncio.to_thread(function, *args, **kwargs)
                if method == "stop":
                    for turn_key, task in list(self.turns.items()):
                        if turn_key != key and not task.done():
                            task.cancel()
            else:
                raise ValueError("不支持的工作进程方法")
            await self.send({"id": key, "result": plain(result)})
        except asyncio.CancelledError:
            await self.send({"id": key, "error": "操作已停止"})
        except Exception as exc:
            # Diagnostics stay in the worker; parent uses a redacted error.
            await self.send({"id": key, "error": f"{type(exc).__name__}: {exc}"})
        finally:
            self.turns.pop(key, None)

    async def run(self):
        try:
            while True:
                line = await asyncio.to_thread(sys.stdin.readline, 8 * 1024 * 1024)
                if not line:
                    break
                request = json.loads(line)
                if request.get("protocol") != 1 or not isinstance(request.get("id"), str):
                    raise ValueError("工作进程协议无效")
                task = asyncio.create_task(self.request(request))
                self.turns[request["id"]] = task
        finally:
            for task in self.turns.values():
                task.cancel()
            if self.engine is not None:
                with suppress(Exception):
                    await asyncio.wait_for(self.engine.stop(), 2)


if __name__ == "__main__":
    root = package_root(sys.argv[1])
    os.environ["WORKSTEP_CUSTOM_ENGINE_DIR"] = str(root)
    manifest = load_manifest(root)
    asyncio.run(Worker(root, manifest).run())
