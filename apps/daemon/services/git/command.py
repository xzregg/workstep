"""Bounded, asynchronous Git execution. No shell, pager or credential prompts."""
import asyncio
import os
import re
import shlex
import signal
import shutil
import sys
import tempfile
from pathlib import Path


class GitError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def explain_auth_error(message: str) -> str:
    match = re.search(r"could not read (?:Username|Password) for 'https://([^/']+)", message)
    if match:
        return f'远程仓库 {match.group(1)} 需要登录，请在 Git 设置中填写 HTTPS 主机、登录账号和访问令牌后重试。'
    return message


def _askpass_script():
    directory = Path(tempfile.mkdtemp(prefix='workstep-git-'))
    script = directory / ('askpass.cmd' if os.name == 'nt' else 'askpass.sh')
    helper = directory / 'askpass.py'
    helper.write_text('''import os, re, sys
from urllib.parse import urlsplit
prompt = sys.argv[1] if len(sys.argv) > 1 else ""
match = re.search(r"'([^']+)'", prompt)
if not match:
    sys.exit(1)
try:
    url = urlsplit(match.group(1))
    host = (url.hostname or "").lower() + (f":{url.port}" if url.port else "")
except ValueError:
    sys.exit(1)
if url.scheme != "https" or host != os.environ.get("WORKSTEP_GIT_HOST"):
    sys.exit(1)
if prompt.startswith("Username"):
    print(os.environ["WORKSTEP_GIT_USERNAME"])
elif prompt.startswith("Password"):
    print(os.environ["WORKSTEP_GIT_TOKEN"])
else:
    sys.exit(1)
''')
    if os.name == 'nt':
        script.write_text(f'@echo off\r\n"{sys.executable}" "%~dp0askpass.py" "%~1"\r\n')
    else:
        script.write_text(f'#!/bin/sh\nexec {shlex.quote(sys.executable)} {shlex.quote(str(helper))} "$1"\n')
        script.chmod(0o700)
    return directory, script


async def run_git(path, *args: str, stdin: bytes | None = None, check=True, timeout=20, limit=8 * 1024 * 1024, auth=None):
    env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
    env.update(GIT_TERMINAL_PROMPT='0', GIT_OPTIONAL_LOCKS='0', GIT_LITERAL_PATHSPECS='1', LC_ALL='C')
    askpass_dir = None
    if auth:
        if not auth.get('host'):
            raise GitError('Git 凭据缺少 HTTPS 主机。')
        askpass_dir, script = await asyncio.to_thread(_askpass_script)
        env.update(GIT_ASKPASS=str(script), GIT_ASKPASS_REQUIRE='force',
                   WORKSTEP_GIT_USERNAME=auth['username'], WORKSTEP_GIT_TOKEN=auth['token'],
                   WORKSTEP_GIT_HOST=auth['host'])
        args = ('-c', 'credential.helper=', *args)
        if auth.get('upgrade_from'):
            args = ('-c', f"url.{auth['upgrade_to']}.insteadOf={auth['upgrade_from']}", *args)
    try:
        process = await asyncio.create_subprocess_exec(
            'git', '--no-pager', '-C', str(path), *args,
            stdin=asyncio.subprocess.PIPE if stdin is not None else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            env=env, start_new_session=os.name == 'posix',
        )
    except FileNotFoundError as exc:
        if askpass_dir is not None:
            await asyncio.to_thread(shutil.rmtree, askpass_dir)
        raise GitError('未找到 Git，请在本机安装 Git 后重试。', 503) from exc
    except BaseException:
        if askpass_dir is not None:
            await asyncio.to_thread(shutil.rmtree, askpass_dir)
        raise

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
        if askpass_dir is not None:
            await asyncio.to_thread(shutil.rmtree, askpass_dir)
        if isinstance(exc, TimeoutError):
            raise GitError('Git 操作超时，请刷新状态后重试。', 504) from exc
        raise
    if askpass_dir is not None:
        await asyncio.to_thread(shutil.rmtree, askpass_dir)
    if code and check:
        message = stderr.decode('utf-8', 'replace').replace(auth['token'], '[已隐藏]') if auth else stderr.decode('utf-8', 'replace')
        raise GitError(explain_auth_error(message.strip()) or 'Git 操作失败。')
    return stdout, code


def text(data: bytes) -> str:
    return data.decode('utf-8', 'surrogateescape')
