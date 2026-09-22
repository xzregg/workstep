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
from agent_assistants.event_journal import TurnEventJournal
from services.config import config_store, resolve_execution_engine
from services.workflow_definition import WorkflowDefinition


TASK_CREATE_CHANNEL = "task_create"
MAX_HISTORY_TURNS = 8
# Bounded wall-clock budget for one headless scheduled run attempt.
SCHEDULE_ATTEMPT_TIMEOUT_SECONDS = 10 * 60

SYSTEM_PROMPT = """You are the WorkStep task creation assistant. Use multi-turn chat to turn a request into a clear, executable Markdown task description.

Use project memory, selected workflow, start step, title, and current description. If information is missing, ask only the most important question and set task_draft to null. When ready, produce a complete description covering goal, background, scope, constraints, and verifiable acceptance criteria, and choose the best start step. Keep an existing title unchanged. Do not change workflow, review, or auto-start settings. For later edits, return the full description, not a delta.

Return valid JSON:
{"reply":"Markdown reply for the user","task_draft":{"title":"generated title when no title exists","description":"complete Markdown task description","start_step_key":"step key in the selected workflow"}}
When clarification is needed: {"reply":"question","task_draft":null}
Do not repeat the full task description in reply."""

SYSTEM_PROMPT_SCHEDULE = """You are the WorkStep scheduled task execution assistant. Turn the schedule generation instruction into a concrete task: final title, complete Markdown task content, target workflow, and start step.

Understand the instruction using project memory and any reference title/notes. Use read-only Skill and workstep_* tools when needed. Do not ask the user. Keep a provided reference title unchanged; otherwise create a concise title. Produce complete task content covering goal, background, scope, constraints, and verifiable acceptance criteria. Choose the best workflow from the candidate list (empty means all active workflows) and its best start step. Do not choose outside the candidate list. Do not call side-effect tools, request permissions, or ask questions; the system creates the task after receiving your structured result.

Return valid JSON:
{"reply":"Markdown explanation for the user or execution log","task_draft":{"title":"task title","description":"complete Markdown task content","workflow_id":"selected candidate workflow id","start_step_key":"step key (optional; defaults to the first step)"}}
Return JSON only. Do not repeat the full task content in reply."""
@dataclass(frozen=True, slots=True)
class ChatAccepted:
    session_id: str
    turn_id: str
    assistant_message_id: str
    status: str

    def to_dict(self) -> dict:
        return {
            "session_id": self.session_id,
            "turn_id": self.turn_id,
            "assistant_message_id": self.assistant_message_id,
            "status": self.status,
        }


class TaskDraftModule(AssistantRuntime):
    """Task Agent creation mode backed by an in-memory assistant session."""

    def __init__(self, event_bus, project_manager):
        self._event_journal = TurnEventJournal()
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
            event_journal=self._event_journal,
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
        vision_model: str | None = None,
        provider_id: str | None = None,
        thinking_effort: str | None = None,
        instruction: str | None = None,
        candidate_workflow_ids: list[str] | None = None,
        allow_generate_title: bool = False,
        retry_feedback: str | None = None,
        schedule: bool = True,
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
            vision_model=vision_model,
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
            schedule=schedule,
        )
        return ChatAccepted(
            session_id=accepted.session_id,
            turn_id=accepted.turn_id,
            assistant_message_id=accepted.assistant_message_id,
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
        accepted = await self._project_manager.run_db(
            project_id,
            lambda _project: self.submit_message(
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
                schedule=False,
            ),
        )
        self.start_queued_turn(accepted.turn_id)
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
        configured_id = defaults["engine"] or resolve_execution_engine(None)
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
        user_message = next(
            (
                str(item.get("content") or "")
                for item in reversed(session.messages)
                if item.get("role") == "user"
            ),
            "",
        )
        engine = create_engine(session.engine)
        if engine is not None and engine.supports_resume:
            head = system if not session.resolved_session_id else ""
            prompt = f"{head}\n\nCurrent context:\n{context}\n\nUser: {user_message}"
        else:
            turns = session.messages[-(MAX_HISTORY_TURNS * 2):]
            history = "\n\n".join(
                f"{'User' if item['role'] == 'user' else 'Assistant'}: {item['content']}"
                for item in turns
            )
            prompt = (
                f"{system}\n\nCurrent context:\n{context}"
                f"\n\nConversation history:\n{history}\n\nContinue."
            )
        return prompt

    def _system_prompt_for_display(self, session) -> str:
        """Match the visible system instruction to normal or scheduled mode."""
        return (
            SYSTEM_PROMPT_SCHEDULE
            if session.extra.get("schedule_mode")
            else SYSTEM_PROMPT
        )

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
                    "Scheduled task agent returned an invalid start step"
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
                else self._schedule_valid_step_keys(session)
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
                '"start_step_key":"valid workflow step key or omit"}}. '
                "Return JSON only.\n\n"
                f"Valid workflow ids: {allowed_ids}\n\n"
                f"Valid step keys: {sorted(valid_keys)}\n\n"
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
            '"start_step_key":"valid workflow step key"}}}. '
            "Use task_draft:null when clarification is required. Return JSON only.\n\n"
            f"Valid step keys: {sorted(valid_keys)}\n\n"
            f"{raw}"
        )

    def _schedule_valid_step_keys(self, session) -> set[str]:
        """Union of step keys across the allowed candidate workflows."""
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
            raise RuntimeError("Task creation agent returned an invalid start step")
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
