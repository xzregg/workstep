"""Adapter from channel messages to the existing persistent chat runtime."""

from __future__ import annotations

import asyncio
import uuid

from agent_assistants.base import assistant_registry
from agent_assistants.channel_chat import ChannelChatModule
from services.config import config_store


class ChatSessionResponder:
    def __init__(self, event_bus, project_manager, chat_module):
        self._event_bus = event_bus
        self._project_manager = project_manager
        self._chat_module = chat_module
        self._modules = {"channel_chat": chat_module}

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
            if assistant_id != "channel_chat":
                await module.shutdown()
        self._modules = {"channel_chat": self._chat_module}

    async def __call__(
        self,
        project_id: str,
        session_id: str | None,
        content: str,
        assistant_id: str,
        model: str,
    ) -> tuple[str, str]:
        defaults = config_store.get_assistant_defaults(assistant_id)
        engine = defaults.get("engine") or None
        selected_model = model or defaults.get("model") or None
        module = self._module_for(assistant_id)
        if not session_id:
            session = await self._project_manager.run_db(
                project_id,
                lambda _project: module.create_session(
                    project_id,
                    title="渠道对话",
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
                ),
            )
            expected_message_id["value"] = str(
                getattr(accepted, "assistant_message_id", "")
                or module._turn_states.get(accepted.turn_id, {}).get(
                    "assistant_message_id", ""
                )
            )
            if not expected_message_id["value"]:
                raise RuntimeError("渠道助手响应缺少消息标识")
            module.start_queued_turn(accepted.turn_id)
            reply = ""
            while True:
                event = await asyncio.wait_for(queue.get(), timeout=600)
                if event.get("type") == "TEXT_MESSAGE_CHUNK":
                    reply += str(event.get("delta") or "")
                elif event.get("type") == "TEXT_MESSAGE_CONTENT":
                    reply = str(event.get("content") or "")
                elif event.get("type") == "RUN_FINISHED":
                    return session_id, reply
                elif event.get("type") == "RUN_ERROR":
                    raise RuntimeError(str(event.get("error") or "渠道助手响应失败"))
        finally:
            self._event_bus.unsubscribe(queue)
