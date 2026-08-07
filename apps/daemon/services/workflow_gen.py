"""In-memory, non-task workflow generation chat module.

The AI flow generator lets users design a workflow canvas through a
multi-turn conversation with the coordinator engine (generation mode).
Sessions live in memory only — no task rows, no message rows and no DB
writes. Live events are published on the global event bus with a
``session_id`` (and no ``task_id``) so the web UI can render the chat and
apply ``flow_proposals`` events to the canvas preview.
"""

import asyncio
import json
import logging
import re
import time
import uuid
from dataclasses import dataclass, field
from typing import Awaitable, Callable

from engines.events import InternalEvent
from engines.registry import create_engine
from models.fields import utc_now
from services.config import config_store
from services.coordinator import extract_streaming_reply
from services.workflow_definition import (
    WorkflowDefinition,
    WorkflowValidationError,
)
from streaming.bus import EventBus

logger = logging.getLogger(__name__)

GEN_CHANNEL = "flow_gen"

MAX_HISTORY_TURNS = 8
MAX_SESSIONS = 200
SESSION_TTL_SECONDS = 60 * 60

SYSTEM_PROMPT = """你是 WorkStep 的流程设计助手（协调 Agent 的流程生成模式）。你通过多轮对话帮用户设计一个可执行的工作流（workflow），最终输出画布 JSON。

工作方式：
1. 第一轮先澄清关键信息，最多追问 2 个问题（每次只问当前最关键的问题）：目标产物、输入与输出、约束或偏好（是否需要审核、是否并行分支、使用哪些阶段）。
2. 信息足够后，输出自然语言说明 + 2~3 个不同的完整流程方案（flow_proposals），供用户选择。方案之间要有实质差异（例如：简洁版 / 标准版（含并行或审核）/ 完整版），每个方案包含标题、一句话摘要与完整画布 JSON。
3. 用户后续会用自然语言调整（如"去掉测试阶段"、"加一个审核"、"这两段并行执行"），你要基于最新会话历史重新输出完整 JSON，不要只给增量。

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

回复必须是合法 JSON，格式：{"reply": "给用户的自然语言回复（markdown）", "flow_proposals": [{"title": "方案标题", "summary": "一句话说明", "steps": <画布JSON>}]}
当还在澄清阶段时 flow_proposals 必须为空数组 []。"""


@dataclass
class GenSession:
    """One in-memory workflow generation conversation."""

    session_id: str
    project_id: str
    cwd: str
    engine: str
    model: str | None = None
    fast_model: str | None = None
    resolved_session_id: str | None = None
    messages: list[dict] = field(default_factory=list)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    last_active: float = field(default_factory=time.monotonic)


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


class WorkflowGenModule:
    """Coordinates memory-only workflow design conversations."""

    def __init__(self, event_bus: EventBus, project_manager):
        self._event_bus = event_bus
        self._project_manager = project_manager
        self._sessions: dict[tuple[str, str], GenSession] = {}
        self._turn_keys: dict[tuple[str, str, str], str] = {}
        self._turn_states: dict[str, dict] = {}
        self._active_tasks: set[asyncio.Task] = set()

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
    ) -> ChatAccepted:
        """Queue one generation turn; returns immediately with an accepted turn."""
        normalized = (content or "").strip()
        if not normalized:
            raise ValueError("Message content cannot be empty")
        if not (idempotency_key or "").strip():
            raise ValueError("Idempotency-Key is required")

        key = (project_id, session_id or "", idempotency_key)
        existing_turn_id = self._turn_keys.get(key)
        if existing_turn_id is not None and existing_turn_id in self._turn_states:
            return ChatAccepted(
                session_id=self._turn_states[existing_turn_id].get(
                    "session_id", session_id or ""
                ),
                turn_id=existing_turn_id,
                status=self._turn_states[existing_turn_id]["status"],
            )

        engine_id, default_model, default_fast_model = self._resolve_engine_models()
        if engine:
            candidate = create_engine(engine)
            if candidate is None or not candidate.capabilities.supports_coordinator:
                raise ValueError(
                    f"Coordinator engine is unavailable: {engine}"
                )
            engine_id = engine
        model = model or default_model
        fast_model = fast_model or default_fast_model
        session = self._get_or_create_session(
            project_id, session_id, engine_id, model, fast_model
        )

        turn_id = str(uuid.uuid4())
        assistant_message_id = str(uuid.uuid4())
        session.messages.append({"role": "user", "content": normalized})
        self._turn_keys[key] = turn_id
        self._turn_states[turn_id] = {
            "status": "queued",
            "assistant_message_id": assistant_message_id,
            "session_id": session.session_id,
        }
        background = asyncio.create_task(
            self._run_turn(session, turn_id, assistant_message_id),
            name=f"workflow-gen:{turn_id}",
        )
        self._active_tasks.add(background)
        background.add_done_callback(self._consume_background)
        return ChatAccepted(
            session_id=session.session_id,
            turn_id=turn_id,
            status="queued",
        )

    async def shutdown(self) -> None:
        tasks = tuple(self._active_tasks)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._sessions.clear()
        self._turn_keys.clear()
        self._turn_states.clear()

    # ── session management ──────────────────────────────────────────────

    def _get_or_create_session(
        self,
        project_id: str,
        session_id: str | None,
        engine_id: str,
        model: str | None,
        fast_model: str | None,
    ) -> GenSession:
        self._prune_sessions()
        sid = session_id or str(uuid.uuid4())
        session = self._sessions.get((project_id, sid))
        if session is None:
            with self._project_manager.activate_project_by_id(project_id) as project:
                cwd = str(project.path)
            session = GenSession(
                session_id=sid,
                project_id=project_id,
                cwd=cwd,
                engine=engine_id,
                model=model,
                fast_model=fast_model,
            )
            self._sessions[(project_id, sid)] = session
        else:
            session.engine = engine_id
            session.model = model
            session.fast_model = fast_model
        return session

    def _prune_sessions(self) -> None:
        now = time.monotonic()
        stale = [
            key
            for key, session in self._sessions.items()
            if now - session.last_active > SESSION_TTL_SECONDS
        ]
        for key in stale:
            self._sessions.pop(key, None)
        if len(self._sessions) > MAX_SESSIONS:
            oldest = sorted(
                self._sessions.items(), key=lambda item: item[1].last_active
            )[: len(self._sessions) - MAX_SESSIONS]
            for key, _ in oldest:
                self._sessions.pop(key, None)
        # Bound turn idempotency state (dicts preserve insertion order).
        if len(self._turn_states) > MAX_SESSIONS * 5:
            overflow = len(self._turn_states) - MAX_SESSIONS * 5
            for turn_id in list(self._turn_states)[:overflow]:
                self._turn_states.pop(turn_id, None)
        if len(self._turn_keys) > MAX_SESSIONS * 5:
            overflow = len(self._turn_keys) - MAX_SESSIONS * 5
            for key in list(self._turn_keys)[:overflow]:
                self._turn_keys.pop(key, None)

    def _resolve_engine_models(self) -> tuple[str, str | None, str | None]:
        engine_id = config_store.get_coordinator_default_engine() or "claude"
        engine = create_engine(engine_id)
        if engine is None or not engine.capabilities.supports_coordinator:
            raise ValueError(f"Coordinator engine is unavailable: {engine_id}")
        model = (
            config_store.get_coordinator_default_model()
            or config_store.get_engine_default_model(engine_id)
            or None
        )
        get_fast_model = getattr(
            config_store,
            "get_coordinator_default_fast_model",
            lambda: "",
        )
        fast_model = get_fast_model() or model
        return engine_id, model, fast_model

    # ── turn execution ──────────────────────────────────────────────────

    def _build_prompt(self, session: GenSession) -> str:
        turns = session.messages[-(MAX_HISTORY_TURNS * 2):]
        history = "\n\n".join(
            f"{'用户' if item['role'] == 'user' else '助手'}：{item['content']}"
            for item in turns
        )
        return f"{SYSTEM_PROMPT}\n\n历史对话：\n{history}\n\n请继续。"

    async def _run_turn(
        self,
        session: GenSession,
        turn_id: str,
        assistant_message_id: str,
    ) -> None:
        async with session.lock:
            session.last_active = time.monotonic()
            self._turn_states[turn_id]["status"] = "running"
            seq = 0
            try:
                prompt = self._build_prompt(session)
                seq = await self._publish(
                    session,
                    assistant_message_id,
                    "message_started",
                    {"prompt": prompt},
                    seq,
                )
                seq_holder = [seq]

                def make_live_callback():
                    raw_content = ""
                    streamed_reply = ""

                    async def publish_live_event(event: InternalEvent) -> None:
                        nonlocal raw_content, streamed_reply
                        if event.type == "text_delta":
                            raw_content += str(event.data.get("delta", ""))
                            partial_reply = extract_streaming_reply(raw_content)
                            if not partial_reply.startswith(streamed_reply):
                                return
                            delta = partial_reply[len(streamed_reply):]
                            if not delta:
                                return
                            streamed_reply = partial_reply
                            await self._publish(
                                session,
                                assistant_message_id,
                                "text_delta",
                                {"delta": delta},
                                seq_holder[0],
                            )
                            seq_holder[0] += 1

                    return publish_live_event

                raw, _events, resolved = await self._invoke(
                    session.engine,
                    session.model,
                    session.cwd,
                    prompt,
                    session.resolved_session_id,
                    make_live_callback(),
                )
                session.resolved_session_id = resolved

                reply, proposals, repair_events = await self._resolve_proposal(
                    session, raw
                )
                for extra_event in repair_events:
                    await self._publish(
                        session,
                        assistant_message_id,
                        extra_event.get("type", "status"),
                        extra_event.get("data", {}),
                        seq_holder[0],
                    )
                    seq_holder[0] += 1
                if proposals:
                    proposal_cards = []
                    for index, item in enumerate(proposals):
                        steps = item["steps"]
                        proposal_cards.append(
                            {
                                "id": f"p{index + 1}",
                                "title": item.get("title") or f"方案 {index + 1}",
                                "summary": item.get("summary", ""),
                                "steps": steps,
                                "nodeCount": len(
                                    steps.get("nodes")
                                    or steps.get("steps")
                                    or []
                                ),
                            }
                        )
                    seq_holder[0] = await self._publish(
                        session,
                        assistant_message_id,
                        "flow_proposals",
                        {"proposals": proposal_cards},
                        seq_holder[0],
                    )
                seq_holder[0] = await self._publish(
                    session,
                    assistant_message_id,
                    "message_snapshot",
                    {"content": reply},
                    seq_holder[0],
                )
                seq_holder[0] = await self._publish(
                    session,
                    assistant_message_id,
                    "message_completed",
                    {"status": "succeeded", "content": reply},
                    seq_holder[0],
                )
                session.messages.append({"role": "assistant", "content": reply})
                self._turn_states[turn_id]["status"] = "completed"
            except Exception as exc:
                logger.exception("Workflow generation turn failed")
                session.messages.append(
                    {"role": "assistant", "content": f"（生成失败：{exc}）"}
                )
                try:
                    seq = await self._publish(
                        session,
                        assistant_message_id,
                        "error",
                        {"message": str(exc)},
                        seq,
                    )
                    await self._publish(
                        session,
                        assistant_message_id,
                        "message_completed",
                        {"status": "error", "content": str(exc)},
                        seq,
                    )
                except Exception:
                    pass
                self._turn_states[turn_id]["status"] = "error"
            finally:
                session.last_active = time.monotonic()

    async def _resolve_proposal(
        self,
        session: GenSession,
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

    async def _invoke(
        self,
        engine_id: str,
        model: str | None,
        cwd: str,
        prompt: str,
        session_id: str | None,
        on_event: Callable[[InternalEvent], Awaitable[None]] | None = None,
    ) -> tuple[str, list[dict], str | None]:
        engine = create_engine(engine_id)
        if engine is None:
            raise RuntimeError(f"Workflow generation engine is unavailable: {engine_id}")
        content: list[str] = []
        events: list[dict] = []
        resolved_session_id = session_id
        error: str | None = None
        async for event in engine.spawn(
            prompt=prompt,
            cwd=cwd,
            model=model,
            session_id=session_id if engine.supports_resume else None,
        ):
            events.append(event.to_dict())
            if on_event is not None:
                await on_event(event)
            if event.type == "text_delta":
                content.append(str(event.data.get("delta", "")))
            elif event.type == "session_started":
                resolved_session_id = str(event.data.get("session_id") or "") or None
            elif event.type == "usage" and event.data.get("session_id"):
                resolved_session_id = str(event.data["session_id"])
            elif event.type == "error" and error is None:
                error = str(
                    event.data.get("message")
                    or "Workflow generation engine failed"
                )
        if error:
            raise RuntimeError(error)
        return "".join(content).strip(), events, resolved_session_id

    async def _publish(
        self,
        session: GenSession,
        assistant_message_id: str,
        event_type: str,
        data: dict,
        event_sequence: int,
    ) -> int:
        await self._event_bus.publish(
            {
                "event_id": str(uuid.uuid4()),
                "session_id": session.session_id,
                "channel": GEN_CHANNEL,
                "message_id": assistant_message_id,
                "engine": session.engine,
                "model": session.model,
                "event_sequence": event_sequence,
                "type": event_type,
                "data": data,
                "created_at": utc_now().isoformat(),
            }
        )
        return event_sequence + 1

    def _consume_background(self, task: asyncio.Task) -> None:
        self._active_tasks.discard(task)
        if not task.cancelled():
            task.exception()
