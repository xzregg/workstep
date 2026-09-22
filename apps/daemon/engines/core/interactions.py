"""ACP-shaped human interaction events shared by engine adapters."""

from __future__ import annotations

import json

from collections.abc import Iterable, Mapping
from typing import Any

from engines.core.events import InternalEvent


def _json_value(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {str(key): _json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_value(item) for item in value]
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    model_dump = getattr(value, "model_dump", None)
    if callable(model_dump):
        return _json_value(model_dump(by_alias=False, exclude_none=True))
    return str(value)


def permission_signature(tool_name: str, tool_input: object) -> str:
    """Stable signature for remembering a run-scoped permission decision.

    Bash 命令按 ``工具名:命令`` 记忆；其它工具按工具输入 JSON 记忆。
    拿不到工具输入时返回空串，表示该决定只对本调用生效、不跨调用记忆。
    """
    if not isinstance(tool_input, dict) or not tool_input:
        return ""
    command = tool_input.get("command")
    if isinstance(command, str) and command.strip():
        return f"{tool_name}:{command.strip()}"
    return f"{tool_name}:{json.dumps(tool_input, sort_keys=True, ensure_ascii=False)}"



def permission_request(
    *,
    interaction_id: str,
    session_id: str,
    tool_call: Mapping[str, Any],
    options: Iterable[Mapping[str, Any]],
) -> InternalEvent:
    """Build a ``session/request_permission``-shaped internal event."""
    return InternalEvent(type="interaction_request", data={
        "interaction_id": str(interaction_id),
        "method": "session/request_permission",
        "session_id": str(session_id),
        "tool_call": _json_value(tool_call),
        "options": [_json_value(option) for option in options],
    })


def elicitation_request(
    *,
    interaction_id: str,
    message: str,
    requested_schema: Mapping[str, Any],
    session_id: str | None = None,
    tool_call_id: str | None = None,
) -> InternalEvent:
    """Build an ACP ``elicitation/create`` form request."""
    data: dict[str, Any] = {
        "interaction_id": str(interaction_id),
        "method": "elicitation/create",
        "message": str(message),
        "requested_schema": _json_value(requested_schema),
    }
    if session_id:
        data["session_id"] = str(session_id)
    if tool_call_id:
        data["tool_call_id"] = str(tool_call_id)
    return InternalEvent(type="interaction_request", data=data)


def claude_ask_user_request(
    tool_use_id: str,
    tool_input: Mapping[str, Any],
) -> InternalEvent:
    """Translate Claude Code's AskUserQuestion input to ACP elicitation."""
    questions = tool_input.get("questions")
    if not isinstance(questions, list) or not questions:
        questions = [{
            "header": tool_input.get("header") or "问题",
            "question": tool_input.get("question") or "请提供补充信息",
            "options": tool_input.get("options") or [],
            "multiSelect": bool(tool_input.get("multiSelect")),
        }]

    properties: dict[str, Any] = {}
    required: list[str] = []
    for index, raw_question in enumerate(questions):
        question = raw_question if isinstance(raw_question, Mapping) else {}
        field_id = f"question_{index}"
        title = str(question.get("header") or f"问题 {index + 1}")
        description = str(question.get("question") or title)
        raw_options = question.get("options")
        options = raw_options if isinstance(raw_options, list) else []
        choices = []
        for option in options:
            if isinstance(option, Mapping):
                label = str(option.get("label") or option.get("value") or "")
                if not label:
                    continue
                choice = {"const": label, "title": label}
                if option.get("description"):
                    choice["description"] = str(option["description"])
                choices.append(choice)
            elif str(option):
                choices.append({"const": str(option), "title": str(option)})

        if bool(question.get("multiSelect")):
            field: dict[str, Any] = {
                "type": "array",
                "title": title,
                "description": description,
                "items": {"oneOf": choices},
                "_meta": {"allowInput": True},
            }
        else:
            field = {
                "type": "string",
                "title": title,
                "description": description,
                "_meta": {"allowInput": True},
            }
            if choices:
                field["oneOf"] = choices
        properties[field_id] = field
        required.append(field_id)

    return elicitation_request(
        interaction_id=tool_use_id,
        tool_call_id=tool_use_id,
        message=str(tool_input.get("message") or "需要你确认以下信息"),
        requested_schema={
            "type": "object",
            "properties": properties,
            "required": required,
        },
    )


def interaction_from_tool_use(
    tool_use_id: str,
    name: str,
    tool_input: Mapping[str, Any] | None,
) -> InternalEvent | None:
    """Recognize native ask-user tool aliases used by non-ACP engines."""
    normalized = "".join(character for character in name.lower() if character.isalnum())
    if normalized not in {
        "askuser",
        "askuserquestion",
        "requestuserinput",
        "userinput",
    }:
        return None
    return claude_ask_user_request(tool_use_id, tool_input or {})
