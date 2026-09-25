"""AI flow-design assistant (workflow generation chat).

This module is one *assistant* registered in the shared assistant layer
(``agent_assistants/base.py``): it only declares an ``AssistantConfig``
(system prompt, response parser, workflow-scoped persistence) plus the
flow-specific parsing/validation hooks. Session lifecycle, idempotency,
engine invocation with resume and streaming events all live in the generic
``AssistantRuntime``.

Sessions are pinned per workflow when ``workflow_id`` is provided (editing
the same workflow always resumes the same conversation, surviving daemon
restarts through ``WorkflowGenSession``); create-mode chats (no workflow)
stay memory-only and start fresh.
"""

import json
import re
import uuid
from dataclasses import dataclass

from engines.core.registry import COORDINATOR_FALLBACK_ORDER, create_engine
from agent_assistants.base import (
    AssistantConfig,
    AssistantRuntime,
    JsonRowPersistence,
    SCOPE_WORKFLOW,
    assistant_registry,
    extract_streaming_reply,
)
from agent_assistants.event_journal import TurnEventJournal
from agent_assistants.workflow_choice_ui import ensure_flow_choice_ui
from agent_assistants.workflow_patch import (
    WorkflowPatchError,
    apply_patch,
    is_patch,
)
from services.config import CONFIG_DIR, config_store, resolve_execution_engine
from services.workflow_definition import (
    WorkflowDefinition,
    WorkflowValidationError,
)

GEN_CHANNEL = "flow_gen"

MAX_HISTORY_TURNS = 8
MAX_SESSIONS = 200
SESSION_TTL_SECONDS = 60 * 60

SYSTEM_PROMPT = """You are the WorkStep workflow design assistant. Return canvas JSON for an executable workflow.
+
+Ask at most two questions about goal, I/O, constraints, review, parallelism, and steps. When ready, return short text plus materially different proposals. For edits, always return a patch unless the canvas is empty. A full redesign must set replaceCanvas true explicitly; if clear, use one proposal with autoApply true.
+
+Patch: upsertNodes (full changed nodes only; never include untouched nodes; existing id updates, omitted id adds), removeNodeIds, optional connections (merged list; omit to keep links).
+Canvas JSON: {"nodes":[...],"connections":[...]}. Node fields: id, type, title, autoStart, engine, model, color, prompt, inputs. Connection fields: from, fromPort, to, toPort, kind.
+Rules: id is a unique positive integer. type is unique, lowercase letters/hyphens: req, ui-design, dev-backend, test, publish. engine defaults to "claude". review is optional: {"auto":true,"maxRetries":1,"prompt":"review criteria"}. connections may be omitted for serial order. kind is "solid" or "dashed".
+
+Return valid JSON:
+{"reply":"Markdown reply","flow_proposals":[{"title":"title","workflowName":"name without whitespace","summary":"one sentence","steps":<canvas JSON>,"autoApply":false}]}
+During clarification flow_proposals is []. reply has user text and A2UI controls only; never put canvas JSON, ```json, or "current full canvas JSON" in reply. Full canvas goes only in flow_proposals[].steps. Initial options use autoApply false or omitted. After a choice or clear edit request, return one full proposal with autoApply true.
+
+For proposals or choices, include a complete ```a2ui block, one JSON per line: createSurface then updateComponents with Column id "root"; child refs must be declared. Proposal buttons use action.event.name "apply_flow" and context.proposal as the 1-based index; count must match flow_proposals. Clarification uses ChoicePicker chips, TextField longText, and submit Button with a normal action. Answers go in context as {"path":"/a2ui/<surfaceId>/<componentId>/value"}. Close the fence with three backticks."""


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


class WorkflowGenModule(AssistantRuntime):
    """The AI flow-design assistant — config + flow-specific hooks."""

    def __init__(self, event_bus, project_manager):
        self._event_journal = TurnEventJournal()
        config = AssistantConfig(
            name="workflow_gen",
            channel=GEN_CHANNEL,
            system_prompt=SYSTEM_PROMPT,
            scope=SCOPE_WORKFLOW,
            engine_label="Workflow generation engine",
            max_history_turns=MAX_HISTORY_TURNS,
            max_sessions=MAX_SESSIONS,
            session_ttl_seconds=SESSION_TTL_SECONDS,
            persistence=JsonRowPersistence(
                model=_workflow_gen_session_model(),
                scope_field="workflow_id",
                make_id=lambda project_id, workflow_id: (
                    f"{project_id}:{workflow_id}"
                ),
            ),
            build_prompt=self._build_prompt,
            parse_response=self._resolve_proposal,
            publish_structured=self._publish_proposals,
            extract_streaming_text=extract_streaming_reply,
            history_message=self._history_message,
            validate_engine=self._validate_engine,
            cwd_resolver=self._resolve_cwd,
            event_journal=self._event_journal,
        )
        self._workflow_gen_config = config
        super().__init__(config, event_bus, project_manager)
        assistant_registry.register(config)

    # ── public API ──────────────────────────────────────────────────────

    def submit_message(
        self,
        project_id: str,
        session_id: str | None,
        content: str,
        idempotency_key: str,
        engine: str | None = None,
        model: str | None = None,
        fast_model: str | None = None,
        vision_model: str | None = None,
        provider_id: str | None = None,
        thinking_effort: str | None = None,
        steps: dict | None = None,
        workflow_name: str | None = None,
        context_mode: str | None = None,
        workflow_id: str | None = None,
        schedule: bool = True,
    ) -> ChatAccepted:
        """Queue one generation turn; returns immediately with an accepted turn.

        ``workflow_id`` pins the conversation to that workflow: editing the
        same workflow always resumes the same session. Without it the
        conversation is ephemeral and starts fresh.
        """
        memory_key, resolved_sid = self._session_identity(
            project_id, session_id, workflow_id
        )
        resolved_context_mode = context_mode or (
            "initial" if steps is not None else "none"
        )
        if resolved_context_mode not in {"initial", "canvas_updated", "none"}:
            raise ValueError(f"Invalid workflow context mode: {resolved_context_mode}")
        accepted = super().submit_message(
            project_id,
            content,
            idempotency_key,
            session_id=resolved_sid,
            memory_key=memory_key,
            scope_key=workflow_id,
            idempotency_sid=session_id or "",
            engine=engine,
            model=model,
            fast_model=fast_model,
            vision_model=vision_model,
            provider_id=provider_id,
            thinking_effort=thinking_effort,
            steps=steps,
            extra={
                "workflow_name": (workflow_name or "").strip(),
                "context_mode": resolved_context_mode,
            },
            schedule=schedule,
        )
        return ChatAccepted(
            session_id=accepted.session_id,
            turn_id=accepted.turn_id,
            assistant_message_id=accepted.assistant_message_id,
            status=accepted.status,
        )

    def history(self, project_id: str, workflow_id: str) -> dict:
        """Return the stable workflow conversation (or an empty one)."""
        session_id = f"wf:{project_id}:{workflow_id}"
        loaded = super().history(project_id, workflow_id)
        if loaded is None:
            try:
                engine, model, fast_model = self._resolve_engine_models()
            except ValueError:
                engine, model, fast_model = "", None, None
            loaded = {
                "engine": engine,
                "model": model,
                "fast_model": fast_model,
                "engine_session_id": None,
                "messages": [],
            }
        return {"session_id": session_id, **loaded}

    def reset_session(self, project_id: str, workflow_id: str) -> bool:
        """Clear the stable AI editing conversation for one workflow."""
        if not workflow_id:
            raise ValueError("workflow_id is required")
        memory_key, session_id = self._session_identity(
            project_id, None, workflow_id
        )
        return self.reset_scoped_session(
            project_id,
            workflow_id,
            memory_key,
            session_id,
        )

    @staticmethod
    def _session_identity(
        project_id: str,
        session_id: str | None,
        workflow_id: str | None,
    ) -> tuple[tuple, str]:
        """Map (workflow-scoped | ephemeral) to (memory key, canonical sid)."""
        if workflow_id:
            return (
                ("wf", project_id, workflow_id),
                f"wf:{project_id}:{workflow_id}",
            )
        sid = session_id or str(uuid.uuid4())
        return (project_id, sid), sid

    @staticmethod
    def _resolve_cwd(project_manager, project_id: str) -> str:
        """Engine working directory for flow-design sessions.

        Project sessions run in the project root; template editing (empty
        ``project_id``) runs in the global templates directory so the agent
        can read/write template files without a project.
        """
        if not project_id:
            templates_dir = CONFIG_DIR / "data" / "templates"
            templates_dir.mkdir(parents=True, exist_ok=True)
            return str(templates_dir)
        with project_manager.activate_project_by_id(project_id) as project:
            return str(project.path)

    # ── engine / model resolution ───────────────────────────────────────

    @staticmethod
    def _fallback_engine(default_engine_id: str) -> tuple[str, object | None]:
        """Resolve a usable coordinator engine, falling back when unconfigured.

        Returns ``(engine_id, engine)``; ``engine`` is ``None`` only when no
        coordinator-capable engine is available at all.
        """
        candidates = [default_engine_id] + [
            key for key in COORDINATOR_FALLBACK_ORDER if key != default_engine_id
        ]
        for candidate in candidates:
            engine = create_engine(candidate)
            if engine is not None and engine.capabilities.supports_coordinator:
                return candidate, engine
        return default_engine_id, None

    def _resolve_engine_models(self) -> tuple[str, str | None, str | None]:
        defaults = config_store.get_assistant_defaults("workflow_gen")
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
            # 正常路径：沿用协调 Agent 的全局模型。
            model = (
                defaults["model"]
                or config_store.get_engine_default_model(engine_id)
                or None
            )
        else:
            # 回退到其它引擎时，不沿用原引擎的协调模型，改用该引擎自己的默认模型。
            model = config_store.get_engine_default_model(engine_id) or None
        fast_model = (defaults["fast_model"] if engine_id == configured_id else "") or model
        return engine_id, model, fast_model

    def _validate_engine(self, engine_id: str) -> None:
        candidate = create_engine(engine_id)
        if candidate is None or not (
            candidate.capabilities.supports_coordinator
            or engine_id == "pydantic_ai"
        ):
            raise ValueError(f"Coordinator engine is unavailable: {engine_id}")

    # ── prompt building ─────────────────────────────────────────────────

    def _build_prompt(self, session) -> str:
        canvas_json = ""
        steps = session.steps or {}
        context_mode = session.extra.get("context_mode", "none")
        if context_mode == "initial":
            workflow_name = session.extra.get("workflow_name") or "未命名流程"
            canvas_json = (
                f"\n\nCurrent flow title: {workflow_name}"
                "\nCurrent canvas JSON (the workflow the user is editing; edit or "
                "reorder it instead of starting over; keep node id/type when possible):\n"
                f"{json.dumps(steps, ensure_ascii=False)}"
            )
        elif context_mode == "canvas_updated":
            canvas_json = (
                "\n\nCurrent canvas updated (it may contain unsaved changes; treat "
                "this version as authoritative):\n"
                f"{json.dumps(steps, ensure_ascii=False)}"
            )
        engine = create_engine(session.engine)
        if engine is not None and engine.supports_resume:
            # 引擎侧维护会话上下文：历史不再拼进 prompt。首轮携带完整系统
            # 提示，续轮只发当前画布与用户消息，避免重复污染引擎会话。
            user_message = next(
                (
                    str(item.get("content") or "")
                    for item in reversed(session.messages)
                    if item.get("role") == "user"
                ),
                "",
            )
            head = SYSTEM_PROMPT if not session.resolved_session_id else ""
            return f"{head}{canvas_json}\n\n{user_message}"
        # 无引擎侧会话的引擎（不支持 resume）：保留最近对话记录拼接，
        # 否则多轮对话将完全失去上下文。
        turns = session.messages[-(MAX_HISTORY_TURNS * 2):]
        history = "\n\n".join(
            f"{'User' if item['role'] == 'user' else 'Assistant'}: {item['content']}"
            for item in turns
        )
        return (
            f"{SYSTEM_PROMPT}"
            f"{canvas_json}\n\nConversation history:\n{history}\n\nContinue."
        )

    # ── response parsing & proposal publishing ─────────────────────────

    def _merge_patch_proposals(
        self,
        session,
        proposals: list[dict],
    ) -> list[dict]:
        """Merge incremental patches into the session canvas.

        Proposals carrying a full ``steps`` canvas pass through untouched;
        patches are merged against the current canvas so downstream validation
        and the editor only ever see complete flows. Each merged proposal keeps
        a ``stepChanges`` list (added / updated / removed steps) so the editor
        can let the user apply a subset of steps.
        """
        if not proposals:
            return proposals
        base_steps = getattr(session, "steps", None)
        merged: list[dict] = []
        for item in proposals:
            steps = item.get("steps")
            # Models occasionally put only the touched nodes in a canvas-shaped
            # ``{"nodes": [...]}`` payload.  In edit mode that must be treated
            # as an incremental patch; otherwise applying it erases every
            # omitted step. Full replacement is deliberately opt-in.
            if (
                not is_patch(steps)
                and not item.get("replaceCanvas")
                and isinstance(steps, dict)
                and isinstance(steps.get("nodes"), list)
                and isinstance((base_steps or {}).get("nodes"), list)
                and (base_steps or {}).get("nodes")
            ):
                steps = self._canvas_payload_to_patch(base_steps, steps)
            if not is_patch(steps):
                merged.append(item)
                continue
            try:
                full, changes, resolved = apply_patch(base_steps, steps)
            except WorkflowPatchError:
                continue
            item = {**item, "steps": full}
            if changes:
                item["stepChanges"] = changes
                # Keep the resolved patch so the editor can apply a subset of
                # steps by id (new steps carry their server-assigned id).
                item["patch"] = resolved
            merged.append(item)
        return merged

    @staticmethod
    def _canvas_payload_to_patch(base_steps: dict, candidate: dict) -> dict:
        """Convert an edit-mode canvas payload into a non-destructive patch."""
        base_nodes = {
            node.get("id"): node
            for node in base_steps.get("nodes", [])
            if isinstance(node, dict) and isinstance(node.get("id"), int)
        }
        candidate_nodes = [
            node for node in candidate.get("nodes", []) if isinstance(node, dict)
        ]
        changed_nodes = []
        for node in candidate_nodes:
            base_node = base_nodes.get(node.get("id"))
            if base_node is None:
                changed_nodes.append(node)
                continue
            # Canvas-shaped fallback payloads are often abbreviated. Merge
            # omitted fields from the live node before comparing, so merely
            # echoing a step does not turn it into a reported modification.
            merged_node = {**base_node, **node}
            if merged_node != base_node:
                changed_nodes.append(merged_node)
        patch: dict = {
            "upsertNodes": changed_nodes,
            "removeNodeIds": [],
        }
        if isinstance(candidate.get("connections"), list):
            base_connections = [
                conn
                for conn in base_steps.get("connections", [])
                if isinstance(conn, dict)
            ]
            candidate_connections = [
                conn for conn in candidate["connections"] if isinstance(conn, dict)
            ]
            candidate_ids = {
                node.get("id")
                for node in candidate_nodes
                if isinstance(node.get("id"), int)
            }
            # A complete node set may safely carry a complete connection set.
            # For a node subset, preserve unrelated links and only add links
            # supplied with the touched steps.
            if set(base_nodes).issubset(candidate_ids):
                patch["connections"] = candidate_connections
            else:
                connections = list(base_connections)
                for connection in candidate_connections:
                    if connection not in connections:
                        connections.append(connection)
                patch["connections"] = connections
        return patch

    async def _resolve_proposal(
        self,
        session,
        raw: str,
    ) -> tuple[str, list[dict], list[dict]]:
        """Parse + validate the reply; guarantee an a2ui choice UI for plans."""
        reply, proposals, events = await self._resolve_proposal_inner(session, raw)
        reply, canvas = self._extract_canvas_json(reply)
        if canvas is not None and not proposals:
            try:
                WorkflowDefinition.load(canvas).validate()
                proposals = [{
                    "title": "更新后的流程",
                    "summary": "AI 已根据当前对话更新画布",
                    "steps": canvas,
                    "autoApply": True,
                }]
                proposals = self._merge_patch_proposals(session, proposals)
            except WorkflowValidationError as exc:
                events.append({
                    "type": "flow_proposals_rejected",
                    "data": {"message": f"画布 JSON 未通过校验，已丢弃：{exc}"},
                })
        if proposals:
            reply, a2ui_payloads = ensure_flow_choice_ui(reply, proposals)
            for payload in a2ui_payloads:
                events.append({"type": "a2ui", "data": payload})
        return reply, proposals, events

    @staticmethod
    def _extract_canvas_json(reply: str) -> tuple[str, dict | None]:
        """Remove a fenced canvas payload from reply and return it as steps."""
        fence_pattern = re.compile(
            r"^```(?:json)?[ \t]*\r?\n([\s\S]*?)^```[ \t]*\r?\n?",
            re.MULTILINE | re.IGNORECASE,
        )
        for match in fence_pattern.finditer(reply):
            try:
                parsed = json.loads(match.group(1).strip())
            except (json.JSONDecodeError, TypeError):
                continue
            if not isinstance(parsed, dict) or not isinstance(parsed.get("nodes"), list):
                continue
            if "connections" in parsed and not isinstance(parsed["connections"], list):
                continue
            cleaned = reply[:match.start()] + reply[match.end():]
            cleaned = re.sub(
                r"(?im)^.*(?:完整画布|画布).*JSON.*\r?\n(?:\r?\n)?",
                "",
                cleaned,
            )
            cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).strip()
            return cleaned, parsed
        return reply, None

    async def _resolve_proposal_inner(
        self,
        session,
        raw: str,
    ) -> tuple[str, list[dict], list[dict]]:
        """Parse the model reply; validate/repair any flow proposals."""
        try:
            reply, proposals = self._parse_reply(raw)
        except RuntimeError:
            repaired, events, _ = await self._invoke(
                session.engine,
                session.fast_model,
                session.cwd,
                (
                    "Repair the following response into valid workflow-generation "
                    'JSON of the form {"reply": "...", "flow_proposals": '
                    '[{"title": "...", "workflowName": "...", '
                    '"summary": "...", "steps": {...}}]}. '
                    "Return JSON only.\n\n"
                    f"{raw}"
                ),
                None,
            )
            reply, proposals = self._parse_reply(repaired)

        # Merge incremental patches against the live canvas before validating so
        # validation (and the editor) always see a complete flow.
        proposals = self._merge_patch_proposals(session, proposals)
        valid: list[dict] = []
        first_error: str | None = None
        for item in proposals:
            try:
                self._validate_proposal_steps(item["steps"])
                valid.append(item)
            except WorkflowValidationError as exc:
                if first_error is None:
                    first_error = str(exc)

        # All proposals invalid → ask the fast model to repair them.
        if not valid and proposals and first_error:
            repair_prompt = (
                "The proposed flows below are structurally invalid. Fix ONLY the "
                "structural errors and return the complete corrected JSON "
                '{"reply": "...", "flow_proposals": [{"title": "...", '
                '"workflowName": "...", "summary": "...", "steps": {...}}]} '
                "keeping the same number of proposals. "
                "Return JSON only.\n\n"
                f"Validation error: {first_error}\n\n"
                f"Proposals:\n{json.dumps(proposals, ensure_ascii=False)}"
            )
            repaired, events, _ = await self._invoke(
                session.engine,
                session.fast_model,
                session.cwd,
                repair_prompt,
                None,
            )
            try:
                _reply, fixed_proposals = self._parse_reply(repaired)
            except RuntimeError:
                return reply, [], events
            fixed_proposals = self._merge_patch_proposals(session, fixed_proposals)
            for item in fixed_proposals:
                try:
                    self._validate_proposal_steps(item["steps"])
                    valid.append(item)
                except WorkflowValidationError:
                    continue
            if valid:
                return _reply, valid, events
            return reply, [], events + [
                {
                    "type": "flow_proposals_rejected",
                    "data": {
                        "message": (
                            f"流程方案未通过画布校验，已丢弃：{first_error}"
                        )
                    },
                }
            ]

        return reply, valid, []

    @staticmethod
    def _validate_proposal_steps(steps: dict) -> None:
        """Require the canvas fields consumed by the editor, then validate the DAG."""
        nodes = steps.get("nodes")
        if isinstance(nodes, list):
            if "edges" in steps:
                raise WorkflowValidationError(
                    "edges: use the canvas field 'connections'"
                )
            for index, node in enumerate(nodes):
                if not isinstance(node, dict):
                    raise WorkflowValidationError(
                        f"nodes[{index}]: expected an object"
                    )
                node_id = node.get("id")
                if (
                    not isinstance(node_id, int)
                    or isinstance(node_id, bool)
                    or node_id <= 0
                ):
                    raise WorkflowValidationError(
                        f"nodes[{index}].id: expected a positive integer"
                    )
                for field in ("type", "title"):
                    value = node.get(field)
                    if not isinstance(value, str) or not value.strip():
                        raise WorkflowValidationError(
                            f"nodes[{index}].{field}: value is required"
                        )
        WorkflowDefinition.load(steps).validate()

    async def _publish_proposals(
        self,
        session,
        assistant_message_id: str,
        reply: str,
        proposals: list[dict],
        seq: int,
    ) -> tuple[int, list[dict]]:
        proposal_cards = []
        for index, item in enumerate(proposals):
            steps = item["steps"]
            step_changes = item.get("stepChanges") or []
            card = {
                "id": f"p{index + 1}",
                "title": item.get("title") or f"方案 {index + 1}",
                "workflowName": item.get("workflowName", ""),
                "summary": item.get("summary", ""),
                "steps": steps,
                "nodeCount": len(steps.get("nodes") or steps.get("steps") or []),
                "autoApply": bool(item.get("autoApply", False)),
            }
            if step_changes:
                card["stepChanges"] = step_changes
                if isinstance(item.get("patch"), dict):
                    card["patch"] = item["patch"]
                # Editing an existing workflow always waits for an explicit
                # user action. One changed step applies directly; multiple
                # steps open the step picker in the editor.
                card["autoApply"] = False
            proposal_cards.append(card)
        data = {"proposals": proposal_cards}
        seq = await self._publish(
            session,
            assistant_message_id,
            "flow_proposals",
            data,
            seq,
        )
        return seq, [{"type": "flow_proposals", "data": data}]

    @staticmethod
    def _normalize_proposal(item: object) -> dict | None:
        if not isinstance(item, dict):
            return None
        steps = item.get("steps")
        if not isinstance(steps, dict):
            return None
        title = item.get("title")
        workflow_name = item.get("workflowName") or item.get("workflow_name")
        summary = item.get("summary")
        return {
            "title": title if isinstance(title, str) and title.strip() else "",
            "workflowName": (
                re.sub(r"\s+", "", workflow_name)
                if isinstance(workflow_name, str) and workflow_name.strip()
                else ""
            ),
            "summary": (
                summary if isinstance(summary, str) and summary.strip() else ""
            ),
            "steps": steps,
            "autoApply": bool(item.get("autoApply", False)),
            "replaceCanvas": item.get("replaceCanvas") is True,
        }

    @staticmethod
    def _parse_reply(raw: str) -> tuple[str, list[dict]]:
        candidates: list[str] = []
        fenced = re.search(r"```(?:json)?\s*(\{.*\})\s*```", raw, re.DOTALL)
        if fenced:
            candidates.append(fenced.group(1))
        start, end = raw.find("{"), raw.rfind("}")
        if start >= 0 and end > start:
            candidates.append(raw[start : end + 1])
        for candidate in candidates:
            try:
                parsed = json.loads(candidate)
            except json.JSONDecodeError:
                continue
            if not isinstance(parsed, dict):
                continue
            reply = parsed.get("reply")
            if not isinstance(reply, str):
                continue
            raw_items = parsed.get("flow_proposals")
            if not isinstance(raw_items, list):
                raw_items = parsed.get("proposals")
            if not isinstance(raw_items, list):
                raw_items = parsed.get("options")
            if isinstance(raw_items, list):
                items = [
                    WorkflowGenModule._normalize_proposal(item)
                    for item in raw_items
                ]
                return reply, [item for item in items if item is not None]
            legacy = parsed.get("flow_proposal")
            if isinstance(legacy, dict):
                item = WorkflowGenModule._normalize_proposal({"steps": legacy})
                return reply, [item] if item is not None else []
            return reply, []
        raise RuntimeError("Workflow generator returned invalid JSON")

    @staticmethod
    def _history_message(item: dict) -> dict:
        from agent_assistants.base import default_history_message

        return default_history_message(item)


def _workflow_gen_session_model():
    """Lazily import the persistence model (avoids circular imports)."""
    from models.gen_session import WorkflowGenSession

    return WorkflowGenSession
