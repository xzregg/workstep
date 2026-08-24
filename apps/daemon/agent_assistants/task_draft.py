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
from agent_assistants.base import (
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
# Bounded wall-clock budget for one headless scheduled run attempt.
SCHEDULE_ATTEMPT_TIMEOUT_SECONDS = 10 * 60

SYSTEM_PROMPT = """你是 WorkStep 的任务创建 Agent。你通过多轮对话帮助用户把任务整理成标题明确、清晰且可执行的 Markdown 任务描述。

工作方式：
1. 结合项目记忆、所选工作流、起始阶段、任务标题和当前描述理解任务；标题为空时，在信息足够后生成简洁明确的标题。
2. 信息不足时，只追问当前最关键的问题，此时 task_draft 必须为 null。
3. 信息足够时生成完整任务描述，覆盖目标、背景、范围、约束和可验证的验收标准；同时根据任务内容选择最合适的起始阶段。例如纯测试任务应直接选择测试阶段，跳过研发阶段。已有标题时不要修改标题，也不要修改工作流、评审设置或自动开始设置。
4. 用户后续提出调整时，始终返回完整描述，不要只返回增量。

回复必须是合法 JSON：
{"reply":"给用户看的自然语言回复（Markdown）","task_draft":{"title":"标题为空时生成的任务标题（已有标题时省略）","description":"完整 Markdown 任务描述","start_step_key":"所选工作流中的阶段 key"}}
尚需澄清时使用：{"reply":"澄清问题","task_draft":null}
不要在 reply 中重复输出完整任务描述。"""

SYSTEM_PROMPT_SCHEDULE = """你是 WorkStep 的定时任务执行 Agent（任务创建助手的定时模式）。你负责把定时任务配置里的“生成指令”落实为具体任务：产出最终任务标题、完整 Markdown 任务内容，并选择目标流程与起始阶段。

工作方式：
1. 先理解“生成指令”。可结合项目记忆、参考标题/说明收集背景；需要更多信息时调用只读工具（项目 Skill 的 list_skills / load_skill、workstep_* 只读接口）。不要询问用户，基于已有信息自主决策。
2. 产出最终任务标题：若提供参考标题则保持参考标题不变；否则自拟简洁、明确的标题。
3. 产出完整 Markdown 任务内容，覆盖目标、背景、范围、约束与可验证的验收标准。
4. 从候选流程中选择最合适的目标流程（候选列表为空表示项目全部未删除流程可选），并选择该流程中最合适的起始阶段（如纯测试任务直接选测试阶段；缺省该字段表示从流程第一阶段开始）。不得选择候选列表之外的流程。
5. 不要调用 workstep_create_task 等有副作用的工具，不要请求权限或提问；任务创建由系统在收到你的结构化结果后完成。

回复必须是合法 JSON：
{"reply":"给用户/执行日志看的自然语言说明（Markdown）","task_draft":{"title":"任务标题","description":"完整 Markdown 任务内容","workflow_id":"所选候选流程 id","start_step_key":"该流程中的阶段 key（可选，缺省为流程第一阶段）"}}
只返回 JSON，不要在 reply 中重复完整任务内容。"""
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
            workstep_tools=True,
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
        provider_id: str | None = None,
        thinking_effort: str | None = None,
        instruction: str | None = None,
        candidate_workflow_ids: list[str] | None = None,
        allow_generate_title: bool = False,
        retry_feedback: str | None = None,
    ) -> ChatAccepted:
        schedule_mode = instruction is not None or candidate_workflow_ids is not None
        normalized_title = (title or "").strip()
        if not normalized_title and not (schedule_mode or allow_generate_title):
            raise ValueError("Task title cannot be empty")
        with self._project_manager.activate_project_by_id(project_id) as project:
            if workflow_id and project.workflow_by_id(workflow_id) is None:
                raise ValueError("Workflow not found")
            candidate_ids = list(candidate_workflow_ids or [])
            if candidate_ids:
                active_ids = {
                    wf["id"]
                    for wf in project.workflows
                    if not wf.get("deleted")
                }
                missing = next(
                    (wid for wid in candidate_ids if wid not in active_ids),
                    None,
                )
                if missing is not None:
                    raise ValueError(f"Workflow not found: {missing}")

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
            provider_id=provider_id,
            thinking_effort=thinking_effort,
            extra={
                "title": normalized_title,
                "description": (description or "").strip(),
                "workflow_id": workflow_id,
                "start_step_key": start_step_key,
                "schedule_mode": schedule_mode,
                "instruction": (instruction or "").strip(),
                "candidate_workflow_ids": candidate_ids,
                "allow_generate_title": bool(allow_generate_title),
                "retry_feedback": retry_feedback,
            },
        )
        return ChatAccepted(
            session_id=accepted.session_id,
            turn_id=accepted.turn_id,
            status=accepted.status,
        )

    async def run_schedule(
        self,
        project_id: str,
        *,
        instruction: str,
        title: str | None = None,
        description: str | None = None,
        candidate_workflow_ids: list[str] | None = None,
        retry_feedback: str | None = None,
        timeout: float = SCHEDULE_ATTEMPT_TIMEOUT_SECONDS,
    ) -> dict:
        """Run one headless task-agent turn for a scheduled task.

        Returns the validated structured result
        ``{"title", "description", "workflow_id", "start_step_key"?}``.
        Raises ``RuntimeError`` when the assistant failed or returned an
        invalid result. The assistant never creates a Task row — creation is
        performed by the caller through ``create_project_task``.
        """
        normalized_instruction = (instruction or "").strip()
        if not normalized_instruction:
            raise ValueError("Schedule instruction cannot be empty")
        session_id = f"schedule-{uuid.uuid4()}"
        accepted = self.submit_message(
            project_id,
            session_id,
            normalized_instruction,
            idempotency_key=str(uuid.uuid4()),
            title=title or "",
            description=description,
            instruction=normalized_instruction,
            allow_generate_title=True,
            candidate_workflow_ids=candidate_workflow_ids,
            retry_feedback=retry_feedback,
            workflow_id=None,
            start_step_key=None,
        )
        try:
            await self.await_turn(accepted.turn_id, timeout=timeout)
        except TimeoutError:
            raise RuntimeError(
                f"Scheduled task agent timed out after {timeout} seconds"
            ) from None
        session = self._sessions.get((project_id, accepted.session_id))
        if session is None:
            raise RuntimeError("Scheduled task agent session was lost")
        result = session.extra.get("schedule_result")
        if not isinstance(result, dict):
            raise RuntimeError("Scheduled task agent returned no result")
        return result

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
        defaults = config_store.get_assistant_defaults("task_create")
        configured_id = defaults["engine"] or "claude"
        if (
            configured_id == "pydantic_ai"
            and (defaults.get("provider_id") or "").strip()
        ):
            # 显式选择内置引擎并配置了供应商：直接使用内置引擎，
            # 不参与协调引擎回退（其能力由供应商动态配置决定）。
            if create_engine("pydantic_ai") is None:
                raise ValueError("内置引擎不可用")
            model = (
                defaults["model"]
                or config_store.get_engine_default_model("pydantic_ai")
                or None
            )
            return "pydantic_ai", model, defaults["fast_model"] or model
        engine_id, engine = self._fallback_engine(configured_id)
        if engine is None:
            raise ValueError(f"Coordinator engine is unavailable: {engine_id}")
        if engine_id == configured_id:
            model = (
                defaults["model"]
                or config_store.get_engine_default_model(engine_id)
                or None
            )
            fast_model = defaults["fast_model"] or model
        else:
            model = config_store.get_engine_default_model(engine_id) or None
            fast_model = model
        return engine_id, model, fast_model

    @staticmethod
    def _validate_engine(engine_id: str) -> None:
        engine = create_engine(engine_id)
        if engine is None or not (
            engine.capabilities.supports_coordinator
            or engine_id == "pydantic_ai"
        ):
            raise ValueError(f"Coordinator engine is unavailable: {engine_id}")

    def _context(self, session) -> dict:
        with self._project_manager.activate_project_by_id(session.project_id) as project:
            memory_path = project.workstep_dir / "MEMORY.md"
            memory = (
                memory_path.read_text(encoding="utf-8")
                if memory_path.is_file()
                else ""
            )
            if session.extra.get("schedule_mode"):
                candidates = self._allowed_workflow_ids(session, project)
                return {
                    "project": {
                        "id": project.id,
                        "name": project.name,
                        "path": str(project.path),
                        "memory": memory,
                    },
                    "schedule": {
                        "instruction": session.extra.get("instruction", ""),
                        "reference_title": session.extra.get("title", ""),
                        "reference_description": session.extra.get(
                            "description", ""
                        ),
                        "allow_generate_title": bool(
                            session.extra.get("allow_generate_title")
                        ),
                        "candidate_workflows": [
                            {
                                "id": wf["id"],
                                "name": wf.get("name", ""),
                                "steps": wf["steps"],
                            }
                            for wf in candidates
                        ],
                        "retry_feedback": session.extra.get("retry_feedback"),
                    },
                }
            workflow_id = session.extra.get("workflow_id")
            workflow = (
                project.workflow_by_id(workflow_id)
                if workflow_id
                else project.default_workflow()
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
                    "allow_generate_title": bool(
                        session.extra.get("allow_generate_title")
                    ),
                    "description": session.extra.get("description", ""),
                    "workflow_id": workflow.get("id") if workflow else None,
                    "start_step_key": session.extra.get("start_step_key"),
                },
                "workflow": workflow.get("steps") if workflow else None,
            }

    def _build_prompt(self, session) -> str:
        system = (
            SYSTEM_PROMPT_SCHEDULE
            if session.extra.get("schedule_mode")
            else SYSTEM_PROMPT
        )
        context = json.dumps(self._context(session), ensure_ascii=False, default=str)
        user_message = session.messages[-1]["content"] if session.messages else ""
        engine = create_engine(session.engine)
        if engine is not None and engine.supports_resume:
            head = system if not session.resolved_session_id else ""
            prompt = f"{head}\n\n当前上下文：\n{context}\n\n用户：{user_message}"
        else:
            turns = session.messages[-(MAX_HISTORY_TURNS * 2):]
            history = "\n\n".join(
                f"{'用户' if item['role'] == 'user' else '助手'}：{item['content']}"
                for item in turns
            )
            prompt = (
                f"{system}\n\n当前上下文：\n{context}"
                f"\n\n历史对话：\n{history}\n\n请继续。"
            )
        return prompt

    def _allowed_workflow_ids(self, session, project=None) -> list[dict]:
        """Active project workflows, narrowed to the candidate list when given."""
        if project is None:
            with self._project_manager.activate_project_by_id(session.project_id) as project:
                workflows = list(project.workflows)
        else:
            workflows = list(project.workflows)
        active = [
            wf for wf in workflows if not wf.get("deleted")
        ]
        candidates = session.extra.get("candidate_workflow_ids") or []
        if not candidates:
            return active
        by_id = {wf["id"]: wf for wf in active}
        return [
            by_id[wid]
            for wid in candidates
            if wid in by_id
        ]

    def _valid_step_keys_for(self, session, workflow_id: str) -> set[str]:
        with self._project_manager.activate_project_by_id(session.project_id) as project:
            workflow = project.workflow_by_id(workflow_id)
        if workflow is None:
            return set()
        definition = WorkflowDefinition.load(workflow["steps"]).compile()
        return {
            str(step.get("key", ""))
            for step in definition.steps
            if step.get("key")
        }

    def _validate_schedule_draft(self, session, draft: dict) -> list[dict]:
        title = str(draft.get("title") or "").strip()
        description = str(draft.get("description") or "").strip()
        workflow_id = str(draft.get("workflow_id") or "").strip()
        if not title or not description or not workflow_id:
            raise RuntimeError("Scheduled task agent returned incomplete task")
        allowed = {
            wf["id"]
            for wf in self._allowed_workflow_ids(session)
        }
        if workflow_id not in allowed:
            raise RuntimeError(
                "Scheduled task agent chose a workflow outside the candidates"
            )
        valid_keys = self._valid_step_keys_for(session, workflow_id)
        start_step_key = draft.get("start_step_key")
        if start_step_key is not None:
            start_step_key = str(start_step_key)
            if start_step_key not in valid_keys:
                raise RuntimeError(
                    "Scheduled task agent returned an invalid start stage"
                )
        result = {
            "title": title,
            "description": description,
            "workflow_id": workflow_id,
        }
        if start_step_key:
            result["start_step_key"] = start_step_key
        return [result]

    async def _resolve_draft(self, session, raw: str):
        schedule_mode = bool(session.extra.get("schedule_mode"))
        try:
            reply, draft = self._parse_reply(raw)
            validated = self._validate_draft(session, draft)
            if schedule_mode and validated:
                session.extra["schedule_result"] = validated[-1]
            return reply, validated, []
        except RuntimeError:
            valid_keys = (
                self._valid_step_keys(session)
                if not schedule_mode
                else self._schedule_valid_stage_keys(session)
            )
            repaired, events, _ = await self._invoke(
                session.engine,
                session.fast_model,
                session.cwd,
                self._repair_instruction(session, valid_keys, raw),
                None,
            )
            reply, draft = self._parse_reply(repaired)
            validated = self._validate_draft(session, draft)
            if schedule_mode and validated:
                session.extra["schedule_result"] = validated[-1]
            return reply, validated, events

    def _repair_instruction(self, session, valid_keys: set[str], raw: str) -> str:
        if session.extra.get("schedule_mode"):
            allowed_ids = sorted(
                wf["id"] for wf in self._allowed_workflow_ids(session)
            )
            return (
                "Repair the response into valid scheduled task-creation JSON of "
                'the form {"reply":"...","task_draft":{"title":"...",'
                '"description":"...","workflow_id":"chosen candidate workflow id",'
                '"start_step_key":"valid workflow stage key or omit"}}. '
                "Return JSON only.\n\n"
                f"Valid workflow ids: {allowed_ids}\n\n"
                f"Valid stage keys: {sorted(valid_keys)}\n\n"
                f"{raw}"
            )
        title_field = (
            '"title":"generated task title",'
            if session.extra.get("allow_generate_title")
            else ""
        )
        return (
            "Repair the response into valid task-creation JSON of the form "
            f'{{"reply":"...","task_draft":{{{title_field}"description":"...",'
            '"start_step_key":"valid workflow stage key"}}}. '
            "Use task_draft:null when clarification is required. Return JSON only.\n\n"
            f"Valid stage keys: {sorted(valid_keys)}\n\n"
            f"{raw}"
        )

    def _schedule_valid_stage_keys(self, session) -> set[str]:
        """Union of stage keys across the allowed candidate workflows."""
        keys: set[str] = set()
        for wf in self._allowed_workflow_ids(session):
            keys.update(self._valid_step_keys_for(session, wf["id"]))
        return keys

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
                    "title": draft.get("title"),
                    "workflow_id": draft.get("workflow_id"),
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
        if session.extra.get("schedule_mode"):
            return self._validate_schedule_draft(session, draft)
        start_step_key = draft.get("start_step_key")
        valid_keys = self._valid_step_keys(session)
        if not isinstance(start_step_key, str) or start_step_key not in valid_keys:
            raise RuntimeError("Task creation agent returned an invalid start stage")
        result = {
            "description": draft["description"],
            "start_step_key": start_step_key,
        }
        if session.extra.get("allow_generate_title"):
            title = str(draft.get("title") or "").strip()
            if not session.extra.get("title") and not title:
                raise RuntimeError("Task creation agent returned no task title")
            if title:
                result["title"] = title
        return [result]

    async def _publish_draft(
        self, session, assistant_message_id: str, reply: str,
        drafts: list[dict], seq: int,
    ) -> tuple[int, list[dict]]:
        seq = await self._publish(
            session,
            assistant_message_id,
            "task_draft",
            drafts[-1],
            seq,
        )
        return seq, []
