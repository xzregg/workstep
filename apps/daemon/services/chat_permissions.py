"""Engine-bound native permission selections and legacy five-mode readers.

Empty selections inherit saved engine settings. Adapters own allowed fields,
values, defaults and approval behavior; the shared layer validates the envelope.
"""

from engines.core.permissions import CHAT_PERMISSION_MODES
from engines.core.permissions import decode_permission_selection


def is_valid_permission_mode(mode: str) -> bool:
    if mode in CHAT_PERMISSION_MODES:
        return True
    try:
        return decode_permission_selection(mode) is not None
    except ValueError:
        return False


def validate_permission_selection(engine_id: str, mode: str) -> None:
    """Validate versioned native selections before persistence; legacy values keep their reader."""
    if decode_permission_selection(mode or "") is None:
        return
    from engines.core.registry import list_all_engines
    engine = list_all_engines().get(engine_id)
    if engine is None:
        raise ValueError("权限配置对应的引擎不可用")
    engine.permission_config_overrides(mode)


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
