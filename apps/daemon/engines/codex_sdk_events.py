"""Codex SDK notifications translated into internal ACP-aligned events."""

from typing import Any

from engines.codex_events import codex_raw_event
from engines.codex_visualize import CodexVisualizeStream
from engines.core.events import (
    InternalEvent,
    UnphasedMessageClassifier,
    agent_message_chunk,
    compacted_event,
    extract_reasoning_text,
    tool_call_event,
    tool_call_update_event,
    usage_update_event,
)
from engines.core.plans import codex_subagent_events, plan_event
from engines.core.tool_inputs import file_change_input


def _is_codex_sdk_terminal_event(event: InternalEvent) -> bool:
    if event.type in {"usage_update", "error"}:
        return True
    return (
        event.type == "status"
        and event.data.get("status") in {"done", "cancelled", "failed"}
    )


class CodexSDKNotificationMapper:
    """Own item phases, tool updates, usage, and raw SDK passthrough."""

    @classmethod
    def _goal_data(cls, goal: Any) -> dict[str, Any]:
        data = {
            "objective": str(getattr(goal, "objective", "") or ""),
            "status": str(cls._plain(getattr(goal, "status", "")) or ""),
        }
        for key in ("tokens_used", "token_budget", "time_used_seconds"):
            value = getattr(goal, key, None)
            if value is not None:
                data[key] = value
        return data

    # --- Notification mapping ---

    @staticmethod
    def _notification_method(notification: Any) -> str:
        return str(getattr(notification, "method", "") or "")

    @staticmethod
    def _visualize_stream(state: dict[str, Any], item_id: str) -> CodexVisualizeStream:
        item_key = item_id or "__default__"
        streams = state.setdefault("visualize_streams", {})
        return streams.setdefault(item_key, CodexVisualizeStream())

    @staticmethod
    def _root_of(item: Any) -> Any:
        return getattr(item, "root", item)

    @staticmethod
    def _plain(value: Any) -> Any:
        if hasattr(value, "model_dump"):
            return value.model_dump(by_alias=True, mode="json")
        if isinstance(value, list):
            return [CodexSDKNotificationMapper._plain(item) for item in value]
        if isinstance(value, dict):
            return {key: CodexSDKNotificationMapper._plain(item) for key, item in value.items()}
        enum_value = getattr(value, "value", None)
        return enum_value if enum_value is not None else value

    @staticmethod
    def _status_value(root: Any) -> str:
        status = getattr(root, "status", "")
        return str(getattr(status, "value", status) or "").lower()

    @classmethod
    def _tool_use_event(cls, root: Any) -> InternalEvent:
        rtype = getattr(root, "type", "")
        if rtype == "commandExecution":
            name = "Bash"
            tool_input = {"command": getattr(root, "command", "") or ""}
            if getattr(root, "cwd", None):
                tool_input["cwd"] = str(root.cwd)
        elif rtype == "mcpToolCall":
            server = getattr(root, "server", "") or ""
            tool = getattr(root, "tool", "") or ""
            name = f"{server}/{tool}" if server else tool
            tool_input = cls._plain(getattr(root, "arguments", {}) or {})
        elif rtype == "fileChange":
            name = "EditFile"
            kind = "edit"
            tool_input = file_change_input(
                cls._plain(getattr(root, "changes", []) or [])
            )
        elif rtype == "webSearch":
            name = "WebSearch"
            tool_input = {"query": getattr(root, "query", "") or ""}
        elif rtype == "collabAgentToolCall":
            name = str(cls._plain(getattr(root, "tool", "Agent")) or "Agent")
            tool_input = {
                "prompt": getattr(root, "prompt", None),
                "model": getattr(root, "model", None),
                "receiver_thread_ids": list(
                    getattr(root, "receiver_thread_ids", []) or []
                ),
            }
        else:
            name = getattr(root, "tool", "") or ""
            tool_input = cls._plain(getattr(root, "arguments", {}) or {})
        if rtype != "fileChange":
            kind = "other"
        return tool_call_event(
            tool_call_id=str(getattr(root, "id", "") or ""),
            title=name,
            kind=kind,
            raw_input=tool_input,
        )

    @classmethod
    def _tool_result_event(cls, root: Any) -> InternalEvent:
        rtype = getattr(root, "type", "")
        content_parts: list[str] = []
        if rtype == "commandExecution":
            content_parts.append(str(getattr(root, "aggregated_output", "") or ""))
        elif rtype == "mcpToolCall":
            result = getattr(root, "result", None)
            if result is not None:
                content_parts.append(str(cls._plain(result)))
            error = getattr(root, "error", None)
            if error is not None:
                content_parts.append(str(cls._plain(error)))
        elif rtype in {"fileChange", "collabAgentToolCall", "webSearch"}:
            value = (
                getattr(root, "changes", None)
                or getattr(root, "agents_states", None)
                or getattr(root, "query", None)
                or ""
            )
            content_parts.append(str(cls._plain(value)))
        else:
            for content_item in getattr(root, "content_items", None) or []:
                item_root = cls._root_of(content_item)
                text = getattr(item_root, "text", None)
                if text:
                    content_parts.append(str(text))
        exit_code = getattr(root, "exit_code", None)
        is_error = (
            cls._status_value(root) in {"failed", "declined", "error"}
            or getattr(root, "success", True) is False
            or getattr(root, "error", None) is not None
            or (isinstance(exit_code, int) and exit_code != 0)
        )
        return tool_call_update_event(
            tool_call_id=str(getattr(root, "id", "") or ""),
            status="failed" if bool(is_error) else "completed",
            raw_output="\n".join(content_parts),
        )

    def _map_notification(self, notification, state):
        state.setdefault("unphased", UnphasedMessageClassifier())
        raw_events = self._map_notification_content(notification, state)
        payload = getattr(notification, "payload", None)
        root = self._root_of(getattr(payload, "item", None))
        if getattr(root, "type", "") == "collabAgentToolCall":
            raw_events.extend(codex_subagent_events({
                "receiver_thread_ids": getattr(root, "receiver_thread_ids", []),
                "agents_states": self._plain(getattr(root, "agents_states", {})),
            }))
        events: list[InternalEvent] = []
        for event in raw_events:
            events.extend(state["unphased"].offer(
                event,
                terminal=_is_codex_sdk_terminal_event(event),
                split=True,
            ))
            if (
                event.type == "status"
                and event.data.get("status") == "done"
            ):
                events.extend(state["unphased"].flush())
        return events

    def _map_notification_content(
        self,
        notification: Any,
        state: dict[str, Any],
    ) -> list[InternalEvent]:
        """Map one SDK notification to zero or more InternalEvents.

        ``state`` tracks message phases and emitted text per item, and which
        tool IDs already produced a start event. Unidentified text is buffered
        until its item metadata arrives; completed items never duplicate deltas.
        """
        events: list[InternalEvent] = []
        method = self._notification_method(notification)
        payload = getattr(notification, "payload", None)

        if method == "turn/started":
            events.append(InternalEvent(type="status", data={"status": "running"}))

        elif method == "item/agentMessage/delta":
            delta = getattr(payload, "delta", None) or ""
            if delta:
                item_id = str(getattr(payload, "item_id", "") or "")
                items = state.setdefault("message_items", {})
                item = items.setdefault(item_id, {"text": "", "pending": ""})
                if item.get("completed"):
                    return events
                if item_id and (
                    not item.get("started") or not item.get("phase")
                ):
                    item["pending"] += str(delta)
                else:
                    rendered = self._visualize_stream(state, item_id).feed(str(delta))
                    item["text"] += str(delta)
                    if rendered:
                        state["emitted_text"] = True
                        events.append(agent_message_chunk(
                            rendered, phase=item.get("phase"), source_item_id=item_id,
                        ))

        elif method in ("item/reasoning/textDelta", "item/reasoning/summaryTextDelta"):
            delta = getattr(payload, "delta", None) or ""
            if delta:
                state["emitted_thinking"] = True
                events.append(
                    InternalEvent(
                        type="agent_thought_chunk",
                        data={"content": {"text": str(delta)}},
                    )
                )

        elif method == "item/started":
            root = self._root_of(getattr(payload, "item", None))
            tool_id = getattr(root, "id", None)
            if getattr(root, "type", "") == "agentMessage":
                item_id = str(tool_id or "")
                item = state.setdefault("message_items", {}).setdefault(
                    item_id, {"text": "", "pending": ""},
                )
                phase = getattr(root, "phase", None)
                item["started"] = True
                item["phase"] = getattr(phase, "value", phase)
                if item["pending"] and item["phase"]:
                    rendered = self._visualize_stream(state, item_id).feed(item["pending"])
                    if rendered:
                        events.append(agent_message_chunk(
                            rendered, phase=item["phase"], source_item_id=item_id,
                        ))
                    item["text"] += item["pending"]
                    item["pending"] = ""
            if (
                getattr(root, "type", "") in {
                    "commandExecution", "fileChange", "mcpToolCall",
                    "dynamicToolCall", "collabAgentToolCall", "webSearch",
                }
                and tool_id not in state["tool_emitted"]
            ):
                state["tool_emitted"].add(tool_id)
                events.append(self._tool_use_event(root))
            elif getattr(root, "type", "") not in {
                "agentMessage",
                "commandExecution",
                "fileChange",
                "mcpToolCall",
                "dynamicToolCall",
                "collabAgentToolCall",
                "webSearch",
            }:
                events.append(codex_raw_event(method, {
                    "item": self._plain(root),
                    "item_id": tool_id,
                }))

        elif method == "item/completed":
            root = self._root_of(getattr(payload, "item", None))
            if root is None:
                return events
            rtype = getattr(root, "type", "")
            if rtype == "agentMessage":
                text = getattr(root, "text", None) or ""
                item_id = str(getattr(root, "id", "") or "")
                item = state.setdefault("message_items", {}).setdefault(
                    item_id, {"text": "", "pending": ""},
                )
                if item.get("completed"):
                    return events
                phase = getattr(root, "phase", None)
                item["phase"] = getattr(phase, "value", phase) or item.get("phase")
                # Old transports without item IDs retain their legacy deduplication.
                emitted = item["text"]
                remaining = str(text)[len(emitted):] if str(text).startswith(emitted) else ""
                if not text:
                    remaining = item["pending"]
                stream = self._visualize_stream(state, item_id)
                rendered = stream.feed(str(remaining)) if remaining else ""
                rendered += stream.flush()
                if rendered and (item_id or not state.get("emitted_text")):
                    state["emitted_text"] = True
                    message_event = agent_message_chunk(
                        rendered, phase=item.get("phase"), source_item_id=item_id,
                    )
                    events.append(message_event)
                delivery = getattr(root, "delivery", None)
                if self._plain(delivery) == "async":
                    questions = [
                        {
                            "title": str(getattr(question, "title", "") or ""),
                            "options": [str(option) for option in getattr(question, "options", None) or []],
                        }
                        for question in getattr(root, "questions", None) or []
                        if getattr(question, "title", None)
                    ]
                    if questions:
                        events.append(InternalEvent(type="async_question", data={
                            "source_item_id": item_id,
                            "questions": questions,
                        }))
                item.update(text=str(text), pending="", completed=True)
            elif rtype == "reasoning":
                text = extract_reasoning_text(getattr(root, "content", None))
                if not text:
                    text = extract_reasoning_text(getattr(root, "summary", None))
                if text and not state.get("emitted_thinking", False):
                    state["emitted_thinking"] = True
                    events.append(
                        InternalEvent(
                            type="agent_thought_chunk",
                            data={"content": {"text": str(text)}},
                        )
                    )
            elif rtype == "plan":
                text = getattr(root, "text", None)
                plan_id = str(getattr(root, "id", "") or "")
                data: dict[str, Any] = {
                    "id": plan_id,
                    "type": "markdown",
                    "complete": True,
                }
                if text is not None:
                    data["content"] = str(text)
                    state.setdefault("plan_items", {})[plan_id] = str(text)
                events.append(InternalEvent(type="plan_update", data=data))
            elif rtype in {
                "commandExecution", "fileChange", "mcpToolCall",
                "dynamicToolCall", "collabAgentToolCall", "webSearch",
            }:
                status_value = self._status_value(root)
                tool_id = getattr(root, "id", None)
                if status_value in {"inprogress", "pending", "running"}:
                    if tool_id not in state["tool_emitted"]:
                        state["tool_emitted"].add(tool_id)
                        events.append(self._tool_use_event(root))
                else:
                    events.append(self._tool_result_event(root))
            elif rtype == "contextCompaction":
                events.append(compacted_event())
            else:
                events.append(codex_raw_event(method, {
                    "item": self._plain(root),
                    "item_id": getattr(root, "id", None),
                }))

        elif method == "thread/tokenUsage/updated":
            usage = getattr(payload, "token_usage", None)
            source = getattr(usage, "last", None)
            is_context_snapshot = source is not None
            if source is None:
                source = getattr(usage, "total", None)
            if source is not None:
                raw = {
                    "input_tokens": getattr(source, "input_tokens", 0) or 0,
                    "output_tokens": getattr(source, "output_tokens", 0) or 0,
                    "cache_read_input_tokens": getattr(source, "cached_input_tokens", 0) or 0,
                    "total_tokens": getattr(source, "total_tokens", 0) or 0,
                }
                context_window = None
                if is_context_snapshot:
                    context_window = getattr(usage, "model_context_window", None)
                    if context_window is None:
                        context_window = getattr(usage, "modelContextWindow", None)
                usage_event = usage_update_event(raw, size=context_window)
                reasoning = getattr(source, "reasoning_output_tokens", None)
                if isinstance(reasoning, (int, float)):
                    usage_event.data["reasoning_output_tokens"] = int(reasoning)
                events.append(usage_event)

        elif method == "thread/compacted":
            events.append(compacted_event())

        elif method == "thread/goal/updated":
            goal = getattr(payload, "goal", None)
            events.append(InternalEvent(
                type="goal_update", data=self._goal_data(goal),
            ))

        elif method == "thread/goal/cleared":
            events.append(InternalEvent(type="goal_update", data={"status": "cleared"}))

        elif method == "turn/plan/updated":
            entries = []
            for step in getattr(payload, "plan", None) or []:
                status = getattr(step, "status", "pending")
                entries.append({
                    "step": getattr(step, "step", "") or "",
                    "status": getattr(status, "value", status),
                })
            events.append(plan_event(
                entries,
                explanation=getattr(payload, "explanation", None),
            ))

        elif method == "item/plan/delta":
            delta = getattr(payload, "delta", None)
            item_id = str(getattr(payload, "item_id", "") or "")
            data: dict[str, Any] = {"id": item_id, "type": "markdown"}
            if delta is not None:
                plans = state.setdefault("plan_items", {})
                plans[item_id] = plans.get(item_id, "") + str(delta)
                data["content"] = plans[item_id]
            events.append(InternalEvent(type="plan_update", data=data))

        elif method in (
            "item/commandExecution/outputDelta",
            "item/fileChange/outputDelta",
        ):
            delta = getattr(payload, "delta", None)
            events.append(tool_call_update_event(
                tool_call_id=str(getattr(payload, "item_id", "") or ""),
                status="in_progress",
                raw_output=str(delta) if delta is not None else None,
            ))

        elif method == "item/fileChange/patchUpdated":
            changes = self._plain(getattr(payload, "changes", None) or [])
            events.append(tool_call_update_event(
                tool_call_id=str(getattr(payload, "item_id", "") or ""),
                status="in_progress",
                raw_output=changes,
            ))

        elif method == "item/commandExecution/terminalInteraction":
            stdin = getattr(payload, "stdin", None)
            events.append(tool_call_update_event(
                tool_call_id=str(getattr(payload, "item_id", "") or ""),
                status="in_progress",
                raw_input=(
                    {"stdin": str(stdin), "process_id": getattr(payload, "process_id", None)}
                    if stdin is not None
                    else None
                ),
            ))

        elif method == "item/mcpToolCall/progress":
            message = getattr(payload, "message", None)
            events.append(tool_call_update_event(
                tool_call_id=str(getattr(payload, "item_id", "") or ""),
                status="in_progress",
                raw_output=str(message) if message is not None else None,
            ))

        elif method == "thread/name/updated":
            name = getattr(payload, "thread_name", None)
            events.append(InternalEvent(
                type="session_info_update",
                data={"title": str(name)} if name else {},
            ))

        elif method == "thread/status/changed":
            status = self._plain(getattr(payload, "status", None))
            if isinstance(status, dict):
                status_name = status.get("type") or status.get("status")
            else:
                status_name = status
            data: dict[str, Any] = {}
            if status_name:
                data["thread_status"] = str(status_name)
            if isinstance(status, dict) and status.get("activeFlags") is not None:
                data["active_flags"] = status.get("activeFlags")
            events.append(codex_raw_event(method, {
                "thread_id": getattr(payload, "thread_id", None),
                **data,
                "raw_status": status,
            }))

        elif method == "thread/settings/updated":
            settings = self._plain(getattr(payload, "thread_settings", None))
            data = {"settings": settings} if settings is not None else {}
            thread_id = getattr(payload, "thread_id", None)
            if thread_id:
                data["thread_id"] = str(thread_id)
            events.append(codex_raw_event(method, data))

        elif method in ("hook/started", "hook/completed"):
            run = self._plain(getattr(payload, "run", None))
            data: dict[str, Any] = {"hook_run": run} if run is not None else {}
            for source, target in (
                ("thread_id", "thread_id"),
                ("turn_id", "turn_id"),
            ):
                value = getattr(payload, source, None)
                if value:
                    data[target] = str(value)
            events.append(codex_raw_event(method, data))

        elif method in (
            "item/autoApprovalReview/started",
            "item/autoApprovalReview/completed",
        ):
            data: dict[str, Any] = {}
            for source, target in (
                ("review_id", "review_id"),
                ("target_item_id", "target_item_id"),
                ("thread_id", "thread_id"),
                ("turn_id", "turn_id"),
                ("action", "action"),
                ("decision_source", "decision_source"),
                ("review", "review"),
                ("started_at_ms", "started_at_ms"),
                ("completed_at_ms", "completed_at_ms"),
            ):
                value = getattr(payload, source, None)
                if value is not None:
                    data[target] = self._plain(value)
            events.append(codex_raw_event(method, data))

        elif method == "turn/diff/updated":
            diff = getattr(payload, "diff", None)
            events.append(codex_raw_event(method, {
                "thread_id": getattr(payload, "thread_id", None),
                "turn_id": getattr(payload, "turn_id", None),
                "diff": str(diff) if diff is not None else "",
            }))

        elif method == "model/verification":
            events.append(codex_raw_event(method, {
                "thread_id": getattr(payload, "thread_id", None),
                "turn_id": getattr(payload, "turn_id", None),
                "verifications": self._plain(getattr(payload, "verifications", None) or []),
            }))

        elif method == "model/safetyBuffering/updated":
            events.append(codex_raw_event(method, {
                "thread_id": getattr(payload, "thread_id", None),
                "turn_id": getattr(payload, "turn_id", None),
                "model": getattr(payload, "model", None),
                "faster_model": getattr(payload, "faster_model", None),
                "reasons": self._plain(getattr(payload, "reasons", None) or []),
                "use_cases": self._plain(getattr(payload, "use_cases", None) or []),
                "show_buffering_ui": getattr(payload, "show_buffering_ui", None),
            }))

        elif method in ("process/outputDelta", "command/exec/outputDelta"):
            events.append(codex_raw_event(method, {
                "process_id": (
                    getattr(payload, "process_id", None)
                    or getattr(payload, "process_handle", None)
                ),
                "stream": self._plain(getattr(payload, "stream", None)),
                "delta_base64": getattr(payload, "delta_base64", None),
                "cap_reached": getattr(payload, "cap_reached", None),
            }))

        elif method == "process/exited":
            events.append(codex_raw_event(method, {
                "process_id": getattr(payload, "process_handle", None),
                "exit_code": getattr(payload, "exit_code", None),
                "stdout": getattr(payload, "stdout", None),
                "stderr": getattr(payload, "stderr", None),
                "stdout_cap_reached": getattr(payload, "stdout_cap_reached", None),
                "stderr_cap_reached": getattr(payload, "stderr_cap_reached", None),
            }))

        elif method in (
            "thread/environment/connected",
            "thread/environment/disconnected",
        ):
            events.append(codex_raw_event(method, {
                "thread_id": getattr(payload, "thread_id", None),
                "environment_id": getattr(payload, "environment_id", None),
            }))

        elif method == "skills/changed":
            events.append(codex_raw_event(method, {}))

        elif method in (
            "warning",
            "guardianWarning",
            "configWarning",
            "deprecationNotice",
            "windows/worldWritableWarning",
        ):
            data: dict[str, Any] = {
                key: self._plain(value)
                for key, value in (
                    ("message", getattr(payload, "message", None)),
                    ("summary", getattr(payload, "summary", None)),
                    ("details", getattr(payload, "details", None)),
                    ("path", getattr(payload, "path", None)),
                    ("thread_id", getattr(payload, "thread_id", None)),
                    ("sample_paths", getattr(payload, "sample_paths", None)),
                    ("failed_scan", getattr(payload, "failed_scan", None)),
                )
                if value is not None
            }
            events.append(codex_raw_event(method, data))

        elif method == "model/rerouted":
            events.append(codex_raw_event(
                method,
                {
                    "from_model": getattr(payload, "from_model", None),
                    "to_model": getattr(payload, "to_model", None),
                    "reason": getattr(
                        getattr(payload, "reason", None), "value",
                        getattr(payload, "reason", None),
                    ),
                },
            ))

        elif method == "turn/completed":
            state["turn_completed"] = True
            turn = getattr(payload, "turn", None)
            if turn is None:
                events.append(InternalEvent(type="status", data={"status": "done"}))
                return events
            status = getattr(getattr(turn, "status", None), "value", None)
            if status == "failed":
                error = getattr(turn, "error", None)
                message = getattr(error, "message", None) or "Codex 执行失败"
                events.append(
                    InternalEvent(type="error", data={"message": str(message)})
                )
            else:
                events.append(InternalEvent(type="status", data={"status": "done"}))

        elif method == "error":
            error = getattr(payload, "error", None)
            message = getattr(error, "message", None) or str(error or "Codex SDK 错误")
            # SDK error notifications can describe a transient reconnect while
            # the same turn continues. The final turn result decides success.
            state["notification_error"] = str(message)
            events.append(codex_raw_event(method, {"message": str(message)}))

        else:
            # 未识别的 SDK 原生通知统一透传 acp_raw（不静默丢弃）。
            events.append(codex_raw_event(method or "unknown", payload))

        return events
