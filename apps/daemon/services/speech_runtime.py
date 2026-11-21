"""One bounded inference process per active recording; idle processes are reusable."""
import asyncio
import base64
import json
import time

from engines.core.stream_lines import ChunkedLineReader
from engines.core.process_cleanup import finish_cleanup


class SpeechRuntime:
    def __init__(self):
        self.session_id = None
        self.process = None
        self.reader = None
        self.lock = asyncio.Lock()
        self.last_used = time.monotonic()

    async def warm(self, command):
        async with self.lock:
            if self.process is None or self.process.returncode is not None:
                await finish_cleanup(self._start(command))

    async def infer(self, command, pcm, session_id, final, preview=True):
        async with self.lock:
            try:
                if self.process is None or self.process.returncode is not None:
                    await finish_cleanup(self._start(command))
                proc = self.process
                proc.stdin.write((json.dumps({'audio': base64.b64encode(pcm).decode(),
                                              'session_id': session_id, 'final': final,
                                              'preview': preview}) + '\n').encode())
                await asyncio.wait_for(proc.stdin.drain(), 15)
                line = await asyncio.wait_for(self.reader.readline(), 15)
                if not line:
                    raise ValueError('The speech recognition process has exited. Please try again.')
                result = json.loads(line)
                if result.get('session_id') != session_id or 'error' in result:
                    raise ValueError('Speech recognition failed or returned a session mismatch')
                self.last_used = time.monotonic()
                return str(result['text'])[:16000]
            except BaseException as error:
                await finish_cleanup(self._stop_locked())
                if isinstance(error, TimeoutError):
                    raise ValueError('Speech recognition timed out, please retry') from error
                raise

    async def _start(self, command):
        self.process = await asyncio.create_subprocess_exec(*command,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL)
        self.reader = ChunkedLineReader(self.process.stdout)

    async def _stop_locked(self):
        proc, self.process = self.process, None
        self.reader = None
        if proc:
            if proc.returncode is None:
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass
            await proc.wait()

    async def close(self):
        await finish_cleanup(self._close())

    async def _close(self):
        # Interrupt only this recording's pipe, never another user's decoder.
        proc = self.process
        if proc and proc.returncode is None:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
        async with self.lock:
            # Recheck after the lock: a worker may have finished spawning.
            await self._stop_locked()
