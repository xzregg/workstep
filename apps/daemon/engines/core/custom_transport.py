"""Bounded asynchronous RPC transport with process-tree cleanup."""
import asyncio
from contextlib import suppress
from dataclasses import asdict, is_dataclass
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import uuid
import weakref

from engines.core.stream_lines import ChunkedLineReader
from services.config import config_store

ACTIVE_CLIENTS = weakref.WeakSet()

MAX_RESPONSE_BYTES = 16 * 1024 * 1024


def serialize(value):
    if is_dataclass(value):
        return serialize(asdict(value))
    if isinstance(value, dict):
        return {key: serialize(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [serialize(item) for item in value]
    if isinstance(value, Path):
        return str(value)
    return value


class CustomWorkerClient:
    def __init__(self, root: Path, *, dependencies: Path | None = None):
        ACTIVE_CLIENTS.add(self)
        self.root = root
        self.dependencies = dependencies
        self.process = None
        self.pending = {}
        self.reader_task = None
        self.stderr_task = None
        self.start_lock = asyncio.Lock()
        self.write_lock = asyncio.Lock()
        self.closed = False

    async def start(self):
        async with self.start_lock:
            if self.closed:
                raise RuntimeError("引擎工作进程已关闭")
            if self.process is not None:
                if self.process.returncode is not None:
                    raise RuntimeError("引擎工作进程已退出")
                return
            worker = Path(__file__).with_name("custom_worker.py")
            env = dict(os.environ)
            env["WORKSTEP_CUSTOM_WORKER"] = "1"
            env["WORKSTEP_CUSTOM_ENGINE_DIR"] = str(self.root)
            if self.dependencies:
                env["WORKSTEP_CUSTOM_DEPENDENCIES"] = str(self.dependencies)
            dependencies = self.dependencies or self.root / "dependencies"
            node_prefix = dependencies / "node"
            node_bin = node_prefix if os.name == "nt" else node_prefix / "bin"
            env["NPM_CONFIG_PREFIX"] = str(node_prefix)
            env["NODE_PATH"] = str(node_prefix / "lib" / "node_modules") if os.name != "nt" else str(node_prefix / "node_modules")
            env["PATH"] = os.pathsep.join([str(node_bin), str(dependencies / "bin"), env.get("PATH", "")])
            options = {"start_new_session": True} if os.name != "nt" else {
                "creationflags": subprocess.CREATE_NEW_PROCESS_GROUP,
            }
            self.process = await asyncio.create_subprocess_exec(
                sys.executable, "-u", str(worker), str(self.root), env=env,
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE, **options,
            )
            self.reader_task = asyncio.create_task(self._read())
            self.stderr_task = asyncio.create_task(self._drain_stderr())

    async def _drain_stderr(self):
        # Never retain user diagnostics: arbitrary SDK logs may contain secrets.
        while await self.process.stderr.read(65536):
            pass

    async def _read(self):
        error = "引擎工作进程已退出"
        try:
            async for line in ChunkedLineReader(self.process.stdout, max_line_bytes=MAX_RESPONSE_BYTES):
                if len(line) > MAX_RESPONSE_BYTES:
                    raise ValueError("响应过大")
                message = json.loads(line)
                if not isinstance(message, dict) or message.get("id") not in self.pending:
                    raise ValueError("响应协议无效")
                queue = self.pending[message["id"]]
                if queue.qsize() >= 1024:
                    raise ValueError("引擎输出超过接收能力")
                queue.put_nowait(message)
        except Exception:
            error = "引擎工作进程响应协议无效"
        finally:
            for key, queue in self.pending.items():
                queue.put_nowait({"id": key, "error": error})

    async def stream(self, method, args=(), kwargs=None, *, timeout=None):
        await self.start()
        key = uuid.uuid4().hex
        queue = asyncio.Queue()
        self.pending[key] = queue
        try:
            snapshot = await asyncio.to_thread(lambda: dict(config_store._load()))
            snapshot.pop("custom_validation_key", None)
            request = {"protocol": 1, "id": key, "method": method,
                       "args": serialize(args), "kwargs": serialize(kwargs or {}), "config": snapshot}
            payload = (json.dumps(request, ensure_ascii=False, allow_nan=False) + "\n").encode()
            if len(payload) > 8 * 1024 * 1024:
                raise ValueError("引擎请求过大")
            async with self.write_lock:
                self.process.stdin.write(payload)
                await self.process.stdin.drain()
            while True:
                message = await asyncio.wait_for(queue.get(), timeout) if timeout else await queue.get()
                if "error" in message:
                    # Return type and method only, never arbitrary adapter text.
                    kind = str(message["error"]).split(":", 1)[0]
                    if kind not in {"ValueError", "TypeError", "RuntimeError", "ImportError", "ModuleNotFoundError", "AssertionError", "TimeoutError", "OSError"}:
                        kind = "worker error"
                    if len(kind) > 80 or any(c in kind for c in "\n\r"):
                        kind = "worker error"
                    raise RuntimeError(f"自定义引擎 {method} 失败（{kind}）")
                yield message
                if "result" in message:
                    break
        except (asyncio.CancelledError, TimeoutError):
            await self.close()
            raise
        finally:
            self.pending.pop(key, None)

    async def call(self, method, args=(), kwargs=None, *, timeout=15):
        async for message in self.stream(method, args, kwargs, timeout=timeout):
            if "result" in message:
                return message["result"]

    async def close(self):
        self.closed = True
        process = self.process
        if process is not None:
            if os.name == "nt":
                with suppress(Exception):
                    killer = await asyncio.create_subprocess_exec(
                        "taskkill", "/PID", str(process.pid), "/T", "/F",
                        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
                    )
                    await asyncio.wait_for(killer.wait(), 5)
            else:
                with suppress(ProcessLookupError):
                    os.killpg(process.pid, signal.SIGKILL)
            with suppress(Exception):
                await asyncio.wait_for(process.wait(), 5)
        current = asyncio.current_task()
        for task in (self.reader_task, self.stderr_task):
            if task and task is not current:
                task.cancel()
                with suppress(asyncio.CancelledError, Exception):
                    await task
        for key, queue in self.pending.items():
            queue.put_nowait({"id": key, "error": "工作进程已停止"})
