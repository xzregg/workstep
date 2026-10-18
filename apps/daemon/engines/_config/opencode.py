"""opencode configuration rules and legacy storage compatibility."""

from typing import Any

OPENCODE_PERMISSION_MODES = {
    "ask",
    "allow",
    "deny",
}


def get_opencode_config(store) -> dict[str, Any]:
    raw = store.get("opencode_engine", {})
    if not isinstance(raw, dict):
        raw = {}
    mode = str(raw.get("permission_mode") or "").strip() or "ask"
    if mode not in OPENCODE_PERMISSION_MODES:
        mode = "ask"
    return {"permission_mode": mode}


def set_opencode_config(store, permission_mode: str = "ask") -> None:
    mode = str(permission_mode or "").strip() or "ask"
    if mode not in OPENCODE_PERMISSION_MODES:
        raise ValueError(f"Unsupported OpenCode permission mode: {mode}")
    raw = store.get("opencode_engine", {})
    raw = dict(raw) if isinstance(raw, dict) else {}
    raw["permission_mode"] = mode
    store.set("opencode_engine", raw)
