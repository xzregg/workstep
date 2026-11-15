"""Reusable isolated synthesis process with cancellation and bounded JSONL reads."""
import asyncio
import json
import sys
import time
from pathlib import Path

from engines.core.process_cleanup import finish_cleanup
from engines.core.stream_lines import ChunkedLineReader
from services.tts_catalog import MODELS
from services.tts_qwen_resources import worker_command


class TtsRuntime:
    def __init__(self):
        self.process = None
        self.model = None
        self.lock = asyncio.Lock()
        self.last_used = time.monotonic()

    async def audio(self, path, text, voice, instructions=''):
        async with self.lock:
            try:
                if not self.process or self.process.returncode is not None or self.model != path:
                    await self._stop()
                    await finish_cleanup(self._start(path))
                proc = self.process
                reader = ChunkedLineReader(proc.stdout)
                proc.stdin.write((json.dumps(dict(text=text, voice=voice, rate=1, instructions=instructions)) + '\n').encode())
                await proc.stdin.drain()
                while True:
                    line = await asyncio.wait_for(reader.readline(), 360)
                    if not line:
                        raise ValueError('语音合成进程已退出')
                    event = json.loads(line)
                    if event.get('error'):
                        raise ValueError('语音合成失败，请检查音色和模型')
                    if event.get('done'):
                        return
                    yield event
            except BaseException:
                await finish_cleanup(self._stop())
                raise
            finally:
                self.last_used = time.monotonic()

    async def _start(self, path):
        if MODELS.get(path.name, {}).get('runtime') == 'qwen':
            command = await asyncio.to_thread(worker_command, path)
        else:
            command = [sys.executable, '-I', str(Path(__file__).with_name('tts_worker.py')), str(path)]
        self.process = await asyncio.create_subprocess_exec(*command,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        self.model = path

    async def _stop(self):
        proc, self.process = self.process, None
        self.model = None
        if proc:
            if proc.returncode is None:
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass
            await proc.wait()

    async def close(self):
        async with self.lock:
            await finish_cleanup(self._stop())
