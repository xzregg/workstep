"""Channel lifecycle, persistence, status broadcast and message routing."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
import json
import logging
import uuid
from pathlib import Path
from typing import Awaitable, Callable

from agent_assistants.base import assistant_registry
from models.channel import Channel, ChannelChatMapping
from models.fields import utc_now
from services.channels.base import ChannelBase, IncomingMessage, LoginResult
from services.channels.wechat import WeChatChannel


logger = logging.getLogger(__name__)


AssistantResponder = Callable[[str, str | None, str, str, str], Awaitable[tuple[str, str]]]
ChannelFactory = Callable[[str, Path], ChannelBase]


class ChannelAlreadyLoggedInError(RuntimeError):
    pass


class ChannelUnavailableError(RuntimeError):
    pass


class ChannelManager:
    def __init__(self, event_bus, project_manager, responder: AssistantResponder):
        self._event_bus = event_bus
        self._project_manager = project_manager
        self._responder = responder
        self._factories: dict[str, ChannelFactory] = {"wechat": WeChatChannel}
        self._instances: dict[tuple[str, str], ChannelBase] = {}
        self._login_results: dict[tuple[str, str], LoginResult] = {}
        self._chat_locks: dict[tuple[str, str, str], asyncio.Lock] = {}
        self._chat_lock_users: dict[tuple[str, str, str], int] = {}

    def register(self, channel_type: str, factory: ChannelFactory) -> None:
        self._factories[channel_type] = factory

    async def start(self) -> None:
        for project in tuple(self._project_manager.iter_projects()):
            channel_types = await self._project_manager.run_db(
                project.id,
                lambda _project: [
                    row.channel_type
                    for row in Channel.select(Channel.channel_type).where(
                        (Channel.enabled == True) | (Channel.status == "logged_in")
                    )
                ],
            )
            for channel_type in channel_types:
                instance = self._instance(project.id, channel_type)
                try:
                    await instance.start()
                except Exception as exc:
                    message = f"微信桥接启动失败：{exc}"
                    logger.exception(
                        "Failed to restore channel %s for project %s",
                        channel_type,
                        project.id,
                    )
                    await self._state_changed(
                        project.id,
                        channel_type,
                        LoginResult(status="failed", error=message),
                    )

    async def shutdown(self) -> None:
        for instance in tuple(self._instances.values()):
            await instance.stop()
        self._instances.clear()
        shutdown = getattr(self._responder, "shutdown", None)
        if shutdown is not None:
            await shutdown()

    def _instance(self, project_id: str, channel_type: str) -> ChannelBase:
        key = (project_id, channel_type)
        instance = self._instances.get(key)
        if instance is not None:
            return instance
        project = self._project_manager.get_project_by_id(project_id)
        if project is None:
            raise ValueError(f"Project not found: {project_id}")
        factory = self._factories.get(channel_type)
        if factory is None:
            raise ValueError(f"Channel not found: {channel_type}")
        session_dir = Path(project.workstep_dir) / "channel_sessions"
        instance = factory(project_id, session_dir)
        instance.on_message(
            lambda message, pid=project_id, kind=channel_type: self._route_message(pid, kind, message)
        )
        instance.on_login_state_change(
            lambda result, pid=project_id, kind=channel_type: self._state_changed(pid, kind, result)
        )
        self._instances[key] = instance
        return instance

    def _ensure_row(self, project_id: str, channel_type: str) -> Channel:
        row = Channel.get_or_none(
            Channel.project_id == project_id,
            Channel.channel_type == channel_type,
        )
        if row is None:
            row = Channel.create(
                id=channel_type,
                project_id=project_id,
                channel_type=channel_type,
                updated_at=utc_now(),
            )
        return row

    async def list_channels(self, project_id: str) -> list[dict]:
        def load(_project):
            return [self._serialize(self._ensure_row(project_id, kind)) for kind in self._factories]
        rows = await self._project_manager.run_db(project_id, load)
        for item in rows:
            result = self._login_results.get((project_id, item["channel_type"]))
            if result and result.qr_code:
                item["qr_code"] = result.qr_code
        return rows

    async def update_config(self, project_id: str, channel_id: str, values: dict) -> dict:
        if channel_id not in self._factories:
            raise ValueError(f"Channel not found: {channel_id}")
        assistant_id = str(values.get("assistant_id") or "channel_chat")
        if assistant_registry.get(assistant_id) is None:
            raise ValueError(f"Assistant not found: {assistant_id}")
        instance = self._instance(project_id, channel_id)
        enabled = bool(values.get("enabled", False))
        if enabled and not await instance.is_logged_in():
            raise ValueError("请先完成扫码登录")

        def save(_project):
            row = self._ensure_row(project_id, channel_id)
            row.enabled = enabled
            row.assistant_id = assistant_id
            row.model = str(values.get("model") or "")
            row.config_json = json.dumps(values.get("config") or {}, ensure_ascii=False)
            row.status = "logged_in" if enabled else row.status
            row.updated_at = utc_now()
            row.save()
            return self._serialize(row)

        saved = await self._project_manager.run_db(project_id, save)
        try:
            if enabled:
                await instance.start()
            else:
                await instance.stop()
        except Exception as exc:
            message = f"微信桥接启动失败：{exc}"
            await self._state_changed(
                project_id,
                channel_id,
                LoginResult(status="failed", error=message),
            )
            raise ChannelUnavailableError(message) from exc
        await self._publish(project_id, channel_id, "channel.state", saved)
        return saved

    async def login(self, project_id: str, channel_type: str) -> LoginResult:
        instance = self._instance(project_id, channel_type)
        try:
            if await instance.is_logged_in():
                raise ChannelAlreadyLoggedInError("Channel is already logged in")
            current = self._login_results.get((project_id, channel_type))
            if current is not None and current.status == "pending":
                return current
            result = await instance.login()
            self._login_results[(project_id, channel_type)] = result
            return result
        except ChannelAlreadyLoggedInError:
            raise
        except Exception as exc:
            message = f"微信桥接启动失败：{exc}"
            await self._state_changed(
                project_id, channel_type, LoginResult(status="failed", error=message)
            )
            raise ChannelUnavailableError(message) from exc

    async def login_status(self, project_id: str, channel_type: str) -> LoginResult:
        instance = self._instance(project_id, channel_type)
        try:
            if await instance.is_logged_in():
                rows = await self.list_channels(project_id)
                row = next(item for item in rows if item["channel_type"] == channel_type)
                return LoginResult(status="success", account_id=row.get("account_id"))
            return self._login_results.get(
                (project_id, channel_type), LoginResult(status="not_started")
            )
        except Exception as exc:
            message = f"微信桥接状态读取失败：{exc}"
            await self._state_changed(
                project_id, channel_type, LoginResult(status="failed", error=message)
            )
            raise ChannelUnavailableError(message) from exc

    async def logout(self, project_id: str, channel_type: str) -> None:
        instance = self._instance(project_id, channel_type)
        try:
            await instance.logout()
            self._login_results.pop((project_id, channel_type), None)
        except Exception as exc:
            message = f"微信桥接退出失败：{exc}"
            await self._state_changed(
                project_id, channel_type, LoginResult(status="failed", error=message)
            )
            raise ChannelUnavailableError(message) from exc

    async def _state_changed(self, project_id: str, channel_type: str, result: LoginResult) -> None:
        self._login_results[(project_id, channel_type)] = result

        def save(_project):
            row = self._ensure_row(project_id, channel_type)
            row.status = {
                "success": "logged_in",
                "pending": "connecting",
                "not_started": "not_logged_in",
            }.get(result.status, "error" if result.status == "failed" else result.status)
            row.account_id = result.account_id
            row.error_message = result.error
            if result.status in {"failed", "expired", "not_started"}:
                row.enabled = False
            row.updated_at = utc_now()
            row.save()

        await self._project_manager.run_db(project_id, save)
        event_name = "channel.qr_code" if result.qr_code else "channel.login_status"
        await self._publish(project_id, channel_type, event_name, self._login_dict(result))

    async def _route_message(self, project_id: str, channel_type: str, message: IncomingMessage) -> None:
        key = (project_id, channel_type, message.chat_id)
        async with self._chat_lock(key):
            await self._route_message_serialized(project_id, channel_type, message)

    async def _route_message_serialized(
        self,
        project_id: str,
        channel_type: str,
        message: IncomingMessage,
    ) -> None:
        def load(_project):
            row = self._ensure_row(project_id, channel_type)
            mapping = ChannelChatMapping.get_or_none(
                ChannelChatMapping.project_id == project_id,
                ChannelChatMapping.channel_id == channel_type,
                ChannelChatMapping.chat_id == message.chat_id,
            )
            return self._serialize(row), mapping.session_id if mapping else None

        config, session_id = await self._project_manager.run_db(project_id, load)
        instance = self._instance(project_id, channel_type)
        if not config["enabled"] or not await instance.is_logged_in():
            return
        session_id, reply = await self._responder(
            project_id,
            session_id,
            message.text,
            config["assistant_id"],
            config["model"],
        )

        def save_mapping(_project):
            now = utc_now()
            ChannelChatMapping.insert(
                id=str(uuid.uuid4()), project_id=project_id,
                channel_id=channel_type, chat_id=message.chat_id,
                session_id=session_id, created_at=now, updated_at=now,
            ).on_conflict(
                conflict_target=[
                    ChannelChatMapping.project_id,
                    ChannelChatMapping.channel_id,
                    ChannelChatMapping.chat_id,
                ],
                update={
                    ChannelChatMapping.session_id: session_id,
                    ChannelChatMapping.updated_at: now,
                },
            ).execute()

        await self._project_manager.run_db(project_id, save_mapping)
        await instance.send_text(message.chat_id, reply)
        await self._publish(project_id, channel_type, "channel.message", {
            "chat_id": message.chat_id, "direction": "outbound", "content": reply,
        })

    @asynccontextmanager
    async def _chat_lock(self, key: tuple[str, str, str]):
        lock = self._chat_locks.setdefault(key, asyncio.Lock())
        self._chat_lock_users[key] = self._chat_lock_users.get(key, 0) + 1
        acquired = False
        try:
            await lock.acquire()
            acquired = True
            yield
        finally:
            if acquired:
                lock.release()
            remaining = self._chat_lock_users[key] - 1
            if remaining:
                self._chat_lock_users[key] = remaining
            else:
                self._chat_lock_users.pop(key, None)
                self._chat_locks.pop(key, None)

    async def _publish(self, project_id: str, channel_type: str, name: str, value: dict) -> None:
        await self._event_bus.publish({
            "type": "CUSTOM",
            "name": name,
            "value": value,
            "project_id": project_id,
            "channel": f"channel_{channel_type}",
        })

    @staticmethod
    def _login_dict(result: LoginResult) -> dict:
        return {
            "status": result.status,
            "qr_code": result.qr_code,
            "account_id": result.account_id,
            "error": result.error,
        }

    @staticmethod
    def _serialize(row: Channel) -> dict:
        try:
            config = json.loads(row.config_json or "{}")
        except json.JSONDecodeError:
            config = {}
        return {
            "id": row.id,
            "channel_type": row.channel_type,
            "display_name": "微信" if row.channel_type == "wechat" else row.channel_type,
            "icon": row.channel_type,
            "enabled": bool(row.enabled),
            "status": row.status,
            "account_id": row.account_id,
            "assistant_id": row.assistant_id,
            "model": row.model,
            "config": config,
            "error_message": row.error_message,
        }
