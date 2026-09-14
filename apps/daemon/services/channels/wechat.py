"""WeChat channel backed by an injectable bridge implementation."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
from pathlib import Path
import shlex
from typing import Protocol

from services.channels.base import ChannelBase, IncomingMessage, LoginResult
from engines.core.stream_lines import iter_stream_lines


logger = logging.getLogger(__name__)


#: Surfaced in the Web UI when no runnable WeChat bridge is available.
BRIDGE_UNAVAILABLE_MESSAGE = (
    "微信桥接服务不可用：请在 apps/wechat-bridge 目录执行 npm install，"
    "或设置 WORKSTEP_WECHAT_BRIDGE_COMMAND 指向自定义桥接进程"
)


class WeChatBridge(Protocol):
    async def start(self, session: dict | None, channel: "WeChatChannel") -> None: ...
    async def stop(self) -> None: ...
    async def login(self, channel: "WeChatChannel") -> LoginResult: ...
    async def logout(self) -> None: ...
    async def send_text(self, chat_id: str, text: str) -> None: ...


class MissingWeChatBridge:
    async def start(self, session: dict | None, channel: "WeChatChannel") -> None:
        if session:
            await channel.login_failed(BRIDGE_UNAVAILABLE_MESSAGE)

    async def stop(self) -> None:
        return None

    async def login(self, channel: "WeChatChannel") -> LoginResult:
        return LoginResult(status="failed", error=BRIDGE_UNAVAILABLE_MESSAGE)

    async def logout(self) -> None:
        return None

    async def send_text(self, chat_id: str, text: str) -> None:
        raise RuntimeError(BRIDGE_UNAVAILABLE_MESSAGE)


class SubprocessWeChatBridge:
    """JSONL bridge for a wechaty (or equivalent) sidecar process."""

    def __init__(self, command: str):
        self._command = shlex.split(command)
        self._process: asyncio.subprocess.Process | None = None
        self._reader_task: asyncio.Task | None = None
        self._channel: WeChatChannel | None = None
        self._message_tasks: set[asyncio.Task] = set()
        self._stopping = False

    async def start(self, session: dict | None, channel: "WeChatChannel") -> None:
        if self._process is not None and self._process.returncode is None:
            return
        self._channel = channel
        self._stopping = False
        self._process = await asyncio.create_subprocess_exec(
            *self._command,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            limit=1024 * 256,
        )
        self._reader_task = asyncio.create_task(self._read_events())
        await self._write({"action": "start", "session": session})

    async def stop(self) -> None:
        process = self._process
        if process is None:
            return
        self._stopping = True
        if process.returncode is None:
            await self._write({"action": "stop"})
            try:
                await asyncio.wait_for(process.wait(), timeout=5)
            except asyncio.TimeoutError:
                process.terminate()
                await process.wait()
        if self._reader_task is not None:
            self._reader_task.cancel()
        for task in tuple(self._message_tasks):
            task.cancel()
        if self._message_tasks:
            await asyncio.gather(*self._message_tasks, return_exceptions=True)
        self._message_tasks.clear()
        self._process = None

    async def login(self, channel: "WeChatChannel") -> LoginResult:
        await self.start(None, channel)
        await self._write({"action": "login"})
        return LoginResult(status="pending")

    async def logout(self) -> None:
        await self._write({"action": "logout"})

    async def send_text(self, chat_id: str, text: str) -> None:
        await self._write({"action": "send_text", "chat_id": chat_id, "text": text})

    async def _write(self, payload: dict) -> None:
        if self._process is None or self._process.stdin is None:
            raise RuntimeError("微信桥接进程未启动")
        self._process.stdin.write(
            (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")
        )
        await self._process.stdin.drain()

    async def _read_events(self) -> None:
        if self._process is None or self._process.stdout is None:
            return
        # 分块读取：桥接进程的单条 JSON（二维码 base64、长消息）可能超过
        # StreamReader 默认 64KiB limit，readline 会抛
        # "Separator is not found, and chunk exceed the limit"。
        async for line in iter_stream_lines(self._process.stdout):
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            channel = self._channel
            if channel is None:
                continue
            event_type = event.get("event")
            if event_type == "qr_code":
                await channel.qr_received(str(event.get("qr_code") or ""))
            elif event_type == "login":
                await channel.login_succeeded(
                    str(event.get("account_id") or ""), event.get("session") or {}
                )
            elif event_type == "message":
                task = asyncio.create_task(
                    self._deliver_message(
                        channel,
                        str(event.get("chat_id") or ""),
                        str(event.get("sender_id") or ""),
                        str(event.get("text") or ""),
                    )
                )
                self._message_tasks.add(task)
                task.add_done_callback(self._message_tasks.discard)
            elif event_type == "error":
                await channel.login_failed(str(event.get("error") or "微信桥接错误"))
        if not self._stopping and self._channel is not None:
            await self._channel.login_failed("微信桥接进程已退出")

    async def _deliver_message(
        self,
        channel: "WeChatChannel",
        chat_id: str,
        sender_id: str,
        text: str,
    ) -> None:
        try:
            await channel.receive_text(chat_id, sender_id, text)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Failed to route WeChat message for chat %s", chat_id)
            try:
                await self.send_text(chat_id, "消息处理失败，请稍后重试。")
            except Exception:
                logger.exception("Failed to send WeChat error reply for chat %s", chat_id)


def _bundled_bridge_command() -> str | None:
    """Locate the bundled ``apps/wechat-bridge`` sidecar, if runnable.

    Resolved relative to this file (``apps/daemon/services/channels``) so the
    daemon works from any CWD. Requires Node.js on PATH and the sidecar script
    to exist; dependency installation happens out-of-band (see
    ``apps/wechat-bridge/README.md``).
    """
    # wechat.py lives at <root>/apps/daemon/services/channels/wechat.py
    repo_root = Path(__file__).resolve().parents[4]
    entry = repo_root / "apps" / "wechat-bridge" / "index.js"
    if not entry.is_file():
        return None
    node = shutil.which("node")
    if node is None:
        return None
    return f"{node} {entry}"


def default_wechat_bridge() -> WeChatBridge:
    """Pick the WeChat bridge implementation.

    Priority: explicit ``WORKSTEP_WECHAT_BRIDGE_COMMAND`` override, then the
    bundled ``apps/wechat-bridge`` sidecar, then a no-op bridge that surfaces a
    clear "not configured" error to the UI.
    """
    command = os.environ.get("WORKSTEP_WECHAT_BRIDGE_COMMAND", "").strip()
    if command:
        return SubprocessWeChatBridge(command)
    bundled = _bundled_bridge_command()
    if bundled:
        return SubprocessWeChatBridge(bundled)
    return MissingWeChatBridge()


class WeChatChannel(ChannelBase):
    channel_type = "wechat"
    display_name = "微信"
    icon = "wechat"

    def __init__(self, project_id: str, session_dir: Path, bridge: WeChatBridge | None = None):
        super().__init__(project_id, session_dir)
        self._bridge = bridge or default_wechat_bridge()
        self._logged_in = False
        self._account_id: str | None = None
        self._login_result = LoginResult(status="not_started")
        self._session_path = session_dir / "wechat.json"

    async def start(self) -> None:
        def load_session() -> dict | None:
            if not self._session_path.is_file():
                return None
            try:
                return json.loads(self._session_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                return None

        session = await asyncio.to_thread(load_session)
        await self._bridge.start(session, self)

    async def stop(self) -> None:
        await self._bridge.stop()

    async def login(self) -> LoginResult:
        result = await self._bridge.login(self)
        if (
            result.status == "pending"
            and not result.qr_code
            and self._login_result.status == "pending"
            and self._login_result.qr_code
        ):
            return self._login_result
        await self._set_login_result(result)
        return self._login_result

    async def logout(self) -> None:
        await self._bridge.logout()
        self._logged_in = False
        self._account_id = None
        await asyncio.to_thread(self._session_path.unlink, missing_ok=True)
        await self._set_login_result(LoginResult(status="not_started"))

    async def is_logged_in(self) -> bool:
        return self._logged_in

    async def send_text(self, chat_id: str, text: str) -> None:
        await self._bridge.send_text(chat_id, text)

    async def login_succeeded(self, account_id: str, session: dict) -> None:
        def save_session() -> None:
            self.session_dir.mkdir(parents=True, exist_ok=True)
            self._session_path.write_text(
                json.dumps(session, ensure_ascii=False), encoding="utf-8"
            )

        await asyncio.to_thread(save_session)
        self._logged_in = True
        self._account_id = account_id
        await self._set_login_result(
            LoginResult(status="success", account_id=account_id)
        )

    async def qr_received(self, qr_code: str) -> None:
        await self._set_login_result(
            LoginResult(status="pending", qr_code=qr_code)
        )

    async def login_failed(self, error: str) -> None:
        self._logged_in = False
        await self._set_login_result(LoginResult(status="failed", error=error))

    async def _set_login_result(self, result: LoginResult) -> None:
        self._login_result = result
        await self.emit_login_state(result)

    async def receive_text(self, chat_id: str, sender_id: str, text: str) -> None:
        await self.emit_message(
            IncomingMessage(chat_id=chat_id, sender_id=sender_id, text=text)
        )
