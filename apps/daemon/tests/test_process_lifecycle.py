"""Real test-owned PIDs expose partial-start and cleanup cancellation gaps."""
import asyncio
import os
from pathlib import Path
import subprocess
import sys
from types import ModuleType, SimpleNamespace as N

import psutil
import pytest

from engines.codex_sdk_clients import CodexClientPool
from services.speech_runtime import SpeechRuntime


def alive(process):
    try:
        return process.is_running() and process.status() != psutil.STATUS_ZOMBIE
    except psutil.NoSuchProcess:
        return False


async def dispose(process):
    if alive(process):
        process.kill()
    await asyncio.to_thread(process.wait, 3)


@pytest.mark.anyio
async def test_codex_pool_reaps_owned_descendant_after_sdk_only_closes_parent(tmp_path):
    script = "import subprocess,sys,time; p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(120)'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); print(p.pid,flush=True); time.sleep(120)"
    proc = await asyncio.to_thread(subprocess.Popen, [sys.executable, '-u', '-c', script], stdout=subprocess.PIPE, text=True)
    child_pid = int(await asyncio.to_thread(proc.stdout.readline))
    child = psutil.Process(child_pid)
    child.create_time()
    class Client:
        def __init__(self):
            self._client = N(_sync=N(_proc=proc))
        async def close(self):
            self._client._sync._proc = None
            proc.terminate()
            await asyncio.to_thread(proc.wait, 3)
    pool = CodexClientPool()
    try:
        await pool.acquire(str(tmp_path), 'a', 'same', Client)
        await pool.close()
        assert not alive(child), 'SDK closed root but left its owned descendant alive'
    finally:
        await dispose(child)
        if proc.poll() is None:
            proc.kill()
        await asyncio.to_thread(proc.wait)


@pytest.mark.anyio
async def test_codex_pool_reaps_root_even_if_sdk_close_raises(tmp_path):
    proc = await asyncio.to_thread(subprocess.Popen, [sys.executable, '-c', 'import time;time.sleep(120)'])
    class Client:
        def __init__(self):
            self._client = N(_sync=N(_proc=proc))
        async def close(self):
            raise RuntimeError('synthetic close failure')
    pool = CodexClientPool()
    try:
        await pool.acquire(str(tmp_path), 'a', 'same', Client)
        await pool.close()
        assert proc.poll() is not None, 'failed SDK close left root alive'
    finally:
        if proc.poll() is None:
            proc.kill()
        await asyncio.to_thread(proc.wait)


@pytest.mark.anyio
async def test_speech_close_during_worker_creation_reaps_late_process(monkeypatch, tmp_path):
    worker = tmp_path / 'speech.py'
    worker.write_text("import sys,json\nfor line in sys.stdin:\n r=json.loads(line);print(json.dumps({'session_id':r['session_id'],'text':'ok'}),flush=True)\n")
    original = asyncio.create_subprocess_exec
    started, release = asyncio.Event(), asyncio.Event()
    processes = []
    async def delayed(*args, **kwargs):
        proc = await original(*args, **kwargs)
        processes.append(proc)
        started.set()
        await release.wait()
        return proc
    monkeypatch.setattr(asyncio, 'create_subprocess_exec', delayed)
    runtime = SpeechRuntime()
    infer = asyncio.create_task(runtime.infer([sys.executable, '-u', str(worker)], b'', 'a', True))
    closing = None
    try:
        await asyncio.wait_for(started.wait(), 2)
        closing = asyncio.create_task(runtime.close())
        await asyncio.sleep(0)
        release.set()
        await infer
        await asyncio.sleep(0.1)
        assert closing.done(), 'close waited for late worker without terminating it'
        await closing
        assert processes[0].returncode is not None
    finally:
        release.set()
        for p in processes:
            if p.returncode is None:
                p.kill()
            await p.wait()
        await asyncio.gather(infer, *([closing] if closing else []), return_exceptions=True)


@pytest.mark.anyio
@pytest.mark.parametrize('kind', ['claude', 'qoder'])
@pytest.mark.parametrize('failure', ['exception', 'cancel'])
async def test_sdk_partial_connect_always_disconnects_owned_process(monkeypatch, tmp_path, kind, failure):
    from engines.claude_agent_sdk import ClaudeAgentSDKEngine
    from engines.qoder_sdk import QoderSDKEngine
    from engines.core.base import ProviderRuntimeConfig
    engine_type = ClaudeAgentSDKEngine if kind == 'claude' else QoderSDKEngine
    module_name = 'claude_agent_sdk' if kind == 'claude' else 'qoder_agent_sdk'
    sdk = ModuleType(module_name)
    started = asyncio.Event()
    clients = []
    class Client:
        def __init__(self, **kwargs):
            self.proc = None
            clients.append(self)
        async def connect(self):
            self.proc = await asyncio.create_subprocess_exec(sys.executable, '-c', 'import time;time.sleep(120)')
            self._transport = N(_process=self.proc)
            started.set()
            if failure == 'exception':
                raise RuntimeError('synthetic partial connection')
            await asyncio.Event().wait()
        async def disconnect(self):
            if self.proc and self.proc.returncode is None:
                self.proc.terminate()
                await self.proc.wait()
    for name in ('ClaudeAgentOptions', 'QoderAgentOptions', 'PermissionResultAllow', 'PermissionResultDeny'):
        setattr(sdk, name, N)
    sdk.ClaudeSDKClient = sdk.QoderSDKClient = Client
    sdk.access_token = lambda value: value
    sdk.access_token_from_env = sdk.qodercli_auth = lambda: None
    monkeypatch.setitem(sys.modules, module_name, sdk)
    monkeypatch.setattr(engine_type, 'resolve_binary', staticmethod(lambda: '/synthetic/cli'))
    monkeypatch.setattr(engine_type, 'is_configured', staticmethod(lambda: True))
    monkeypatch.setattr(engine_type, 'project_skills', lambda *args: [])
    monkeypatch.setattr(engine_type, 'resolve_provider_runtime', lambda *args, **kwargs: ProviderRuntimeConfig())
    monkeypatch.setattr('services.skill_runtime.prepare_qoder_plugin', lambda *args: (tmp_path, []))
    monkeypatch.setattr('services.skill_runtime.prepare_claude_plugin', lambda *args: (tmp_path, []))
    monkeypatch.setattr('services.config.config_store.get_claude_agent_sdk_config', lambda: {
        'permission_mode':'acceptEdits', 'max_turns':'', 'fallback_model':'',
    })
    monkeypatch.setattr('services.config.config_store.get_qoder_sdk_config', lambda: {
        'model':'auto','permission_mode':'default','include_partial_messages':True,
    })
    engine = engine_type()
    async def consume():
        return [e async for e in engine.spawn('hello', cwd=str(tmp_path))]
    task = asyncio.create_task(consume())
    try:
        try:
            await asyncio.wait_for(started.wait(), 2)
        except TimeoutError:
            if task.done():
                events = await task
                raise AssertionError([(e.type, e.data) for e in events])
            raise
        if failure == 'cancel':
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        assert clients[0].proc.returncode is not None, 'partial connect left process alive'
        assert engine._client is None and not engine._running
    finally:
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        for client in clients:
            await client.disconnect()


@pytest.mark.anyio
async def test_cancel_during_speech_creation_cannot_lose_late_worker(monkeypatch):
    started, release = asyncio.Event(), asyncio.Event()
    original = asyncio.create_subprocess_exec
    owned = []
    async def delayed(*args, **kwargs):
        p = await original(*args, **kwargs)
        owned.append(p)
        started.set()
        await release.wait()
        return p
    monkeypatch.setattr(asyncio, 'create_subprocess_exec', delayed)
    runtime = SpeechRuntime()
    task = asyncio.create_task(runtime.infer([sys.executable, '-c', 'import time;time.sleep(120)'], b'', 'a', True))
    try:
        await asyncio.wait_for(started.wait(), 2)
        task.cancel()
        await asyncio.sleep(0)
        release.set()
        result = await asyncio.wait_for(asyncio.gather(task, return_exceptions=True), 3)
        assert isinstance(result[0], asyncio.CancelledError)
        assert owned[0].returncode is not None and runtime.process is None
    finally:
        release.set()
        await runtime.close()
        for proc in owned:
            if proc.returncode is None:
                proc.kill()
            await proc.wait()


@pytest.mark.anyio
async def test_repeated_cancel_during_sdk_close_still_reaps_process():
    from engines.core.process_cleanup import close_sdk_client
    proc = await asyncio.create_subprocess_exec(sys.executable, '-c', 'import time;time.sleep(120)')
    sentinel = await asyncio.create_subprocess_exec(sys.executable, '-c', 'import time;time.sleep(120)')
    entered = asyncio.Event()
    class Client:
        _transport = N(_process=proc)
        async def disconnect(self):
            entered.set()
            await asyncio.Event().wait()
    task = asyncio.create_task(close_sdk_client(Client()))
    try:
        await asyncio.wait_for(entered.wait(), 2)
        task.cancel()
        await asyncio.sleep(0)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        assert proc.returncode is not None
        assert sentinel.returncode is None
    finally:
        for p in (proc, sentinel):
            if p.returncode is None:
                p.kill()
            await p.wait()


@pytest.mark.anyio
async def test_shutdown_continues_after_failure_and_defers_external_cancel():
    from services.shutdown import run_shutdown
    proc = await asyncio.create_subprocess_exec(sys.executable, '-c', 'import time;time.sleep(120)')
    entered, release = asyncio.Event(), asyncio.Event()
    called = []
    async def failing():
        called.append('failed')
        raise RuntimeError('synthetic shutdown error')
    async def close_process():
        entered.set()
        await release.wait()
        proc.kill()
        await proc.wait()
        called.append('closed')
    async def final():
        called.append('final')
    task = asyncio.create_task(run_shutdown([('failing', failing), ('process', close_process), ('final', final)]))
    try:
        await asyncio.wait_for(entered.wait(), 2)
        task.cancel()
        release.set()
        await asyncio.gather(task, return_exceptions=True)
        assert called == ['failed', 'closed', 'final']
        assert proc.returncode is not None
    finally:
        if proc.returncode is None:
            proc.kill()
        await proc.wait()


@pytest.mark.anyio
async def test_sdk_hung_close_escalates_for_a_term_resistant_process():
    from engines.core.process_cleanup import close_sdk_client
    proc = await asyncio.create_subprocess_exec(sys.executable, '-u', '-c',
        'import signal,time;signal.signal(signal.SIGTERM,lambda *_:None);print("ready",flush=True);time.sleep(120)',
        stdout=asyncio.subprocess.PIPE)
    await proc.stdout.readline()
    class Client:
        _transport = N(_process=proc)
        async def disconnect(self):
            await asyncio.Event().wait()
    try:
        await asyncio.wait_for(close_sdk_client(Client(), timeout=0.01), 3)
        assert proc.returncode is not None
    finally:
        if proc.returncode is None:
            proc.kill()
        await proc.wait()


@pytest.mark.anyio
async def test_speech_service_download_failure_still_closes_inference_workers(tmp_path, monkeypatch):
    from services.speech import SpeechService
    service = SpeechService(root=tmp_path)
    worker = SpeechRuntime()
    worker.process = await asyncio.create_subprocess_exec(sys.executable, '-c', 'import time;time.sleep(120)')
    proc = worker.process
    service.workers = [worker]
    async def failed():
        raise RuntimeError('synthetic download shutdown failure')
    monkeypatch.setattr(service, 'cancel_download', failed)
    try:
        with pytest.raises(RuntimeError, match='synthetic'):
            await service.close()
        assert proc.returncode is not None and not service.workers
    finally:
        await worker.close()


@pytest.mark.anyio
@pytest.mark.parametrize('kind', ['codex', 'claude', 'openclaw', 'hermes'])
async def test_cli_engine_stop_reaps_descendants(kind):
    from engines.codex import CodexEngine
    from engines.claude_code import ClaudeCodeEngine
    from engines.openclaw import OpenClawEngine
    from engines.hermes import HermesEngine
    cls = {'codex': CodexEngine, 'claude': ClaudeCodeEngine,
           'openclaw': OpenClawEngine, 'hermes': HermesEngine}[kind]
    script = "import subprocess,sys; p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(120)'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); print(p.pid,flush=True); sys.stdin.read()"
    proc = await asyncio.create_subprocess_exec(sys.executable, '-u', '-c', script,
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE)
    child = psutil.Process(int(await proc.stdout.readline()))
    child.create_time()
    engine = cls()
    engine._process, engine._running = proc, True
    try:
        await asyncio.wait_for(engine.stop(), 8)
        assert proc.returncode is not None and not alive(child)
        assert not engine._running
    finally:
        await dispose(child)
        if proc.returncode is None:
            proc.kill()
        await proc.wait()
