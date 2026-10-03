"""Persistent and in-memory adapters for assistant conversations."""

import json
import logging
from typing import Any, Callable, Protocol

from models.fields import utc_now
from .session_state import AssistantSession

logger = logging.getLogger(__name__)


class PersistenceAdapter(Protocol):
    """Optional conversation persistence for a scoped assistant session."""

    def load(self, session: AssistantSession) -> None: ...

    def save(self, session: AssistantSession) -> None: ...

    def load_history(
        self,
        project_id: str,
        scope_key: str,
    ) -> tuple[
        str, str | None, str | None, str | None, str | None, list[dict]
    ] | None:
        """Return engine, reasoning/fast/vision models, session id and messages."""
        ...

    def delete(self, project_id: str, scope_key: str) -> bool: ...


class MemoryPersistence:
    """No-op persistence — conversations live only in memory."""

    def load(self, session: AssistantSession) -> None:
        return None

    def save(self, session: AssistantSession) -> None:
        return None

    def load_history(
        self,
        project_id: str,
        scope_key: str,
    ) -> None:
        return None

    def delete(self, project_id: str, scope_key: str) -> bool:
        return False


class JsonRowPersistence:
    """Persist a conversation as a JSON blob on a peewee model.

    The model is expected to expose: ``id``, ``project_id``, the scope field
    (e.g. ``workflow_id``), ``engine``, ``model``, ``fast_model``, ``vision_model``,
    ``engine_session_id``, ``messages_json``, ``cwd`` and UTC timestamps —
    ``models/gen_session.WorkflowGenSession`` is the reference shape.
    """

    def __init__(
        self,
        model,
        scope_field: str,
        make_id: Callable[[str, str], str],
        persist_prompt: bool = True,
    ):
        self._persist_prompt = persist_prompt
        self._model = model
        self._scope_field = scope_field
        self._make_id = make_id

    def _row(self, project_id: str, scope_key: str):
        query = (self._model.project_id == project_id) & (
            getattr(self._model, self._scope_field) == scope_key
        )
        return self._model.get_or_none(query)

    def load(self, session: AssistantSession) -> None:
        if not session.scope_key:
            return
        row = self._row(session.project_id, session.scope_key)
        if row is None:
            return
        session.messages = _restore_messages(row.messages_json, persist_prompt=self._persist_prompt)
        session.resolved_session_id = row.engine_session_id
        if row.engine_state_json:
            try:
                session.engine_state = json.loads(row.engine_state_json)
            except json.JSONDecodeError:
                logger.exception("Failed to restore engine state")
        session.engine = row.engine or session.engine
        if row.model is not None:
            session.model = row.model
        if row.fast_model is not None:
            session.fast_model = row.fast_model
        if row.vision_model is not None:
            session.vision_model = row.vision_model
        if row.cwd:
            session.cwd = row.cwd

    @staticmethod
    def _dump_state(state: Any) -> str | None:
        if state is None:
            return None
        try:
            return json.dumps(state, ensure_ascii=False)
        except Exception:
            logger.exception("Failed to serialize engine state")
            return None

    def save(self, session: AssistantSession) -> None:
        if not session.scope_key:
            return
        try:
            now = utc_now()
            row = self._row(session.project_id, session.scope_key)
            stored_prompts = {
                item.get("id"): item.get("prompt")
                for item in _restore_messages(row.messages_json) if item.get("prompt")
            } if row is not None and self._persist_prompt else {}
            messages = [
                {key: value for key, value in item.items() if self._persist_prompt or key != "prompt"}
                for item in session.messages
            ]
            for item in messages:
                if not item.get("prompt") and stored_prompts.get(item.get("id")):
                    item["prompt"] = stored_prompts[item["id"]]
            payload = json.dumps(messages, ensure_ascii=False)
            if row is None:
                self._model.create(
                    id=self._make_id(session.project_id, session.scope_key),
                    project_id=session.project_id,
                    **{self._scope_field: session.scope_key},
                    engine=session.engine,
                    model=session.model,
                    fast_model=session.fast_model,
                    vision_model=session.vision_model,
                    engine_session_id=session.resolved_session_id,
                    engine_state_json=self._dump_state(session.engine_state),
                    messages_json=payload,
                    cwd=session.cwd,
                    created_at=now,
                    updated_at=now,
                )
            else:
                row.engine = session.engine
                row.model = session.model
                row.fast_model = session.fast_model
                row.vision_model = session.vision_model
                row.engine_session_id = session.resolved_session_id
                row.engine_state_json = self._dump_state(session.engine_state)
                row.messages_json = payload
                row.cwd = session.cwd
                row.updated_at = now
                row.save()
        except Exception:
            logger.exception("Failed to persist assistant session")

    def load_history(
        self,
        project_id: str,
        scope_key: str,
    ) -> tuple[
        str, str | None, str | None, str | None, str | None, list[dict]
    ] | None:
        row = self._row(project_id, scope_key)
        if row is None:
            return None
        return (
            row.engine,
            row.model,
            row.fast_model,
            row.vision_model,
            row.engine_session_id,
            _restore_messages(row.messages_json, persist_prompt=self._persist_prompt),
        )

    def delete(self, project_id: str, scope_key: str) -> bool:
        query = (self._model.project_id == project_id) & (
            getattr(self._model, self._scope_field) == scope_key
        )
        return self._model.delete().where(query).execute() > 0


def _restore_messages(raw: str | None, *, persist_prompt: bool = True) -> list[dict]:
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return []
    if not isinstance(parsed, list):
        return []
    return [
        {key: value for key, value in item.items() if persist_prompt or key != "prompt"}
        for item in parsed
        if isinstance(item, dict) and item.get("role") in {"user", "assistant"}
    ]
