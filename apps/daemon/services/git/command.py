"""Bounded, asynchronous Git execution. No shell, pager or credential prompts."""
import asyncio
import os
import signal


class GitError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


async def run_git(path, *args: str, stdin: bytes | None = None, check=True, timeout=20, limit=8 * 1024 * 1024):
    env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
    env.update(GIT_TERMINAL_PROMPT='0', GIT_OPTIONAL_LOCKS='0', GIT_LITERAL_PATHSPECS='1', LC_ALL='C')
    try:
        process = await asyncio.create_subprocess_exec(
            'git', '--no-pager', '-C', str(path), *args,
            stdin=asyncio.subprocess.PIPE if stdin is not None else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            env=env, start_new_session=os.name == 'posix',
        )
    except FileNotFoundError as exc:
        raise GitError('未找到 Git，请在本机安装 Git 后重试。', 503) from exc

    async def read(stream):
        data = bytearray()
        while chunk := await stream.read(65536):
            data.extend(chunk)
            if len(data) > limit:
                raise GitError('Git 输出超过预览限制，请缩小范围后重试。', 413)
        return bytes(data)

    async def write():
        if stdin is not None:
            try:
                process.stdin.write(stdin)
                await process.stdin.drain()
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                process.stdin.close()

    tasks = [asyncio.create_task(read(process.stdout)), asyncio.create_task(read(process.stderr)), asyncio.create_task(write())]
    try:
        async with asyncio.timeout(timeout):
            stdout, stderr, _ = await asyncio.gather(*tasks)
            code = await process.wait()
    except BaseException as exc:
        if process.returncode is None:
            try:
                if os.name == 'posix':
                    os.killpg(process.pid, signal.SIGKILL)
                else:
                    process.kill()
            except ProcessLookupError:
                pass
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await process.wait()
        if isinstance(exc, TimeoutError):
            raise GitError('Git 操作超时，请刷新状态后重试。', 504) from exc
        raise
    if code and check:
        raise GitError(stderr.decode('utf-8', 'replace').strip() or 'Git 操作失败。')
    return stdout, code


def text(data: bytes) -> str:
    return data.decode('utf-8', 'surrogateescape')
