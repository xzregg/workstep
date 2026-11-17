"""Unified permission modes for the session chat composer.

The chat input exposes one permission selector with cross-engine meanings:

- ``""`` — follow the global engine config (no override).
- ``read-only`` — model cannot modify the workspace.
- ``workspace-write`` — model can modify the workspace.
- ``danger-full-access`` — model can run anything (full access).
- ``auto`` — auto-approve tool/interaction requests.
- ``ask`` — require user approval for tool/interaction requests.

Native config translation belongs to each adapter's PERMISSION_POLICY,
not a central engine-id dispatch table.
"""

from engines.core.permissions import CHAT_PERMISSION_MODES


def is_valid_permission_mode(mode: str) -> bool:
    return mode in CHAT_PERMISSION_MODES


# ── Plan mode (Codex-style lightbulb) ──────────────────────────────────

PLAN_MODE_INSTRUCTION = (
    "Plan mode: research, analyze, and plan only. Do not modify, create, or delete "
    "files and do not perform write operations. Output a clear implementation plan "
    "and wait for user confirmation."
)

GOAL_MODE_INSTRUCTION = (
    "Goal mode: keep working toward the objective below until it is complete. "
    "Break it into steps, execute them one by one with the tools available to you, "
    "and report progress. If you are blocked and cannot proceed, state exactly "
    "what you need. Do not stop with a partial result while executable steps remain."
)


def parse_goal_command(prompt: str) -> tuple[str, str] | None:
    """Parse WorkStep's engine-independent goal command."""
    command, _, argument = prompt.strip().partition(" ")
    if command != "/goal":
        return None
    argument = argument.strip()
    if argument in {"pause", "resume", "clear", "status"}:
        return argument, ""
    if not argument:
        return "status", ""
    return "start", argument
