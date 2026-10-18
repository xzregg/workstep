"""qoder configuration rules and legacy storage compatibility."""

import os
from typing import Any

QODER_PERMISSION_MODES = {
    "default",
    "acceptEdits",
    "bypassPermissions",
    "plan",
    "dontAsk",
    "auto",
}


def get_qoder_sdk_config(store) -> dict[str, Any]:
    raw = store.get("qoder_sdk_engine", {})
    if not isinstance(raw, dict):
        raw = {}
    return {
        "personal_access_token": raw.get("personal_access_token")
        or os.environ.get("QODER_PERSONAL_ACCESS_TOKEN", ""),
        "permission_mode": raw.get("permission_mode") or "default",
        "model": raw.get("model")
        or store.get_engine_default_model("qoder_sdk")
        or "",
        "allowed_tools": str(raw.get("allowed_tools") or ""),
        "max_turns": str(raw.get("max_turns") or ""),
        "include_partial_messages": raw.get("include_partial_messages", True),
    }


def set_qoder_sdk_config(
    store,
    *,
    personal_access_token: str | None = None,
    permission_mode: str = "default",
    model: str = "",
    allowed_tools: str = "",
    max_turns: str = "",
    include_partial_messages: bool = True,
) -> None:
    raw = store.get("qoder_sdk_engine", {})
    if not isinstance(raw, dict):
        raw = {}
    raw = dict(raw)
    if personal_access_token is not None:
        token = str(personal_access_token).strip()
        if token:
            raw["personal_access_token"] = token
        else:
            raw.pop("personal_access_token", None)
    permission_mode = str(permission_mode or "").strip() or "default"
    if permission_mode not in QODER_PERMISSION_MODES:
        raise ValueError(f"Unsupported Qoder permission mode: {permission_mode}")
    raw["permission_mode"] = permission_mode
    model = str(model or "").strip()
    if model:
        raw["model"] = model
    else:
        raw.pop("model", None)
    allowed_tools = str(allowed_tools or "").strip()
    if allowed_tools:
        raw["allowed_tools"] = allowed_tools
    else:
        raw.pop("allowed_tools", None)
    max_turns = str(max_turns or "").strip()
    if max_turns:
        try:
            value = int(max_turns)
        except ValueError:
            raise ValueError("最大轮数必须是正整数")
        if value <= 0:
            raise ValueError("最大轮数必须是正整数")
        raw["max_turns"] = value
    else:
        raw.pop("max_turns", None)
    raw["include_partial_messages"] = bool(include_partial_messages)
    store.set("qoder_sdk_engine", raw)
