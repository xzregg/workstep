"""pydantic_ai configuration rules and legacy storage compatibility."""

import os
from typing import Any

SANDBOX_MODES = {"read-only", "workspace-write", "danger-full-access"}

def get_pydantic_ai_engine_config(store) -> dict[str, Any]:
    raw = store.get("pydantic_ai_engine", {})
    if not isinstance(raw, dict):
        raw = {}
    sandbox = str(raw.get("sandbox") or "workspace-write")
    if sandbox not in SANDBOX_MODES:
        sandbox = "workspace-write"
    return {
        "provider_id": raw.get("provider_id")
        or os.environ.get("PYDANTIC_AI_PROVIDER_ID", ""),
        "model": raw.get("model")
        or store.get_engine_default_model("pydantic_ai")
        or os.environ.get("PYDANTIC_AI_MODEL", ""),
        "fast_model": str(raw.get("fast_model") or "")
        or store.get_coordinator_default_fast_model(),
        "mcp_servers": raw.get("mcp_servers") or [],
        "harness": raw.get("harness") or "auto",
        "sandbox": sandbox,
    }


def set_pydantic_ai_engine_config(
    store,
    *,
    provider_id: str,
    model: str,
    mcp_servers: list | None = None,
    harness: str = "auto",
    sandbox: str = "",
    fast_model: str = "",
) -> None:
    sandbox = str(sandbox or "").strip() or "workspace-write"
    if sandbox not in SANDBOX_MODES:
        sandbox = "workspace-write"
    store.set(
        "pydantic_ai_engine",
        {
            "provider_id": provider_id,
            "model": model,
            "fast_model": str(fast_model or ""),
            "mcp_servers": list(mcp_servers or []),
            "harness": harness,
            "sandbox": sandbox,
        },
    )
    store.set_engine_default_model("pydantic_ai", model)
