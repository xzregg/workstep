"""WorkStep's backend fallback for configured tool consent (never user answers)."""


def mode_decision(mode: str | None) -> bool | None:
    if mode in {"auto", "bypassPermissions", "allow", "workspace-write", "danger-full-access"}:
        return True
    if mode in {"deny", "deny_all", "read-only"}:
        return False
    return None


def engine_decision(engine_id: str, config: dict) -> bool | None:
    if engine_id == "codex_sdk":
        mode = config.get("approval_mode", "")
        if mode in {"", "auto_review"}:
            return True
        return False if mode == "deny_all" else None
    if engine_id == "codex":
        return True if config.get("approval_policy") in {"full-auto", "never"} else None
    if engine_id in {"claude", "claude_agent_sdk", "qoder_sdk", "opencode"}:
        return mode_decision(config.get("permission_mode"))
    return None


def automatic_response(data: dict, decision: bool | None) -> dict | None:
    if decision is None:
        return None
    if data.get("method") == "session/request_permission":
        kinds = ("allow_once", "allow_always") if decision else ("reject_once", "reject_always")
        options = data.get("options") or []
        for kind in kinds:
            for option in options:
                if option.get("kind") == kind and option.get("option_id"):
                    return {"outcome": {"outcome": "selected", "option_id": option["option_id"]}}
        return {"outcome": {"outcome": "cancelled"}}
    if data.get("method") != "elicitation/create" or data.get("mode", "form") != "form":
        return None
    schema = data.get("requested_schema")
    # Only plain empty forms are confirmation-only. Never invent field values,
    # answer account/login questions, or interpret unfamiliar schema constraints.
    if (
        isinstance(schema, dict)
        and schema.get("type") == "object"
        and schema.get("properties") == {}
        and schema.get("required", []) == []
        and schema.keys() <= {
            "type", "properties", "required", "title", "description",
            "additionalProperties", "$schema",
        }
    ):
        return {"action": "accept" if decision else "decline", "content": {} if decision else None}
    return None
