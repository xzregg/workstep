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
from services.config import CONFIG_DIR, config_store
from services.workflow_definition import (
    WorkflowDefinition,
    WorkflowValidationError,
)

GEN_CHANNEL = "flow_gen"

MAX_HISTORY_TURNS = 8
MAX_SESSIONS = 200
SESSION_TTL_SECONDS = 60 * 60

SYSTEM_PROMPT = """你是 WorkStep 的流程设计助手（协调 Agent 的流程生成模式）。你通过多轮对话帮用户设计一个可执行的工作流（workflow），最终输出画布 JSON。

工作方式：
1. 第一轮先澄清关键信息，最多追问 2 个问题（每次只问当前最关键的问题）：目标产物、输入与输出、约束或偏好（是否需要审核、是否并行分支、使用哪些阶段）。
2. 信息足够后，输出自然语言说明 + 2~3 个不同的完整流程方案（flow_proposals），供用户选择。方案之间要有实质差异（例如：简洁版 / 标准版（含并行或审核）/ 完整版），每个方案包含标题、一句话摘要与完整画布 JSON。
3. 用户后续会用自然语言调整（如"去掉测试阶段"、"加一个审核"、"这两段并行执行"），你要基于最新会话历史返回一个完整方案到 flow_proposals，不要只给增量。编辑已有流程且调整目标明确时只返回 1 个方案，并设置 "autoApply": true，由前端直接应用到画布。

画布 JSON 规范：
{
  "nodes": [
    {"id": 1, "type": "req", "title": "需求", "autoStart": true, "engine": "claude", "model": "", "color": "#888888",
     "prompt": "该阶段给 LLM 的提示词（可选）",
     "inputs": [{"name": "输入", "type": "document", "outputs": [{"name": "需求规格", "type": "document"}]}],
     "outputs": [{"name": "需求规格", "type": "document"}]}
  ],
  "connections": [{"from": 1, "fromPort": 0, "to": 2, "toPort": 0, "kind": "solid"}]
}

规则：
- nodes.id：正整数，唯一；type：小写英文字母与连字符（如 req、ui-design、dev-backend、test、publish），同一流程内不能重复；title：中文阶段名。
- engine 可选，默认 "claude"；color 可选；review 可选（{"auto": true/false, "maxRetries": 1, "prompt": "审核标准"}）。
- connections 可省略，缺省表示按 nodes 顺序串行；from/to 必须是已有节点 id；fromPort/toPort 在对应端口范围内；kind 为 "solid"（数据流）或 "dashed"（返工反馈）。

回复必须是合法 JSON，格式：{"reply": "给用户的自然语言回复（markdown）", "flow_proposals": [{"title": "方案标题", "summary": "一句话说明", "steps": <画布JSON>, "autoApply": false}]}
当还在澄清阶段时 flow_proposals 必须为空数组 []。
- reply 只能包含给用户看的说明和 A2UI 控件，严禁在 reply 中输出画布 JSON、```json 代码块或“当前完整画布 JSON 如下”等内容。完整画布只能放入 flow_proposals[].steps。
- 首次给出 2~3 个备选方案时 autoApply 必须为 false 或省略；用户已明确选择方案、或要求直接修改当前流程时，返回唯一一个完整方案并设置 autoApply: true，前端会自动加载到画布。

A2UI 交互控件（方案/选项必须给用户可点选的界面）：
向用户展示方案或选项时，reply 中必须包含完整的 ```a2ui 代码块，输出 A2UI v0.9.1 JSONL 交互界面（方案选择按钮、澄清问题选项等），不要只用纯文本罗列。如果 reply 中没有 a2ui 方案按钮，后端会自动为 flow_proposals 追加方案选择界面。每条 JSON 消息占一行，先 createSurface 再 updateComponents：
{"version":"v0.9.1","createSurface":{"surfaceId":"plan-select","catalogId":"basic"}}
{"version":"v0.9.1","updateComponents":{"surfaceId":"plan-select","components":[{"component":"Column","id":"root","children":["hint","b1","b2"]},{"component":"Text","id":"hint","text":"请选择一个方案"},{"component":"Text","id":"b1-label","text":"简洁版"},{"component":"Button","id":"b1","child":"b1-label","variant":"primary","action":{"event":{"name":"apply_flow","context":{"proposal":1}}}},{"component":"Text","id":"b2-label","text":"标准版"},{"component":"Button","id":"b2","child":"b2-label","action":{"event":{"name":"apply_flow","context":{"proposal":2}}}}]}}
- 组件树必须有一个 id 固定为 "root" 的 Column 容器，children 只引用同一条 updateComponents 里已声明的组件 id；Button/Card 的 child 也必须引用已声明的组件 id（按钮文字用单独的 Text 标签组件，不要直接把文案填进 child）。
- 方案选择按钮的 action.event.name 固定为 apply_flow；context.proposal 填该方案在同一条回复 flow_proposals 中的序号（从 1 开始）。用户点选后前端会把对应方案应用到画布。
- 方案按钮必须与同条回复的 flow_proposals 一一对应，数量一致。
- 澄清阶段参考简报问卷来组织控件：选项使用 ChoicePicker（displayStyle 为 chips，单选用 mutuallyExclusive、多选用 multipleSelection），需要用户补充的内容使用 TextField（长文本用 variant: longText），最后提供一个提交 Button。
- ChoicePicker/TextField 的 value 可直接给 [] / "" 初始值；提交 Button 使用普通 action（例如 submit_clarification，不要带 apply_flow），context 中将每个答案写成 {"path":"/a2ui/<surfaceId>/<componentId>/value"}，这样用户选择与输入后的当前值会随点击一起返回对话。
- ```a2ui 代码块要完整闭合（前后各三个反引号独占一行），前端只渲染完整闭合的代码块。"""


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


class WorkflowGenModule(AssistantRuntime):
    """The AI flow-design assistant — config + flow-specific hooks."""

    def __init__(self, event_bus, project_manager):
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
        provider_id: str | None = None,
        thinking_effort: str | None = None,
        steps: dict | None = None,
        workflow_name: str | None = None,
        context_mode: str | None = None,
        workflow_id: str | None = None,
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
            provider_id=provider_id,
            thinking_effort=thinking_effort,
            steps=steps,
            extra={
                "workflow_name": (workflow_name or "").strip(),
                "context_mode": resolved_context_mode,
            },
        )
        return ChatAccepted(
            session_id=accepted.session_id,
            turn_id=accepted.turn_id,
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
                f"\n\n当前流程标题：{workflow_name}"
                "\n当前画布 JSON（用户正在编辑的流程，基于它调整或重排，"
                "不要从零设计；节点 id/type 尽量沿用）：\n"
                f"{json.dumps(steps, ensure_ascii=False)}"
            )
        elif context_mode == "canvas_updated":
            canvas_json = (
                "\n\n当前画布已更新（可能包含尚未保存的改动，请以此版本为准）：\n"
                f"{json.dumps(steps, ensure_ascii=False)}"
            )
        engine = create_engine(session.engine)
        if engine is not None and engine.supports_resume:
            # 引擎侧维护会话上下文：历史不再拼进 prompt。首轮携带完整系统
            # 提示，续轮只发当前画布与用户消息，避免重复污染引擎会话。
            user_message = (
                session.messages[-1]["content"] if session.messages else ""
            )
            head = SYSTEM_PROMPT if not session.resolved_session_id else ""
            return f"{head}{canvas_json}\n\n{user_message}"
        # 无引擎侧会话的引擎（不支持 resume）：保留最近对话记录拼接，
        # 否则多轮对话将完全失去上下文。
        turns = session.messages[-(MAX_HISTORY_TURNS * 2):]
        history = "\n\n".join(
            f"{'用户' if item['role'] == 'user' else '助手'}：{item['content']}"
            for item in turns
        )
        return (
            f"{SYSTEM_PROMPT}"
            f"{canvas_json}\n\n历史对话：\n{history}\n\n请继续。"
        )

    # ── response parsing & proposal publishing ──────────────────────────

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
            except WorkflowValidationError as exc:
                events.append({
                    "type": "flow_proposals_rejected",
                    "data": {"message": f"画布 JSON 未通过校验，已丢弃：{exc}"},
                })
        if proposals:
            reply, a2ui_payloads = self._ensure_a2ui_choice_ui(reply, proposals)
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

    @staticmethod
    def _has_a2ui_fence(content: str) -> bool:
        """True when the reply already contains a complete ```a2ui fence."""
        return re.search(
            r"^```a2ui[ \t]*\r?\n[\s\S]*?^```[ \t]*\r?\n?",
            content,
            re.MULTILINE,
        ) is not None

    @staticmethod
    def _ensure_a2ui_choice_ui(reply: str, proposals: list[dict]) -> tuple[str, list[dict]]:
        """保证方案选择界面：返回 (reply, a2ui 事件载荷列表)。

        模型自带 `````a2ui```` fence 时保留 fence（并注入 stepsJson），UI 走
        fence 渲染、不发事件；否则自动生成 createSurface + updateComponents
        作为 ``a2ui`` 事件推送，reply 只留文本摘要。
        """
        if not proposals:
            return reply, []
        if WorkflowGenModule._has_a2ui_fence(reply):
            return WorkflowGenModule._inject_a2ui_flow_steps(reply, proposals), []
        components: list[dict] = [
            {
                "component": "Text",
                "id": "hint",
                "text": "请选择一个方案（点击按钮应用到画布）",
            }
        ]
        root_children: list[str] = ["hint"]
        for index, item in enumerate(proposals, start=1):
            # A2UI Button.child 引用的是组件 id，按钮文字由独立的 Text 标签提供。
            label_id = f"l{index}"
            button_id = f"p{index}"
            components.append(
                {
                    "component": "Text",
                    "id": label_id,
                    "text": item.get("title") or f"方案 {index}",
                }
            )
            components.append(
                {
                    "component": "Button",
                    "id": button_id,
                    "child": label_id,
                    "variant": "primary" if index == 1 else "default",
                    "action": {
                        "event": {
                            "name": "apply_flow",
                            "context": {
                                "proposal": index,
                                "stepsJson": json.dumps(
                                    item["steps"],
                                    ensure_ascii=False,
                                    separators=(",", ":"),
                                ),
                            },
                        }
                    },
                }
            )
            root_children.extend([label_id, button_id])
            summary = item.get("summary")
            if summary:
                summary_id = f"s{index}"
                components.append(
                    {
                        "component": "Text",
                        "id": summary_id,
                        "text": summary,
                        "variant": "caption",
                    }
                )
                root_children.append(summary_id)
        components.insert(
            0,
            {
                "component": "Column",
                "id": "root",
                "children": root_children,
            },
        )
        payloads = [
            {
                "version": "v0.9.1",
                "createSurface": {
                    "surfaceId": "flow-choice",
                    "catalogId": "basic",
                },
            },
            {
                "version": "v0.9.1",
                "updateComponents": {
                    "surfaceId": "flow-choice",
                    "components": components,
                },
            },
        ]
        # reply 只留文本摘要；UI 以 a2ui 事件推送（前端 store 渲染）。
        return reply.rstrip(), payloads


    @staticmethod
    def _inject_a2ui_flow_steps(reply: str, proposals: list[dict]) -> str:
        """Make model-authored apply buttons self-contained across refreshes."""
        fence_pattern = re.compile(
            r"(^```a2ui[ \t]*\r?\n)([\s\S]*?)(^```[ \t]*\r?\n?)",
            re.MULTILINE,
        )

        def enrich(match: re.Match) -> str:
            body = match.group(2)
            messages = []
            decoder = json.JSONDecoder()
            index = 0
            try:
                while index < len(body):
                    while index < len(body) and body[index].isspace():
                        index += 1
                    if index >= len(body):
                        break
                    message, index = decoder.raw_decode(body, index)
                    messages.append(message)
            except (json.JSONDecodeError, TypeError):
                return match.group(0)

            changed = False
            for message in messages:
                update = message.get("updateComponents") if isinstance(message, dict) else None
                components = update.get("components") if isinstance(update, dict) else None
                if not isinstance(components, list):
                    continue
                for component in components:
                    if not isinstance(component, dict) or component.get("component") != "Button":
                        continue
                    action = component.get("action")
                    event = action.get("event") if isinstance(action, dict) else None
                    if not isinstance(event, dict) or event.get("name") != "apply_flow":
                        continue
                    context = event.get("context")
                    if not isinstance(context, dict) or "stepsJson" in context:
                        continue
                    try:
                        proposal_index = int(context.get("proposal")) - 1
                        steps = proposals[proposal_index]["steps"]
                    except (TypeError, ValueError, IndexError, KeyError):
                        continue
                    context["stepsJson"] = json.dumps(
                        steps, ensure_ascii=False, separators=(",", ":")
                    )
                    proposal_id = proposals[proposal_index].get("id") if isinstance(proposals[proposal_index], dict) else None
                    if proposal_id:
                        context["proposalId"] = proposal_id
                    changed = True
            if not changed:
                return match.group(0)
            body = "\n".join(json.dumps(item, ensure_ascii=False) for item in messages)
            return f"{match.group(1)}{body}\n{match.group(3)}"

        return fence_pattern.sub(enrich, reply)

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
                    '[{"title": "...", "summary": "...", "steps": {...}}]}. '
                    "Return JSON only.\n\n"
                    f"{raw}"
                ),
                None,
            )
            reply, proposals = self._parse_reply(repaired)

        valid: list[dict] = []
        first_error: str | None = None
        for item in proposals:
            try:
                WorkflowDefinition.load(item["steps"]).validate()
                valid.append(item)
            except WorkflowValidationError as exc:
                if first_error is None:
                    first_error = str(exc)

        # All proposals invalid → ask the fast model to repair them.
        if not valid and proposals and first_error:
            repair_prompt = (
                "The proposed flows below are structurally invalid. Fix ONLY the "
                "structural errors and return the complete corrected JSON "
                '{"reply": "...", "flow_proposals": [{"title": "...", "summary": '
                '"...", "steps": {...}}]} keeping the same number of proposals. '
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
            for item in fixed_proposals:
                try:
                    WorkflowDefinition.load(item["steps"]).validate()
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
            proposal_cards.append(
                {
                    "id": f"p{index + 1}",
                    "title": item.get("title") or f"方案 {index + 1}",
                    "summary": item.get("summary", ""),
                    "steps": steps,
                    "nodeCount": len(steps.get("nodes") or steps.get("steps") or []),
                    "autoApply": bool(item.get("autoApply", False)),
                }
            )
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
        summary = item.get("summary")
        return {
            "title": title if isinstance(title, str) and title.strip() else "",
            "summary": (
                summary if isinstance(summary, str) and summary.strip() else ""
            ),
            "steps": steps,
            "autoApply": bool(item.get("autoApply", False)),
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
