"""Chat-session engine handoff and native/history-backed forks."""

import asyncio
import json
import logging
import uuid
from typing import Any

from agent_assistants.base import validate_provider_override
from agent_assistants.chat_row_persistence import ChatRowPersistence, _from_iso
from agent_assistants.context_handoff import append_handoff_log, compile_handoff
from engines.core.registry import create_engine
from models.chat_session import ChatMessage, ChatSession
from models.fields import utc_now
from services.chat_permissions import is_valid_permission_mode

logger = logging.getLogger(__name__)


class ChatSessionTransitions:
    """Session transitions; mixed into ChatSessionModule for its runtime state."""

    def handoff_session(
        self,
        project_id: str,
        session_id: str,
        *,
        engine: str,
        context_mode: str,
        model: str | None = None,
        fast_model: str | None = None,
        vision_model: str | None = None,
        provider_id: str | None = None,
        permission_mode: str | None = None,
    ) -> dict:
        """Switch engines while keeping the same visible chat session."""
        if context_mode not in {"smart", "full", "none"}:
            raise ValueError(f"Unsupported handoff context mode: {context_mode}")
        if any(
            state.get("session_id") == session_id
            and state.get("status") in {"queued", "running", "stopping"}
            for state in self._turn_states.values()
        ):
            raise ValueError("Chat session is running")
        self._validate_engine(engine)
        permission_mode = (permission_mode or "").strip()
        if permission_mode and not is_valid_permission_mode(permission_mode):
            raise ValueError(f"Unsupported permission mode: {permission_mode}")

        normalized_provider = validate_provider_override(
            provider_id,
            engine,
        )

        with self._project_ctx(project_id) as project:
            row = ChatSession.get_or_none(
                ChatSession.id == session_id,
            )
            if row is None:
                raise ValueError("Chat session not found")
            provider_changed = (row.provider_id or "") != normalized_provider
            if row.engine == engine and not provider_changed:
                raise ValueError("Target engine is already active")
            if ChatMessage.select().where(
                ChatMessage.session == row,
                ChatMessage.status == "running",
            ).exists():
                raise ValueError("Chat session is running")
            source_engine = row.engine
            source_provider = row.provider_id or ""
            messages = ChatRowPersistence()._load_messages(row)
            metadata = append_handoff_log(
                project.workstep_dir,
                session_id,
                messages,
                source_engine=source_engine,
                target_engine=engine,
                mode=context_mode,
                source_provider=source_provider,
                target_provider=normalized_provider,
            )
            row.engine = engine
            row.model = model or None
            row.fast_model = fast_model or None
            row.vision_model = vision_model or None
            row.provider_id = normalized_provider or None
            if permission_mode:
                row.permission_mode = permission_mode
            row.engine_session_id = None
            row.engine_state_json = None
            row.fork_context_mode = context_mode
            row.fork_context_json = json.dumps(metadata, ensure_ascii=False)
            row.updated_at = utc_now()
            row.save()

        memory_key, _ = self._session_identity(project_id, session_id)
        session = self._sessions.get(memory_key)
        if session is not None:
            session.engine = engine
            session.model = model or None
            session.fast_model = fast_model or None
            session.vision_model = vision_model or None
            session.resolved_session_id = None
            session.engine_state = None
            session.extra["pending_handoff"] = metadata
        result = self.get_session(project_id, session_id)
        if result is None:
            raise ValueError("Chat session not found")
        return result

    async def fork_session(
        self,
        project_id: str,
        source_session_id: str,
        *,
        title: str,
        engine: str,
        context_mode: str,
        model: str | None = None,
        fast_model: str | None = None,
        vision_model: str | None = None,
        provider_id: str | None = None,
        permission_mode: str | None = None,
        fork_message_id: str | None = None,
    ) -> dict:
        """Fork one stable chat session through a native or handoff strategy."""
        title = (title or "").strip()
        if not title:
            raise ValueError("Session title cannot be empty")
        if context_mode not in {"native", "smart", "full", "none"}:
            raise ValueError(f"Unsupported fork context mode: {context_mode}")
        if any(
            state.get("session_id") == source_session_id
            and state.get("status") in {"queued", "running", "stopping"}
            for state in self._turn_states.values()
        ):
            raise ValueError("Chat session is running")
        def load_source():
            source = ChatSession.get_or_none(
                ChatSession.id == source_session_id,
            )
            if source is None:
                raise ValueError("Chat session not found")
            if ChatMessage.select().where(
                ChatMessage.session == source,
                ChatMessage.status == "running",
            ).exists():
                raise ValueError("Chat session is running")
            messages = ChatRowPersistence()._load_messages(source)
            fork_at_tail = True
            if fork_message_id:
                selected_index = next(
                    (
                        index
                        for index, item in enumerate(messages)
                        if item.get("id") == fork_message_id
                    ),
                    None,
                )
                if selected_index is None:
                    raise ValueError("Fork message not found")
                fork_at_tail = selected_index == len(messages) - 1
                messages = messages[: selected_index + 1]
            fork_point = messages[-1].get("id") if messages else None
            source_engine = source.engine
            source_engine_session_id = source.engine_session_id
            source_workflow_id = source.workflow_id
            source_model = source.model
            source_fast_model = source.fast_model
            source_vision_model = source.vision_model
            source_provider_id = source.provider_id
            source_permission_mode = source.permission_mode
            return {
                "messages": messages,
                "fork_at_tail": fork_at_tail,
                "fork_point": fork_point,
                "engine": source_engine,
                "engine_session_id": source_engine_session_id,
                "workflow_id": source_workflow_id,
                "model": source_model,
                "fast_model": source_fast_model,
                "vision_model": source_vision_model,
                "provider_id": source_provider_id,
                "permission_mode": source_permission_mode,
            }

        source_data = await self._project_manager.run_db(
            project_id, lambda _project: load_source()
        )
        messages = source_data["messages"]
        fork_at_tail = source_data["fork_at_tail"]
        fork_point = source_data["fork_point"]
        source_engine = source_data["engine"]
        source_engine_session_id = source_data["engine_session_id"]
        source_workflow_id = source_data["workflow_id"]
        source_model = source_data["model"]
        source_fast_model = source_data["fast_model"]
        source_vision_model = source_data["vision_model"]
        source_provider_id = source_data["provider_id"]
        source_permission_mode = source_data["permission_mode"]

        await asyncio.to_thread(self._validate_engine, engine)
        effective_context_mode = context_mode
        native_engine_session_id: str | None = None
        package: dict[str, Any] | None = None
        adapter = None
        if context_mode == "native":
            if not fork_at_tail:
                raise ValueError("Native fork only supports the latest message; use smart handoff")
            if not messages and not source_engine_session_id:
                effective_context_mode = "none"
            elif engine != source_engine:
                raise ValueError("Native fork requires the same engine")
            elif (provider_id or "").strip() and (provider_id or "").strip() != (source_provider_id or "").strip():
                # 引擎会话端点与供应商绑定：换供应商时不能直接 fork 原生会话。
                raise ValueError("Native fork requires the same provider; use smart handoff")
            else:
                adapter = await asyncio.to_thread(create_engine, engine)
                if adapter is None or not adapter.supports_session_fork:
                    raise ValueError("Selected engine does not support native session fork")
            if effective_context_mode == "native" and not source_engine_session_id:
                if messages:
                    raise ValueError("Source engine session is unavailable; use smart handoff")
                effective_context_mode = "none"
        else:
            package = compile_handoff(
                messages,
                context_mode,
                source_session_id=source_session_id,
                forked_from_message_id=fork_point,
            )

        if engine == source_engine:
            model = source_model if model is None else model
            fast_model = source_fast_model if fast_model is None else fast_model
            vision_model = source_vision_model if vision_model is None else vision_model
            provider_id = source_provider_id if provider_id is None else provider_id

        created = await self._project_manager.run_db(
            project_id,
            lambda _project: self.create_session(
                project_id,
                source_workflow_id,
                title=title,
                engine=engine,
                model=model,
                fast_model=fast_model,
                vision_model=vision_model,
                provider_id=provider_id,
                permission_mode=permission_mode or source_permission_mode,
            ),
        )
        new_session_id = created["id"]
        try:
            def persist_fork():
                with ChatSession._meta.database.atomic():
                    target = ChatSession.get_by_id(new_session_id)
                    target.parent_session_id = source_session_id
                    target.forked_from_message_id = fork_point
                    target.fork_context_mode = effective_context_mode
                    target.fork_context_json = (
                        json.dumps(package, ensure_ascii=False) if package else None
                    )
                    target.engine_session_id = None
                    target.engine_state_json = None
                    target.fork_status = (
                        "pending"
                        if effective_context_mode == "native" and source_engine_session_id
                        else "ready"
                    )
                    target.save()
                    if effective_context_mode != "none":
                        for item in messages:
                            ChatMessage.create(
                                id=str(uuid.uuid4()),
                                session=target,
                                role=item["role"],
                                content=item.get("content", ""),
                                author_id=item.get("author_id"),
                                author_name=item.get("author_name"),
                                author_device_id=item.get("author_device_id"),
                                author_device_name=item.get("author_device_name"),
                                status=item.get("status"),
                                engine=item.get("engine"),
                                model=item.get("model"),
                                created_at=_from_iso(item.get("created_at")) or utc_now(),
                                ended_at=_from_iso(item.get("ended_at")),
                            )
            await self._project_manager.run_db(
                project_id, lambda _project: persist_fork()
            )
            if effective_context_mode == "native" and source_engine_session_id:
                native_engine_session_id = await adapter.fork_session(
                    source_engine_session_id,
                    await asyncio.to_thread(self._cwd, project_id),
                    fork_point=fork_point,
                    model=model,
                    provider_id=provider_id,
                )
                if not native_engine_session_id:
                    raise ValueError("Native session fork failed")
                def mark_ready():
                    ChatSession.update(
                        engine_session_id=native_engine_session_id,
                        fork_status="ready",
                    ).where(ChatSession.id == new_session_id).execute()
                await self._project_manager.run_db(
                    project_id, lambda _project: mark_ready()
                )
        except Exception:
            def discard_fork():
                ChatMessage.delete().where(ChatMessage.session == new_session_id).execute()
                ChatSession.delete().where(ChatSession.id == new_session_id).execute()
            await self._project_manager.run_db(
                project_id, lambda _project: discard_fork()
            )
            if native_engine_session_id and adapter is not None:
                try:
                    await adapter.close_session(
                        native_engine_session_id,
                        await asyncio.to_thread(self._cwd, project_id),
                    )
                except Exception:
                    logger.exception("Failed to clean up native fork %s", native_engine_session_id)
            raise
        return await self._project_manager.run_db(
            project_id,
            lambda _project: self.get_session(project_id, new_session_id),
        )
