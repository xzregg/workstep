"""Global bot registry and routing into existing project/task conversations."""

from __future__ import annotations

import asyncio
from dataclasses import replace
import logging
import uuid
from typing import Awaitable, Callable
from weakref import WeakValueDictionary

from models.task import Task
from services.config import config_store
from services.remote_access import ActorSnapshot, actor_context


logger = logging.getLogger(__name__)
CONFIG_KEY = "channel_bots"


from services.channels.base import IncomingMessage, ChannelAdapter
from services.channels.registry import discover_channels
from services.channels.responder import ChatSessionResponder


def _sender_actor(message: IncomingMessage, platform: str) -> ActorSnapshot:
    label = discover_channels()[platform].DISPLAY_NAME
    sender_id = message.sender_id.strip() or message.conversation_id
    return ActorSnapshot(
        actor_id=f"channel:{platform}:{sender_id}",
        user_name=f"{label} · {message.sender_name or sender_id}",
        username=sender_id,
        device_id=f"channel:{message.bot_id}",
        device_name=label,
        source="channel",
    )


AdapterFactory = Callable[[dict, Callable[[IncomingMessage], Awaitable[None]], Callable[[str, str], Awaitable[None]]], object]


class BotManager:
    def __init__(
        self, store, project_manager, event_bus, coordinator, responder,
        adapter_factories: dict[str, AdapterFactory] | None = None,
    ):
        self._store = store
        self._project_manager = project_manager
        self._event_bus = event_bus
        self._coordinator = coordinator
        self._responder = responder
        self._factories = adapter_factories
        self._registered_channels = None
        self._adapters: dict[str, object] = {}
        self._statuses: dict[str, dict] = {}
        from services.channels.reply_forwarder import ChannelReplyForwarder
        self._reply_forwarder = ChannelReplyForwarder(
            event_bus, project_manager, self._load, self._adapters,
        )
        from services.channels.sender import ChannelMessageSender
        self._message_sender = ChannelMessageSender(project_manager, self._load, self._adapters)
        self._config_lock = asyncio.Lock()
        self._chat_locks: WeakValueDictionary[tuple[str, str], asyncio.Lock] = WeakValueDictionary()

    async def _ensure_factories(self) -> None:
        if self._registered_channels is None:
            self._registered_channels = await asyncio.to_thread(discover_channels)
            if self._factories is None:
                self._factories = self._registered_channels

    async def _load(self) -> dict:
        await self._ensure_factories()
        data = await asyncio.to_thread(self._store.get, CONFIG_KEY, {})
        return {
            "bots": list(data.get("bots", [])),
            "groups": list(data.get("groups", [])),
            "sessions": dict(data.get("sessions", {})),
            "session_sources": dict(data.get("session_sources", {})),
            "processed": list(data.get("processed", [])),
            "recent_groups": list(data.get("recent_groups", [])),
        }

    async def _save(self, data: dict) -> None:
        await asyncio.to_thread(self._store.set, CONFIG_KEY, data)

    @staticmethod
    def _public(bot: dict, status: dict | None = None) -> dict:
        return {
            **{key: value for key, value in bot.items() if key != "secret"},
            "has_secret": bool(bot.get("secret")),
            "protocol_version": 1,
            "capabilities": {
                "receive": sorted(discover_channels()[bot["platform"]].CAPABILITIES.receive),
                "send": sorted(discover_channels()[bot["platform"]].CAPABILITIES.send),
                "waiting": discover_channels()[bot["platform"]].CAPABILITIES.waiting,
                "max_image_bytes": discover_channels()[bot["platform"]].CAPABILITIES.max_image_bytes,
                "max_file_bytes": discover_channels()[bot["platform"]].CAPABILITIES.max_file_bytes,
                "file_extensions": sorted(discover_channels()[bot["platform"]].CAPABILITIES.file_extensions or []),
            },
            "status": (status or {}).get("status", "disabled" if not bot["enabled"] else "connecting"),
            "error": (status or {}).get("error", ""),
        }

    async def list_channel_sessions(self, project_id: str) -> dict:
        return await self._message_sender.sessions(project_id)

    async def send_message(self, **values) -> dict:
        return await self._message_sender.send(**values)

    async def list_bots(self) -> list[dict]:
        data = await self._load()
        return [self._public(bot, self._statuses.get(bot["id"])) for bot in data["bots"]]

    async def _validate_target(self, kind: str, project_id: str, task_id: str) -> None:
        if kind not in {"", "project", "task"}:
            raise ValueError("绑定目标类型无效")
        if not kind:
            return
        if not self._project_manager.get_project_by_id(project_id):
            raise ValueError("项目不存在")
        if kind == "task":
            if not task_id:
                raise ValueError("请选择任务")
            exists = await self._project_manager.run_db(
                project_id,
                lambda _project: Task.get_or_none(Task.id == task_id) is not None,
            )
            if not exists:
                raise ValueError("任务不存在")

    async def create_bot(self, values: dict) -> dict:
        await self._ensure_factories()
        platform = str(values.get("platform") or "")
        name = str(values.get("name") or "").strip()
        app_id = str(values.get("app_id") or "").strip()
        secret = str(values.get("secret") or "").strip()
        kind = str(values.get("default_target_type") or "")
        project_id = str(values.get("default_project_id") or "")
        task_id = str(values.get("default_task_id") or "")
        if platform not in self._factories or not name or not app_id or not secret:
            raise ValueError("平台、名称和凭证均为必填项")
        await self._validate_target(kind, project_id, task_id)
        bot = {
            "id": str(uuid.uuid4()), "platform": platform, "name": name,
            "app_id": app_id, "secret": secret,
            "enabled": bool(values.get("enabled", False)),
            "default_target_type": kind,
            "default_project_id": project_id if kind else "",
            "default_task_id": task_id if kind == "task" else "",
        }
        async with self._config_lock:
            data = await self._load()
            if any(row["platform"] == platform and row["app_id"] == app_id for row in data["bots"]):
                raise ValueError("该平台机器人已经添加")
            data["bots"].append(bot)
            await self._save(data)
        if bot["enabled"]:
            await self._start_bot(bot)
        return self._public(bot, self._statuses.get(bot["id"]))

    async def update_bot(self, bot_id: str, values: dict) -> dict:
        async with self._config_lock:
            data = await self._load()
            bot = next((row for row in data["bots"] if row["id"] == bot_id), None)
            if bot is None:
                raise LookupError("机器人不存在")
            updated = dict(bot)
            for key in ("name", "app_id", "default_target_type", "default_project_id", "default_task_id", "enabled"):
                if key in values:
                    updated[key] = values[key]
            if values.get("secret"):
                updated["secret"] = str(values["secret"])
            updated["name"] = str(updated["name"]).strip()
            updated["app_id"] = str(updated["app_id"]).strip()
            updated["default_target_type"] = str(updated["default_target_type"] or "")
            updated["default_project_id"] = str(updated["default_project_id"] or "")
            updated["default_task_id"] = str(updated["default_task_id"] or "")
            updated["enabled"] = bool(updated["enabled"])
            if not updated["default_target_type"]:
                updated["default_project_id"] = ""
            if updated["default_target_type"] != "task":
                updated["default_task_id"] = ""
            if not updated["name"] or not updated["app_id"]:
                raise ValueError("名称和平台应用标识不能为空")
            await self._validate_target(
                updated["default_target_type"], updated["default_project_id"],
                updated["default_task_id"],
            )
            if any(row["id"] != bot_id and row["platform"] == bot["platform"] and row["app_id"] == updated["app_id"] for row in data["bots"]):
                raise ValueError("该平台机器人已经添加")
            data["bots"] = [updated if row["id"] == bot_id else row for row in data["bots"]]
            await self._save(data)
        await self._stop_bot(bot_id)
        if updated["enabled"]:
            await self._start_bot(updated)
        return self._public(updated, self._statuses.get(bot_id))

    async def delete_bot(self, bot_id: str) -> None:
        async with self._config_lock:
            data = await self._load()
            if not any(row["id"] == bot_id for row in data["bots"]):
                raise LookupError("机器人不存在")
            data["bots"] = [row for row in data["bots"] if row["id"] != bot_id]
            data["groups"] = [row for row in data["groups"] if row["bot_id"] != bot_id]
            data["sessions"] = {key: value for key, value in data["sessions"].items() if not key.startswith(f"{bot_id}:")}
            await self._save(data)
        await self._stop_bot(bot_id)
        self._statuses.pop(bot_id, None)

    async def bind_group(self, project_id: str, task_id: str, bot_id: str, group_id: str) -> dict:
        group_id = group_id.strip()
        if not group_id:
            raise ValueError("群标识不能为空")
        await self._validate_target("task", project_id, task_id)
        async with self._config_lock:
            data = await self._load()
            if not any(bot["id"] == bot_id for bot in data["bots"]):
                raise ValueError("机器人不存在")
            conflict = next((row for row in data["groups"] if row["bot_id"] == bot_id and row["group_id"] == group_id), None)
            if conflict and (conflict["project_id"], conflict["task_id"]) != (project_id, task_id):
                raise ValueError("该机器人群已绑定其它任务")
            binding = {"bot_id": bot_id, "group_id": group_id, "project_id": project_id, "task_id": task_id}
            if not conflict:
                data["groups"].append(binding)
                await self._save(data)
            return binding

    async def list_task_groups(self, project_id: str, task_id: str) -> list[dict]:
        data = await self._load()
        return [row for row in data["groups"] if row["project_id"] == project_id and row["task_id"] == task_id]

    async def remove_task_bindings(self, project_id: str, task_id: str) -> None:
        async with self._config_lock:
            data = await self._load()
            data["groups"] = [row for row in data["groups"] if (row["project_id"], row["task_id"]) != (project_id, task_id)]
            for bot in data["bots"]:
                if (bot["default_target_type"] == "task" and bot["default_project_id"] == project_id
                        and bot["default_task_id"] == task_id):
                    bot.update(default_target_type="", default_project_id="", default_task_id="")
            await self._save(data)

    async def unbind_group(self, project_id: str, task_id: str, bot_id: str, group_id: str) -> None:
        async with self._config_lock:
            data = await self._load()
            data["groups"] = [row for row in data["groups"] if (row["project_id"], row["task_id"], row["bot_id"], row["group_id"]) != (project_id, task_id, bot_id, group_id)]
            await self._save(data)

    async def recent_groups(self, bot_id: str) -> list[dict]:
        data = await self._load()
        return [row for row in data["recent_groups"] if row["bot_id"] == bot_id]

    async def start(self) -> None:
        await self._reply_forwarder.start()
        data = await self._load()
        for bot in data["bots"]:
            if bot["enabled"]:
                await self._start_bot(bot)

    async def shutdown(self) -> None:
        await self._reply_forwarder.shutdown()
        for bot_id in tuple(self._adapters):
            await self._stop_bot(bot_id)
        shutdown = getattr(self._responder, "shutdown", None)
        if shutdown:
            await shutdown()

    async def _start_bot(self, bot: dict) -> None:
        bot_id = bot["id"]
        factory = self._factories[bot["platform"]]
        adapter = factory(
            bot,
            self.handle_message,
            lambda status, error, bot_id=bot_id: self._state_changed(bot_id, status, error),
        )
        self._adapters[bot_id] = adapter
        await self._state_changed(bot_id, "connecting", "")
        try:
            await adapter.start()
        except Exception as exc:
            logger.exception("Failed to start channel bot %s", bot_id)
            await self._state_changed(bot_id, "error", str(exc))

    async def _stop_bot(self, bot_id: str) -> None:
        adapter = self._adapters.pop(bot_id, None)
        if adapter is not None:
            await adapter.stop()
        await self._state_changed(bot_id, "disabled", "")

    async def _state_changed(self, bot_id: str, status: str, error: str) -> None:
        self._statuses[bot_id] = {"status": status, "error": error}
        await self._event_bus.publish({
            "type": "CUSTOM", "name": "channel.bot_state",
            "value": {"bot_id": bot_id, "status": status, "error": error},
            "channel": "channel_bots",
        })

    async def handle_message(self, message: IncomingMessage) -> None:
        key = (message.bot_id, message.conversation_id)
        lock = self._chat_locks.setdefault(key, asyncio.Lock())
        await self._route_message(message, lock)

    async def _route_message(self, message: IncomingMessage, lock: asyncio.Lock) -> None:
        if not message.message_id or not message.conversation_id or (not message.text.strip() and not message.attachments):
            return
        async with self._config_lock:
            data = await self._load()
            bot = next((row for row in data["bots"] if row["id"] == message.bot_id), None)
            if not bot or not bot["enabled"] or message.bot_id not in self._adapters:
                return
            dedupe_key = f"{message.bot_id}:{message.message_id}"
            if dedupe_key in data["processed"]:
                return
            data["processed"].append(dedupe_key)
            data["processed"] = data["processed"][-1000:]
            if message.conversation_type == "group":
                recent = {"bot_id": message.bot_id, "group_id": message.conversation_id}
                data["recent_groups"] = [recent] + [row for row in data["recent_groups"] if row != recent][:49]
            await self._save(data)
        binding = next((row for row in data["groups"] if row["bot_id"] == message.bot_id and row["group_id"] == message.conversation_id), None) if message.conversation_type == "group" else None
        kind = "task" if binding else bot["default_target_type"]
        project_id = binding["project_id"] if binding else bot["default_project_id"]
        task_id = binding["task_id"] if binding else bot["default_task_id"]
        if not kind or not project_id:
            return
        adapter = self._adapters.get(message.bot_id)
        if not adapter:
            return
        start_reply = (adapter.start_reply if adapter.CAPABILITIES.waiting else None) if isinstance(adapter, ChannelAdapter) else getattr(adapter, "start_reply", None)
        if start_reply is not None:
            try:
                await start_reply(message)
            except Exception:
                logger.warning("Failed to start channel waiting reply", exc_info=True)
        try:
            async with lock:
                if message.attachments:
                    from services.channels.media import incoming_content
                    project = self._project_manager.get_project_by_id(project_id)
                    if project is None:
                        raise ValueError("项目不存在")
                    message = replace(message, text=await incoming_content(project, adapter, message))
                if kind == "task":
                    await self._validate_target("task", project_id, task_id)
                    reply = await self._task_reply(project_id, task_id, message, bot["platform"])
                else:
                    session_key = f"{message.bot_id}:{message.conversation_type}:{message.conversation_id}"
                    async with self._config_lock:
                        latest = await self._load()
                    session_id = latest["sessions"].get(session_key)
                    async def on_accepted(accepted_session_id: str) -> None:
                        async with self._config_lock:
                            current = await self._load()
                            current["sessions"][session_key] = accepted_session_id
                            current["session_sources"][accepted_session_id] = {
                                "conversation_type": message.conversation_type,
                                "conversation_id": message.conversation_id,
                                "peer_name": (message.sender_name or message.sender_id)
                                if message.conversation_type == "single" else message.conversation_id,
                            }
                            await self._save(current)
                        await self._event_bus.publish({
                            "type": "CUSTOM", "name": "channel.session_changed",
                            "channel": "channel_bots", "project_id": project_id,
                        })
                    with actor_context(_sender_actor(message, bot["platform"])):
                        if isinstance(self._responder, ChatSessionResponder):
                            session_id, reply = await self._responder(
                                project_id, session_id, message.text, "channel_chat", "",
                                on_accepted=on_accepted,
                            )
                        else:
                            session_id, reply = await self._responder(
                                project_id, session_id, message.text, "channel_chat", "",
                            )
                            await on_accepted(session_id)
                if reply or start_reply is not None:
                    text = reply or "处理完成，暂无回复内容。"
                    if isinstance(adapter, ChannelAdapter):
                        from services.channels.media import outgoing_content
                        project = self._project_manager.get_project_by_id(project_id)
                        await adapter.send(message, await outgoing_content(project, adapter, text))
                    else:
                        await adapter.send_text(message, text)
        except Exception:
            logger.exception("Failed to handle channel bot message %s", message.message_id)
            try:
                await adapter.send_text(message, "处理失败，请稍后重试。")
            except Exception:
                logger.exception("Failed to send channel bot error response")

    async def _task_reply(self, project_id: str, task_id: str, message: IncomingMessage, platform: str) -> str:
        queue = self._event_bus.subscribe(lambda event: (
            event.get("task_id") == task_id
            and event.get("channel") == "coordinator"
        ))
        try:
            actor = _sender_actor(message, platform)
            with actor_context(actor):
                accepted = await self._coordinator.submit_message(
                    project_id, task_id, message.text,
                    f"channel:{message.bot_id}:{message.message_id}",
                    author_name=actor.user_name,
                )
            reply = ""
            while True:
                event = await asyncio.wait_for(queue.get(), timeout=600)
                if event.get("messageId") != accepted.assistant_message_id:
                    continue
                if event.get("type") == "TEXT_MESSAGE_CHUNK":
                    reply += str(event.get("delta") or "")
                elif event.get("type") == "TEXT_MESSAGE_CONTENT":
                    reply = str(event.get("content") or "")
                elif event.get("type") == "TEXT_MESSAGE_END":
                    if event.get("status") != "succeeded":
                        raise RuntimeError(str(event.get("error") or "协调助手失败"))
                    return reply
                elif event.get("type") == "RUN_ERROR":
                    raise RuntimeError(str(event.get("error") or "协调助手失败"))
        finally:
            self._event_bus.unsubscribe(queue)
