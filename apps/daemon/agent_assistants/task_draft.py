"""Ephemeral task-creation assistant.

The assistant uses the coordinator-capable engine configuration and project
context, but it never creates a Task row.  A task exists only after the user
accepts the generated description and submits the ordinary create-task form.
"""

import json
import re
import uuid
from dataclasses import dataclass

from engines.core.registry import COORDINATOR_FALLBACK_ORDER, create_engine
from services.assistant_base import (
    AssistantConfig,
    AssistantRuntime,
    SCOPE_EPHEMERAL,
    assistant_registry,
    extract_streaming_reply,
)
from services.config import config_store
from services.workflow_definition import WorkflowDefinition


TASK_CREATE_CHANNEL = "task_create"
MAX_HISTORY_TURNS = 8

SYSTEM_PROMPT = """你是 WorkStep 的任务创建 Agent。你通过多轮对话帮助用户把一个已有标题的任务整理成清晰、可执行的 Markdown 任务描述。

工作方式：
1. 结合项目记忆、所选工作流、起始阶段、任务标题和当前描述理解任务。
2. 信息不足时，只追问当前最关键的问题，此时 task_draft 必须为 null。
3. 信息足够时生成完整任务描述，覆盖目标、背景、范围、约束和可验证的验收标准；同时根据任务内容选择最合适的起始阶段。例如纯测试任务应直接选择测试阶段，跳过研发阶段。不要修改标题、工作流、评审设置或自动开始设置。
4. 用户后续提出调整时，始终返回完整描述，不要只返回增量。

回复必须是合法 JSON：
{"reply":"给用户看的自然语言回复（Markdown）","task_draft":{"description":"完整 Markdown 任务描述","start_step_key":"所选工作流中的阶段 key"}}
尚需澄清时使用：{"reply":"澄清问题","task_draft":null}
不要在 reply 中重复输出完整任务描述。"""


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


class TaskDraftModule(AssistantRuntime):
    """Task Agent creation mode backed by an in-memory assistant session."""

    def __init__(self, event_bus, project_manager):
        config = AssistantConfig(
            name="task_create",
            channel=TASK_CREATE_CHANNEL,
            system_prompt=SYSTEM_PROMPT,
            scope=SCOPE_EPHEMERAL,
            engine_label="Task creation engine",
            max_history_turns=MAX_HISTORY_TURNS,
            build_prompt=self._build_prompt,
            parse_response=self._resolve_draft,
            publish_structured=self._publish_draft,
            extract_streaming_text=extract_streaming_reply,
            resolve_engine_models=self._resolve_engine_models,
            validate_engine=self._validate_engine,
        )
        super().__init__(config, event_bus, project_manager)
        assistant_registry.register(config)

    def submit_message(
        self,
        project_id: str,
        session_id: str | None,
        content: str,
        idempotency_key: str,
        *,
        title: str,
        description: str | None = None,
        workflow_id: str | None = None,
        start_step_key: str | None = None,
        engine: str | None = None,
        model: str | None = None,
        fast_model: str | None = None,
        thinking_effort: str | None = None,
    ) -> ChatAccepted:
        normalized_title = (title or "").strip()
        if not normalized_title:
            raise ValueError("Task title cannot be empty")
        with self._project_manager.activate_project_by_id(project_id) as project:
            if workflow_id and project.workflow_by_id(workflow_id) is None:
                raise ValueError("Workflow not found")

        resolved_sid = session_id or str(uuid.uuid4())
        accepted = super().submit_message(
            project_id,
            content,
            idempotency_key,
            session_id=resolved_sid,
            memory_key=(project_id, resolved_sid),
            idempotency_sid=session_id or "",
            engine=engine,
            model=model,
            fast_model=fast_model,
            thinking_effort=thinking_effort,
            extra={
                "title": normalized_title,
                "description": (description or "").strip(),
                "workflow_id": workflow_id,
                "start_step_key": start_step_key,
            },
        )
        return ChatAccepted(
            session_id=accepted.session_id,
            turn_id=accepted.turn_id,
            status=accepted.status,
        )

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
            raise ValueError(f"Coordinator engine is unavailable: {engine_id}")
        if engine_id == configured_id:
            model = (
                config_store.get_coordinator_default_model()
                or config_store.get_engine_default_model(engine_id)
                or None
            )
            fast_model = (
                config_store.get_coordinator_default_fast_model() or model
            )
        else:
            model = config_store.get_engine_default_model(engine_id) or None
            fast_model = model
        return engine_id, model, fast_model

    @staticmethod
    def _validate_engine(engine_id: str) -> None:
        engine = create_engine(engine_id)
        if engine is None or not engine.capabilities.supports_coordinator:
            raise ValueError(f"Coordinator engine is unavailable: {engine_id}")

    def _context(self, session) -> dict:
        with self._project_manager.activate_project_by_id(session.project_id) as project:
            workflow_id = session.extra.get("workflow_id")
            workflow = (
                project.workflow_by_id(workflow_id)
                if workflow_id
                else project.default_workflow()
            )
            memory_path = project.workstep_dir / "MEMORY.md"
            memory = (
                memory_path.read_text(encoding="utf-8")
                if memory_path.is_file()
                else ""
            )
            return {
                "project": {
                    "id": project.id,
                    "name": project.name,
                    "path": str(project.path),
                    "memory": memory,
                },
                "task_draft": {
                    "title": session.extra.get("title", ""),
                    "description": session.extra.get("description", ""),
                    "workflow_id": workflow.get("id") if workflow else None,
                    "start_step_key": session.extra.get("start_step_key"),
                },
                "workflow": workflow.get("steps") if workflow else None,
            }

    def _build_prompt(self, session) -> str:
        context = json.dumps(self._context(session), ensure_ascii=False, default=str)
        user_message = session.messages[-1]["content"] if session.messages else ""
        engine = create_engine(session.engine)
        if engine is not None and engine.supports_resume:
            head = SYSTEM_PROMPT if not session.resolved_session_id else ""
            return f"{head}\n\n当前上下文：\n{context}\n\n用户：{user_message}"
        turns = session.messages[-(MAX_HISTORY_TURNS * 2):]
        history = "\n\n".join(
            f"{'用户' if item['role'] == 'user' else '助手'}：{item['content']}"
            for item in turns
        )
        return (
            f"{SYSTEM_PROMPT}\n\n当前上下文：\n{context}"
            f"\n\n历史对话：\n{history}\n\n请继续。"
        )

    async def _resolve_draft(self, session, raw: str):
        try:
            reply, draft = self._parse_reply(raw)
            return reply, self._validate_draft(session, draft), []
        except RuntimeError:
            repaired, events, _ = await self._invoke(
                session.engine,
                session.fast_model,
                session.cwd,
                (
                    "Repair the response into valid task-creation JSON of the form "
                    '{"reply":"...","task_draft":{"description":"...",'
                    '"start_step_key":"valid workflow stage key"}}. '
                    "Use task_draft:null when clarification is required. Return JSON only.\n\n"
                    f"Valid stage keys: {sorted(self._valid_step_keys(session))}\n\n"
                    f"{raw}"
                ),
                None,
            )
            reply, draft = self._parse_reply(repaired)
            return reply, self._validate_draft(session, draft), events

    @staticmethod
    def _parse_reply(raw: str) -> tuple[str, dict | None]:
        candidates = []
        fenced = re.search(r"```(?:json)?\s*(\{.*\})\s*```", raw, re.DOTALL)
        if fenced:
            candidates.append(fenced.group(1))
        start, end = raw.find("{"), raw.rfind("}")
        if start >= 0 and end > start:
            candidates.append(raw[start:end + 1])
        for candidate in candidates:
            try:
                parsed = json.loads(candidate)
            except json.JSONDecodeError:
                continue
            if not isinstance(parsed, dict) or not isinstance(parsed.get("reply"), str):
                continue
            draft = parsed.get("task_draft")
            if draft is None:
                return parsed["reply"], None
            description = draft.get("description") if isinstance(draft, dict) else None
            if isinstance(description, str) and description.strip():
                return parsed["reply"], {
                    "description": description.strip(),
                    "start_step_key": draft.get("start_step_key"),
                }
        raise RuntimeError("Task creation agent returned invalid JSON")

    def _valid_step_keys(self, session) -> set[str]:
        workflow = self._context(session).get("workflow")
        if not isinstance(workflow, dict):
            return set()
        definition = WorkflowDefinition.load(workflow).compile()
        return {
            str(step.get("key", ""))
            for step in definition.steps
            if step.get("key")
        }

    def _validate_draft(self, session, draft: dict | None) -> list[dict]:
        if draft is None:
            return []
        start_step_key = draft.get("start_step_key")
        valid_keys = self._valid_step_keys(session)
        if not isinstance(start_step_key, str) or start_step_key not in valid_keys:
            raise RuntimeError("Task creation agent returned an invalid start stage")
        return [{
            "description": draft["description"],
            "start_step_key": start_step_key,
        }]

    async def _publish_draft(
        self, session, assistant_message_id: str, reply: str,
        drafts: list[dict], seq: int,
    ) -> int:
        return await self._publish(
            session,
            assistant_message_id,
            "task_draft",
            drafts[-1],
            seq,
        )
