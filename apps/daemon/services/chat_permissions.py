"""Unified permission modes for the session chat composer.

The chat input exposes one permission selector with cross-engine meanings:

- ``""`` — follow the global engine config (no override).
- ``read-only`` — model cannot modify the workspace.
- ``workspace-write`` — model can modify the workspace.
- ``danger-full-access`` — model can run anything (full access).
- ``auto`` — auto-approve tool/interaction requests.
- ``ask`` — require user approval for tool/interaction requests.

``map_permission_overrides(engine_id, mode)`` translates the unified mode
into the engine's own ``config_overrides`` keys. Engines that cannot express
a mode (e.g. ACP always asks) simply get an empty override and keep their
global/engine default.
"""

CHAT_PERMISSION_MODES = (
    "read-only",
    "workspace-write",
    "danger-full-access",
    "auto",
    "ask",
)

_SANDBOX_MODES = {"read-only", "workspace-write", "danger-full-access"}

_CLAUDE_PERMISSION = {
    "read-only": "plan",
    "workspace-write": "acceptEdits",
    "danger-full-access": "bypassPermissions",
    "auto": "auto",
    "ask": "manual",
}

_QODER_PERMISSION = {
    "read-only": "plan",
    "workspace-write": "acceptEdits",
    "danger-full-access": "bypassPermissions",
    "auto": "auto",
    "ask": "default",
}


def is_valid_permission_mode(mode: str) -> bool:
    return mode in CHAT_PERMISSION_MODES


def map_permission_overrides(engine_id: str, mode: str) -> dict:
    """Return engine-specific ``config_overrides`` for a unified mode."""
    if not mode:
        return {}
    if engine_id == "codex":
        if mode in _SANDBOX_MODES:
            return {"sandbox_mode": mode}
        return {"approval_policy": "full-auto" if mode == "auto" else "on-request"}
    if engine_id == "codex_sdk":
        if mode in _SANDBOX_MODES:
            return {"sandbox": mode}
        return {"approval_mode": "auto_review"} if mode == "auto" else {}
    if engine_id in ("claude", "claude_agent_sdk"):
        return {"permission_mode": _CLAUDE_PERMISSION[mode]}
    if engine_id == "qoder_sdk":
        return {"permission_mode": _QODER_PERMISSION[mode]}
    if engine_id == "pydantic_ai":
        if mode in _SANDBOX_MODES:
            return {"sandbox": mode}
        return {}
    # hermes / openclaw: no unified permission override.
    return {}


# ── Plan mode (Codex-style lightbulb) ──────────────────────────────────

PLAN_MODE_INSTRUCTION = (
    "Plan mode: research, analyze, and plan only. Do not modify, create, or delete "
    "files and do not perform write operations. Output a clear implementation plan "
    "and wait for user confirmation."
)


def map_plan_mode_overrides(engine_id: str) -> dict:
    """Engine-specific ``config_overrides`` for Codex-style plan mode.

    Engines without a native "plan-only" mode return an empty dict; the
    prompt-level instruction still applies to every engine.
    """
    if engine_id == "codex":
        return {"sandbox_mode": "read-only"}
    if engine_id == "codex_sdk":
        return {"sandbox": "read-only"}
    if engine_id in ("claude", "claude_agent_sdk", "qoder_sdk"):
        return {"permission_mode": "plan"}
    if engine_id == "pydantic_ai":
        return {"sandbox": "read-only"}
    return {}
