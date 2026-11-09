"""One bounded inference process per active recording; idle processes are reusable."""
import asyncio
import base64
import json
import time

from engines.core.stream_lines import ChunkedLineReader


class SpeechRuntime:
    def __init__(self):
        self.session_id = None
        self.process = None
        self.reader = None
        self.lock = asyncio.Lock()
        self.last_used = time.monotonic()

    async def infer(self, command, pcm, session_id, final):
        async with self.lock:
            if self.process is None or self.process.returncode is not None:
                self.process = await asyncio.create_subprocess_exec(*command,
                    stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.DEVNULL)
                self.reader = ChunkedLineReader(self.process.stdout)
            proc = self.process
            try:
                proc.stdin.write((json.dumps({'audio': base64.b64encode(pcm).decode(),
                                              'session_id': session_id, 'final': final}) + '\n').encode())
                await asyncio.wait_for(proc.stdin.drain(), 15)
                line = await asyncio.wait_for(self.reader.readline(), 15)
                if not line:
                    raise ValueError('语音识别进程已退出，请重试')
                result = json.loads(line)
                if result.get('session_id') != session_id or 'error' in result:
                    raise ValueError('语音识别失败或返回会话不匹配')
                self.last_used = time.monotonic()
                return str(result['text'])[:16000]
            except BaseException as error:
                if proc.returncode is None:
                    try:
                        proc.kill()
                    except ProcessLookupError:
                        pass
                await proc.wait()
                self.process = None
                self.reader = None
                if isinstance(error, TimeoutError):
                    raise ValueError('语音识别超时，请重试') from error
                raise

    async def close(self):
        # Interrupt only this recording's pipe, never another user's decoder.
        proc = self.process
        if proc and proc.returncode is None:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
        async with self.lock:
            proc, self.process = self.process, None
            self.reader = None
            if proc:
                await proc.wait()
