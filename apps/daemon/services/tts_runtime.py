"""Reusable isolated synthesis process with cancellation and bounded JSONL reads."""
import asyncio
import json
import sys
import time
from pathlib import Path

from engines.core.process_cleanup import close_subprocess, finish_cleanup
from engines.core.stream_lines import ChunkedLineReader
from services.tts_catalog import LOCAL_MODELS, MODELS, OMNI_PERSONA_VOICE
from services.tts_resources import OMNI_RUNTIME, local_worker_command
from services.tts_qwen_resources import worker_command


class TtsRuntime:
    def __init__(self):
        self.process = None
        self.model = None
        self.lock = asyncio.Lock()
        self.last_used = time.monotonic()

    async def audio(self, path, text, voice, instructions='', *, reference=None, reference_text='', use_design=False):
        design = path.name == 'omnivoice' and (voice == OMNI_PERSONA_VOICE or use_design)
        async with self.lock:
            try:
                if not self.process or self.process.returncode is not None or self.model != (path, design):
                    await self._stop()
                    await finish_cleanup(self._start(path, design))
                proc = self.process
                reader = ChunkedLineReader(proc.stdout)
                request = dict(text=text, voice=voice, rate=1, instructions=instructions)
                if reference:
                    request.update(reference=str(reference), reference_text=reference_text)
                proc.stdin.write((json.dumps(request) + '\n').encode())
                await proc.stdin.drain()
                while True:
                    line = await asyncio.wait_for(reader.readline(), 360)
                    if not line:
                        raise ValueError('The speech synthesis process has exited')
                    event = json.loads(line)
                    if event.get('error'):
                        raise ValueError('Speech synthesis failed. Check the voice and model.')
                    if event.get('done'):
                        return
                    yield event
            except BaseException:
                await finish_cleanup(self._stop())
                raise
            finally:
                self.last_used = time.monotonic()

    async def _start(self, path, design=False):
        if path.name in LOCAL_MODELS:
            command = local_worker_command(path.parent.parent, path.name, path,
                                           design_runtime=path / OMNI_RUNTIME if design else None)
        elif MODELS.get(path.name, {}).get('runtime') == 'qwen':
            command = await asyncio.to_thread(worker_command, path)
        else:
            command = [sys.executable, '-I', str(Path(__file__).with_name('tts_worker.py')), str(path)]
        self.process = await asyncio.create_subprocess_exec(*command,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        self.model = (path, design)

    async def _stop(self):
        proc, self.process = self.process, None
        self.model = None
        if proc:
            await close_subprocess(proc, close_stdin=True)

    async def close(self):
        async with self.lock:
            await finish_cleanup(self._stop())
