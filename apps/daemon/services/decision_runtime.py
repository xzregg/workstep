"""One cancellable managed worker using JSONL or private native transport."""
import asyncio
import json
import sys
import uuid
from pathlib import Path

from engines.core.stream_lines import ChunkedLineReader
from services.decision_gguf import NativeDecisionWorker


class DecisionRuntime:
    def __init__(self):
        self.process = None
        self.state = 'stopped'
        self.lock = asyncio.Lock()
        self.reaper = None
        self.reader = None
        self.model_path = None
        self.native = NativeDecisionWorker()
        self.backend = None

    async def test(self, runtime, model, payload):
        async with self.lock:
            if self.reaper:
                self.reaper.cancel()
                self.reaper = None
            try:
                if self.model_path is not None and (self.model_path != model or self.backend != 'laya'):
                    await self._stop()
                cold = self.process is None or self.process.returncode is not None
                if cold:
                    self.state = 'loading'
                    self.backend = 'laya'
                    self.model_path = model
                    self.process = await asyncio.create_subprocess_exec(sys.executable, '-I',
                        str(Path(__file__).with_name('decision_worker.py')), str(runtime / 'lib'), str(model),
                        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
                    self.reader = ChunkedLineReader(self.process.stdout, max_line_bytes=1024 * 1024)
                request_id = uuid.uuid4().hex
                self.process.stdin.write((json.dumps({'id': request_id, **payload}) + '\n').encode())
                await asyncio.wait_for(self.process.stdin.drain(), 10)
                line = await asyncio.wait_for(self.reader.readline(), 120 if cold else 20)
                result = json.loads(line)
                if result.get('id') != request_id or 'result' not in result:
                    raise ValueError('本地推理响应无效')
                self.state = 'ready'
                self.reaper = asyncio.get_running_loop().call_later(300, lambda: asyncio.create_task(self.close()))
                return result['result']
            except BaseException:
                await self._stop()
                self.state = 'error'
                raise

    async def test_gguf(self, runtime, model, filename, payload):
        async with self.lock:
            if self.reaper:
                self.reaper.cancel()
                self.reaper = None
            try:
                if self.model_path is not None and (self.model_path != model or self.backend != 'gguf'):
                    await self._stop()
                if self.process is None or self.process.returncode is not None:
                    self.state = 'loading'
                    self.model_path = model
                    self.backend = 'gguf'
                    self.process = await self.native.start(runtime, model, filename)
                result = await self.native.infer(payload)
                self.state = 'ready'
                self.reaper = asyncio.get_running_loop().call_later(300, lambda: asyncio.create_task(self.close()))
                return result
            except BaseException:
                await self._stop()
                self.state = 'error'
                raise

    async def _stop(self):
        if self.reaper:
            self.reaper.cancel()
            self.reaper = None
        process, self.process = self.process, None
        self.reader = None
        self.model_path = None
        self.backend = None
        if process:
            if process.returncode is None:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
            await process.wait()
        await self.native.close()

    async def close(self):
        # Interrupt a loading/hung worker before waiting on its serialized protocol.
        process = self.process
        if process and process.returncode is None:
            try:
                process.kill()
            except ProcessLookupError:
                pass
        async with self.lock:
            await self._stop()
            self.state = 'stopped'
