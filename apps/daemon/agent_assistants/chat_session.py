"""Codex-style session chat assistant (per project, multiple sessions).

One assistant registered in the shared assistant layer
(``agent_assistants/base.py``): it only declares an ``AssistantConfig``
plus a persistence adapter that stores each conversation row in the new
``chat_sessions`` / ``chat_messages`` tables. Session lifecycle, idempotency,
engine invocation with resume and streaming events all live in the generic
``AssistantRuntime``.

Each project can hold many independent sessions. Sessions are created
explicitly (``create_session``), auto-titled from the first user message,
and can be renamed or deleted. Quick-action buttons above the composer are
configured per project via the ``project_settings`` table.
"""

import json
import logging
import peewee as pw
import re
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from engines.core.registry import COORDINATOR_FALLBACK_ORDER, create_engine
from models.chat_session import ChatMessage, ChatSession, ProjectSetting
from models.fields import utc_now
from agent_assistants.base import (
    AssistantConfig,
    AssistantRuntime,
    PersistenceAdapter,
    SCOPE_CHAT,
    assistant_registry,
)
from services.chat_permissions import is_valid_permission_mode
from services.config import config_store

logger = logging.getLogger(__name__)

CHAT_CHANNEL = "session_chat"

MAX_HISTORY_TURNS = 8
MAX_SESSIONS = 200
SESSION_TTL_SECONDS = 60 * 60

QUICK_BUTTONS_KEY = "chat_quick_buttons"
SYSTEM_PROMPT_KEY = "chat_system_prompt"
MAX_SYSTEM_PROMPT_LENGTH = 20000
MAX_QUICK_BUTTONS = 20
MAX_QUICK_BUTTON_LABEL = 40
MAX_QUICK_BUTTON_PROMPT = 400
DEFAULT_TITLE_LENGTH = 40
PREVIEW_LENGTH = 60
ENHANCE_MAX_LENGTH = 4000

ENHANCE_SYSTEM_PROMPT = (
    "你是提示词改写助手。把用户输入的提示词改写为更清晰、具体、可直接执行的版本："
    "明确目标、补充必要的上下文与约束、定义期望的输出格式与语气；不要改变用户原意。"
    "只输出改写后的提示词本身，不要任何解释、前后缀或 Markdown 代码块。"
)

SYSTEM_PROMPT = """你是 WorkStep 的会话聊天助手（Codex 式通用编码对话）。你以当前项目目录为工作环境，帮助用户完成编程与研发相关任务：回答问题、解释代码与项目结构、生成方案与实现思路、设计单元测试、评审代码质量、排查问题等。

工作方式：
1. 多轮对话保持上下文连贯；信息不足时先简短追问，不要长篇罗列假设。
2. 回复精炼、直接、可操作；给出代码时使用 Markdown 代码块。
3. 当前版本你只输出文本回复，不直接创建或修改项目文件；涉及文件改动时给出清晰的改动计划并等待用户确认。
4. 默认使用与用户相同的语言回复。"""


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


def _from_iso(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def _load_json(raw: str | None, default):
    if not raw:
        return default
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return default


def _preview(text: str, limit: int) -> str:
    collapsed = re.sub(r"\s+", " ", text or "").strip()
    return collapsed if len(collapsed) <= limit else f"{collapsed[:limit]}…"


def _extract_usage(events: list | None) -> dict | None:
    for event in events or []:
        if isinstance(event, dict) and event.get("type") == "usage":
            data = event.get("data")
            return data if isinstance(data, dict) else dict(event)
    return None


class ChatRowPersistence(PersistenceAdapter):
    """Persist one chat conversation as rows in chat_sessions / chat_messages."""

    # ── session / messages loading ─────────────────────────────────────

    def load(self, session) -> None:
        row = ChatSession.get_or_none(ChatSession.id == session.session_id)
        if row is None:
            return
        session.messages = self._load_messages(row)
        session.resolved_session_id = row.engine_session_id
        if row.engine_state_json:
            try:
                session.engine_state = json.loads(row.engine_state_json)
            except json.JSONDecodeError:
                logger.exception("Failed to restore chat engine state")
        session.engine = row.engine or session.engine
        if row.model is not None:
            session.model = row.model
        if row.fast_model is not None:
            session.fast_model = row.fast_model

    def _load_messages(self, row: ChatSession) -> list[dict]:
        messages: list[dict] = []
        rows = (
            ChatMessage.select()
            .where(ChatMessage.session == row)
            .order_by(ChatMessage.created_at, ChatMessage.id)
        )
        for item in rows:
            message: dict = {
                "role": item.role,
                "content": item.content,
                "id": item.id,
                "created_at": _iso(item.created_at),
            }
            if item.status:
                message["status"] = item.status
            if item.engine:
                message["engine"] = item.engine
            if item.model:
                message["model"] = item.model
            if item.prompt:
                message["prompt"] = item.prompt
            if item.ended_at:
                message["ended_at"] = _iso(item.ended_at)
            events = _load_json(item.events_json, [])
            if events:
                message["events"] = events
            messages.append(message)
        return messages

    # ── save ───────────────────────────────────────────────────────────

    def save(self, session) -> None:
        now = utc_now()
        row = ChatSession.get_or_none(ChatSession.id == session.session_id)
        if row is None:
            row = ChatSession.create(
                id=session.session_id,
                project_id=session.project_id,
                workflow_id=session.scope_key or "",
                title=self._default_title(session.messages),
                engine=session.engine,
                model=session.model,
                fast_model=session.fast_model,
                engine_session_id=session.resolved_session_id,
                engine_state_json=self._dump_state(session.engine_state),
                created_at=now,
                updated_at=now,
            )
        else:
            title = row.title or self._default_title(session.messages)
            row.title = title
            row.engine = session.engine
            row.model = session.model
            row.fast_model = session.fast_model
            row.engine_session_id = session.resolved_session_id
            row.engine_state_json = self._dump_state(session.engine_state)
            row.updated_at = now
            row.save()
        for item in session.messages:
            message_id = str(item.get("id") or "")
            if not message_id or ChatMessage.get_or_none(ChatMessage.id == message_id):
                continue
            created_at = _from_iso(item.get("created_at")) or now
            ended_at = _from_iso(item.get("ended_at"))
            events = [e for e in (item.get("events") or []) if isinstance(e, dict)]
            ChatMessage.create(
                id=message_id,
                session=row,
                role=item.get("role", "assistant"),
                content=item.get("content", ""),
                status=item.get("status") or (
                    "succeeded" if item.get("role") == "assistant" else None
                ),
                engine=item.get("engine"),
                model=item.get("model"),
                prompt=item.get("prompt"),
                events_json=json.dumps(events, ensure_ascii=False) if events else None,
                usage_json=(
                    json.dumps(_extract_usage(events), ensure_ascii=False)
                    if _extract_usage(events)
                    else None
                ),
                created_at=created_at,
                ended_at=ended_at,
            )

    @staticmethod
    def _default_title(messages: list[dict]) -> str:
        """Auto-title from the first user message, using its first sentence."""
        for item in messages:
            if item.get("role") != "user":
                continue
            text = re.sub(r"\s+", " ", item.get("content") or "").strip()
            if not text:
                continue
            sentence = re.split(r"[。！？!?；;…]", text, maxsplit=1)[0].strip()
            if not sentence:
                sentence = text
            return _preview(sentence, DEFAULT_TITLE_LENGTH)
        return ""

    @staticmethod
    def _dump_state(state: Any) -> str | None:
        if state is None:
            return None
        try:
            return json.dumps(state, ensure_ascii=False)
        except Exception:
            logger.exception("Failed to serialize chat engine state")
            return None

    # ── history / delete ───────────────────────────────────────────────

    def load_history(
        self,
        project_id: str,
        scope_key: str,
    ) -> tuple[str, str | None, str | None, str | None, list[dict]] | None:
        row = ChatSession.get_or_none(ChatSession.id == scope_key)
        if row is None:
            return None
        return (
            row.engine,
            row.model,
            row.fast_model,
            row.engine_session_id,
            self._load_messages(row),
        )

    def delete(self, project_id: str, scope_key: str) -> bool:
        row = ChatSession.get_or_none(ChatSession.id == scope_key)
        if row is None:
            return False
        ChatMessage.delete().where(ChatMessage.session == row).execute()
        row.delete_instance()
        return True


@dataclass(frozen=True, slots=True)
class ChatAccepted:
    session_id: str
    turn_id: str
    status: str

    def to_dict(self) -> dict:
        return {
            "session_id": self.session_id,
            "turn_id": self.turn_id,
            "status": self.status,
        }


DEFAULT_QUICK_BUTTONS = [
    {"id": "generate", "label": "生成实现", "prompt": "请根据当前项目目标，给出完整的实现方案与关键代码（只输出方案，不创建文件）。"},
    {"id": "explain", "label": "解释代码", "prompt": "请解释当前项目中最相关的一段代码或模块结构，说明职责、调用关系与关键实现细节。"},
    {"id": "test", "label": "设计测试", "prompt": "请为当前项目设计单元测试：列出测试文件、关键用例与断言思路（只输出设计，不创建文件）。"},
    {"id": "review", "label": "代码评审", "prompt": "请评审当前项目的代码质量、潜在缺陷与改进建议，按优先级列出。"},
]


class ChatSessionModule(AssistantRuntime):
    """The Codex-style session chat assistant — config + row persistence."""

    def __init__(self, event_bus, project_manager):
        config = AssistantConfig(
            name="chat_session",
            channel=CHAT_CHANNEL,
            system_prompt=SYSTEM_PROMPT,
            scope=SCOPE_CHAT,
            engine_label="Chat engine",
            max_history_turns=MAX_HISTORY_TURNS,
            max_sessions=MAX_SESSIONS,
            session_ttl_seconds=SESSION_TTL_SECONDS,
            persistence=ChatRowPersistence(),
            validate_engine=self._validate_engine,
        )
        super().__init__(config, event_bus, project_manager)
        assistant_registry.register(config)

    # ── session CRUD ───────────────────────────────────────────────────

    def list_sessions(self, project_id: str, workflow_id: str | None = None) -> list[dict]:
        if not project_id:
            raise ValueError("project_id is required")
        with self._project_ctx(project_id):
            rows = (
                ChatSession.select()
                .where(
                    ChatSession.project_id == project_id,
                )
                .order_by(ChatSession.sort_order, ChatSession.updated_at.desc())
            )
            return [self._session_summary(row) for row in rows]

    def create_session(
        self,
        project_id: str,
        workflow_id: str | None = None,
        title: str | None = None,
        engine: str | None = None,
        model: str | None = None,
        fast_model: str | None = None,
        permission_mode: str | None = None,
    ) -> dict:
        if not project_id:
            raise ValueError("project_id is required")
        permission_mode = (permission_mode or "").strip()
        if permission_mode and not is_valid_permission_mode(permission_mode):
            raise ValueError(f"Unsupported permission mode: {permission_mode}")
        engine_id, default_model, default_fast_model = self._resolve_engine_models()
        if engine:
            self._validate_engine(engine)
            engine_id = engine
        model = model or default_model
        fast_model = fast_model or default_fast_model
        session_id = str(uuid.uuid4())
        now = utc_now()
        with self._project_ctx(project_id):
            min_order = (
                ChatSession.select(pw.fn.MIN(ChatSession.sort_order))
                .where(
                    ChatSession.project_id == project_id,
                )
                .scalar()
            )
            ChatSession.create(
                id=session_id,
                project_id=project_id,
                workflow_id=workflow_id or "",
                sort_order=(min_order or 0) - 1,
                title=(title or "").strip(),
                engine=engine_id,
                model=model,
                fast_model=fast_model,
                permission_mode=permission_mode or None,
                created_at=now,
                updated_at=now,
            )
        return self.get_session(project_id, session_id)

    def get_session(self, project_id: str, session_id: str) -> dict | None:
        with self._project_ctx(project_id):
            row = ChatSession.get_or_none(ChatSession.id == session_id)
            if row is None:
                return None
            summary = self._session_summary(row)
        history = self.history(project_id, session_id) or {}
        return {**summary, "messages": history.get("messages", [])}

    def rename_session(
        self,
        project_id: str,
        session_id: str,
        title: str,
    ) -> dict | None:
        title = (title or "").strip()
        if not title:
            raise ValueError("Session title cannot be empty")
        with self._project_ctx(project_id):
            row = ChatSession.get_or_none(ChatSession.id == session_id)
            if row is None:
                return None
            row.title = title
            row.updated_at = utc_now()
            row.save()
            return self._session_summary(row)

    def delete_session(self, project_id: str, session_id: str) -> bool:
        with self._project_ctx(project_id):
            if ChatSession.get_or_none(ChatSession.id == session_id) is None:
                raise ValueError("Chat session not found")
        memory_key, sid = self._session_identity(project_id, session_id)
        return self.reset_scoped_session(project_id, session_id, memory_key, sid)


    def reorder_sessions(
        self,
        project_id: str,
        ordered_ids: list[str],
    ) -> None:
        """Reassign sort_order from an explicit id list; unknown ids keep their
        relative order at the end of the list."""
        if not project_id:
            raise ValueError("project_id is required")
        with self._project_ctx(project_id):
            rows = list(
                ChatSession.select()
                .where(
                    ChatSession.project_id == project_id,
                )
                .order_by(ChatSession.sort_order, ChatSession.updated_at.desc())
            )
            by_id = {row.id: row for row in rows}
            seen: set[str] = set()
            ordered: list[ChatSession] = []
            for session_id in ordered_ids:
                row = by_id.get(session_id)
                if row is not None and session_id not in seen:
                    ordered.append(row)
                    seen.add(session_id)
            for row in rows:
                if row.id not in seen:
                    ordered.append(row)
            for index, row in enumerate(ordered):
                if row.sort_order != index:
                    row.sort_order = index
                    row.save()

    def _session_summary(self, row: ChatSession) -> dict:
        last = (
            ChatMessage.select()
            .where(ChatMessage.session == row)
            .order_by(ChatMessage.created_at.desc())
            .first()
        )
        return {
            "id": row.id,
            "project_id": row.project_id,
            "workflow_id": row.workflow_id,
            "title": row.title or "未命名会话",
            "engine": row.engine,
            "model": row.model,
            "permission_mode": row.permission_mode or "",
            "message_count": ChatMessage.select()
            .where(ChatMessage.session == row)
            .count(),
            "preview": _preview(last.content, PREVIEW_LENGTH) if last else "",
            "created_at": _iso(row.created_at),
            "updated_at": _iso(row.updated_at),
        }

    # ── turn submission ────────────────────────────────────────────────

    def submit_message(
        self,
        project_id: str,
        session_id: str,
        content: str,
        idempotency_key: str,
        engine: str | None = None,
        model: str | None = None,
        fast_model: str | None = None,
        thinking_effort: str | None = None,
        permission_mode: str | None = None,
        plan_mode: bool | None = None,
    ) -> ChatAccepted:
        if not session_id:
            raise ValueError("Chat session id is required")
        permission_mode = (permission_mode or "").strip()
        if permission_mode and not is_valid_permission_mode(permission_mode):
            raise ValueError(f"Unsupported permission mode: {permission_mode}")
        with self._project_ctx(project_id):
            if ChatSession.get_or_none(ChatSession.id == session_id) is None:
                raise ValueError("Chat session not found")
            if permission_mode:
                ChatSession.update(permission_mode=permission_mode).where(
                    ChatSession.id == session_id
                ).execute()
        memory_key, resolved_sid = self._session_identity(project_id, session_id)
        accepted = super().submit_message(
            project_id,
            content,
            idempotency_key,
            session_id=resolved_sid,
            memory_key=memory_key,
            scope_key=session_id,
            idempotency_sid=session_id,
            engine=engine,
            model=model,
            fast_model=fast_model,
            thinking_effort=thinking_effort,
            permission_mode=permission_mode or None,
            plan_mode=plan_mode,
        )
        return ChatAccepted(
            session_id=accepted.session_id,
            turn_id=accepted.turn_id,
            status=accepted.status,
        )

    @staticmethod
    def _session_identity(
        project_id: str,
        session_id: str,
    ) -> tuple[tuple, str]:
        """Map one chat session row to (memory key, canonical sid)."""
        return ("chat", project_id, session_id), session_id

    # ── per-project system prompt ─────────────────────────────────────

    def _build_prompt(self, session) -> str:
        """Use the project-configured system prompt (default when unset)."""
        prompt = self.get_system_prompt(session.project_id)
        engine = create_engine(session.engine)
        if engine is not None and engine.supports_resume:
            user_message = (
                session.messages[-1]["content"] if session.messages else ""
            )
            head = prompt if not session.resolved_session_id else ""
            return f"{head}\n\n{user_message}"
        turns = session.messages[-self._config.max_history_turns * 2:]
        history = "\n\n".join(
            f"{'用户' if item['role'] == 'user' else '助手'}：{item['content']}"
            for item in turns
        )
        return f"{prompt}\n\n历史对话：\n{history}\n\n请继续。"

    def get_system_prompt(self, project_id: str) -> str:
        """Return the project's configured chat prompt or the default."""
        with self._project_ctx(project_id):
            row = ProjectSetting.get_or_none(
                ProjectSetting.project_id == project_id,
                ProjectSetting.key == SYSTEM_PROMPT_KEY,
            )
        if row is None:
            return SYSTEM_PROMPT
        prompt = _load_json(row.value_json, "")
        return prompt if isinstance(prompt, str) and prompt.strip() else SYSTEM_PROMPT

    def set_system_prompt(self, project_id: str, prompt: str) -> str:
        """Persist the project's chat prompt; empty input restores the default."""
        prompt = (prompt or "").strip()
        now = utc_now()
        with self._project_ctx(project_id):
            row = ProjectSetting.get_or_none(
                ProjectSetting.project_id == project_id,
                ProjectSetting.key == SYSTEM_PROMPT_KEY,
            )
            if not prompt:
                if row is not None:
                    row.delete_instance()
                return SYSTEM_PROMPT
            if len(prompt) > MAX_SYSTEM_PROMPT_LENGTH:
                raise ValueError(
                    f"系统提示词不能超过 {MAX_SYSTEM_PROMPT_LENGTH} 字"
                )
            payload = json.dumps(prompt, ensure_ascii=False)
            if row is None:
                ProjectSetting.create(
                    id=str(uuid.uuid4()),
                    project_id=project_id,
                    key=SYSTEM_PROMPT_KEY,
                    value_json=payload,
                    updated_at=now,
                )
            else:
                row.value_json = payload
                row.updated_at = now
                row.save()
        return prompt

    async def enhance_prompt(self, project_id: str, prompt: str) -> str:
        """Rewrite a draft prompt into a clearer version via the default engine."""
        from agent_assistants.base import invoke_engine

        prompt = (prompt or "").strip()
        if not prompt:
            raise ValueError("提示词不能为空")
        if len(prompt) > ENHANCE_MAX_LENGTH:
            raise ValueError(f"提示词不能超过 {ENHANCE_MAX_LENGTH} 字")
        engine_id, model, _ = self._resolve_engine_models()
        with self._project_ctx(project_id) as project:
            cwd = str(project.path)
        raw, _events, _session_id = await invoke_engine(
            engine_id,
            model,
            cwd,
            f"{ENHANCE_SYSTEM_PROMPT}\n\n用户提示词：\n{prompt}",
            None,
            None,
            error_prefix="Enhance engine",
        )
        result = raw.strip()
        if not result:
            raise ValueError("提示词增强失败，请重试")
        return result

    # ── engine / model resolution ──────────────────────────────────────

    @staticmethod
    def _fallback_engine(default_engine_id: str) -> tuple[str, object | None]:
        candidates = [default_engine_id] + [
            key for key in COORDINATOR_FALLBACK_ORDER if key != default_engine_id
        ]
        for candidate in candidates:
            engine = create_engine(candidate)
            if engine is not None and engine.capabilities.supports_coordinator:
                return candidate, engine
        return default_engine_id, None

    def _resolve_engine_models(self) -> tuple[str, str | None, str | None]:
        configured_id = config_store.get_coordinator_default_engine() or "claude"
        engine_id, engine = self._fallback_engine(configured_id)
        if engine is None:
            raise ValueError(f"Chat engine is unavailable: {engine_id}")
        if engine_id == configured_id:
            model = (
                config_store.get_coordinator_default_model()
                or config_store.get_engine_default_model(engine_id)
                or None
            )
        else:
            model = config_store.get_engine_default_model(engine_id) or None
        get_fast_model = getattr(
            config_store,
            "get_coordinator_default_fast_model",
            lambda: "",
        )
        fast_model = (get_fast_model() if engine_id == configured_id else "") or model
        return engine_id, model, fast_model

    def _validate_engine(self, engine_id: str) -> None:
        candidate = create_engine(engine_id)
        if candidate is None or not candidate.capabilities.supports_coordinator:
            raise ValueError(f"Chat engine is unavailable: {engine_id}")

    # ── per-project quick buttons ──────────────────────────────────────

    def get_quick_buttons(self, project_id: str) -> list[dict]:
        with self._project_ctx(project_id):
            row = ProjectSetting.get_or_none(
                ProjectSetting.project_id == project_id,
                ProjectSetting.key == QUICK_BUTTONS_KEY,
            )
            if row is None:
                return [dict(item) for item in DEFAULT_QUICK_BUTTONS]
            buttons = _load_json(row.value_json, None)
            if not isinstance(buttons, list):
                return [dict(item) for item in DEFAULT_QUICK_BUTTONS]
            return [
                dict(item)
                for item in buttons
                if isinstance(item, dict)
                and item.get("label")
                and item.get("prompt")
            ]

    def set_quick_buttons(self, project_id: str, buttons: list) -> list[dict]:
        if not isinstance(buttons, list) or len(buttons) > MAX_QUICK_BUTTONS:
            raise ValueError(f"最多配置 {MAX_QUICK_BUTTONS} 个快捷按钮")
        cleaned: list[dict] = []
        seen: set[str] = set()
        for item in buttons:
            if not isinstance(item, dict):
                raise ValueError("快捷按钮格式无效")
            label = str(item.get("label") or "").strip()
            prompt = str(item.get("prompt") or "").strip()
            if not label:
                raise ValueError("快捷按钮标签不能为空")
            if len(label) > MAX_QUICK_BUTTON_LABEL:
                raise ValueError(f"快捷按钮标签不能超过 {MAX_QUICK_BUTTON_LABEL} 字")
            if not prompt:
                raise ValueError("快捷按钮提示词不能为空")
            if len(prompt) > MAX_QUICK_BUTTON_PROMPT:
                raise ValueError(f"快捷按钮提示词不能超过 {MAX_QUICK_BUTTON_PROMPT} 字")
            button_id = str(item.get("id") or str(uuid.uuid4()))
            if button_id in seen:
                raise ValueError("快捷按钮 id 重复")
            seen.add(button_id)
            cleaned.append({"id": button_id, "label": label, "prompt": prompt})
        now = utc_now()
        with self._project_ctx(project_id):
            row = ProjectSetting.get_or_none(
                ProjectSetting.project_id == project_id,
                ProjectSetting.key == QUICK_BUTTONS_KEY,
            )
            payload = json.dumps(cleaned, ensure_ascii=False)
            if row is None:
                ProjectSetting.create(
                    id=str(uuid.uuid4()),
                    project_id=project_id,
                    key=QUICK_BUTTONS_KEY,
                    value_json=payload,
                    updated_at=now,
                )
            else:
                row.value_json = payload
                row.updated_at = now
                row.save()
        return cleaned
