"""Adapter from channel messages to the existing persistent chat runtime."""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Awaitable, Callable

from agent_assistants.base import assistant_registry
from agent_assistants.channel_chat import ChannelChatModule
from models.chat_session import ChatSession
from services.channels.reply_failure import AssistantReplyError, ReplyWaitTimeout
from services.config import config_store


class ChatSessionResponder:
    def __init__(self, event_bus, project_manager, chat_module):
        self._event_bus = event_bus
        self._project_manager = project_manager
        self._chat_module = chat_module
        self._modules = {"channel_chat": chat_module}

    def set_main_chat(self, module):
        # Borrow the actual foreground runtime: one session must have one queue.
        self._modules['chat_session'] = module

    def _module_for(self, assistant_id: str):
        existing = self._modules.get(assistant_id)
        if existing is not None:
            return existing
        config = assistant_registry.require(assistant_id)
        module = ChannelChatModule(
            self._event_bus,
            self._project_manager,
            source_config=config,
            register=False,
        )
        self._modules[assistant_id] = module
        return module

    async def shutdown(self) -> None:
        for assistant_id, module in tuple(self._modules.items()):
            if assistant_id not in {"channel_chat", "chat_session"}:
                await module.shutdown()
        self._modules = {key: module for key, module in self._modules.items()
                         if key in {"channel_chat", "chat_session"}}

    async def stop(self, project_id: str, session_id: str, assistant_message_id: str) -> bool:
        for module in self._modules.values():
            if any(state.get("session_id") == session_id and state.get("assistant_message_id") == assistant_message_id
                   and state.get("project_id") == project_id and state.get("status") in {"queued", "running", "stopping"}
                   for state in module._turn_states.values()):
                return await module.stop_current(session_id, project_id=project_id, expected_message_id=assistant_message_id)
        return False

    def reply_metadata(self, turn_id: str) -> dict:
        module = next((module for module in self._modules.values() if turn_id in module._turn_states), self._chat_module)
        state = module._turn_states.get(turn_id, {})
        session = module._sessions.get(state.get('memory_key'))
        return {'model': getattr(session, 'model', '') or '',
                'engine': getattr(session, 'engine', '') or '',
                'thinking_effort': state.get('thinking_effort') or '',
                'assistant': '渠道助手'}

    async def __call__(
        self,
        project_id: str,
        session_id: str | None,
        content: str,
        assistant_id: str,
        model: str,
        on_accepted: Callable[[str], Awaitable[None]] | None = None,
        on_progress: Callable[[str], None] | None = None,
        title: str = "渠道对话",
        on_started=None,
        on_event=None,
        message_context: dict | None = None,
    ) -> tuple[str, str]:
        defaults = await asyncio.to_thread(
            config_store.get_assistant_defaults, assistant_id
        )
        engine = (defaults.get("engine") or None) if assistant_id != 'chat_session' else None
        selected_model = (model or defaults.get("model") or None) if assistant_id != 'chat_session' else None
        module = self._module_for(assistant_id)
        if session_id:
            def reuse(_project):
                row = ChatSession.select().where(
                    (ChatSession.id == session_id)
                    & (ChatSession.project_id == project_id)
                    & (ChatSession.archived == False)
                ).first()
                if row is None:
                    return False
                if title and row.title == "渠道对话":
                    row.title = title
                    row.save(only=[ChatSession.title])
                return True
            reusable = await self._project_manager.run_db(project_id, reuse)
            if not reusable:
                if assistant_id == 'chat_session':
                    raise ValueError('The main conversation changed. Please retry.')
                session_id = None
        if not session_id:
            session = await self._project_manager.run_db(
                project_id,
                lambda _project: module.create_session(
                    project_id,
                    title=title or "渠道对话",
                    engine=engine,
                    model=selected_model,
                ),
            )
            session_id = session["id"]
        expected_message_id = {"value": ""}
        queue = self._event_bus.subscribe(lambda event: (
            event.get("session_id") == session_id
            and event.get("project_id") == project_id
            and bool(expected_message_id["value"])
            and event.get("messageId") == expected_message_id["value"]
        ))
        try:
            accepted = await self._project_manager.run_db(
                project_id,
                lambda _project: module.submit_message(
                    project_id,
                    session_id,
                    content,
                    str(uuid.uuid4()),
                    engine=engine,
                    model=selected_model,
                    schedule=False,
                    message_context=message_context,
                ),
            )
            expected_message_id["value"] = str(
                getattr(accepted, "assistant_message_id", "")
                or module._turn_states.get(accepted.turn_id, {}).get(
                    "assistant_message_id", ""
                )
            )
            if not expected_message_id["value"]:
                raise RuntimeError("Channel assistant response missing message identifier")
            if on_accepted is not None:
                await on_accepted(session_id)
            if on_started is not None:
                await on_started(session_id, expected_message_id["value"], accepted.turn_id)
            module.start_queued_turn(accepted.turn_id)
            reply = ""
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=600)
                except TimeoutError as exc:
                    raise ReplyWaitTimeout from exc
                if on_event is not None:
                    await on_event(event)
                if event.get("type") == "TEXT_MESSAGE_CHUNK":
                    reply += str(event.get("delta") or "")
                    if on_progress is not None:
                        on_progress(reply)
                elif event.get("type") == "TEXT_MESSAGE_CONTENT":
                    reply = str(event.get("content") or "")
                    if on_progress is not None:
                        on_progress(reply)
                elif event.get("type") == "TEXT_MESSAGE_END":
                    status = event.get("status")
                    if status in {"stopped", "cancelled"}:
                        return session_id, "已停止。"
                    if status != "succeeded":
                        raise AssistantReplyError(str(event.get("error") or ""))
                    if event.get("content") is not None:
                        reply = str(event["content"])
                    return session_id, reply
                # Engine run events can precede response parsing and persistence.
                # Only the assistant message's terminal status decides delivery.
        finally:
            self._event_bus.unsubscribe(queue)
            await self._event_bus.publish({
                "type": "CUSTOM", "name": "channel.session_changed",
                "channel": "channel_bots", "project_id": project_id,
            })
