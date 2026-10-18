"""deepseek_harness configuration rules and legacy storage compatibility."""

from typing import Any

def get_deepseek_harness_config(store) -> dict[str, Any]:
    """Return the official DeepSeek Harness SDK adapter configuration."""
    raw = store.get("deepseek_harness_engine", {})
    if not isinstance(raw, dict):
        raw = {}
    preset = str(raw.get("preset") or "standard")
    return {
        "provider_id": str(raw.get("provider_id") or ""),
        "model": str(
            raw.get("model")
            or store.get_engine_default_model("deepseek_harness")
            or "deepseek-v4-flash"
        ),
        "max_tokens": str(raw.get("max_tokens") or ""),
        "preset": preset if preset == "standard" else "standard",
    }


def set_deepseek_harness_config(
    store,
    *,
    provider_id: str,
    model: str,
    max_tokens: str = "",
    preset: str = "standard",
) -> None:
    store.set(
        "deepseek_harness_engine",
        {
            "provider_id": str(provider_id or "").strip(),
            "model": str(model or "").strip() or "deepseek-v4-flash",
            "max_tokens": str(max_tokens or "").strip(),
            "preset": str(preset or "").strip() or "standard",
        },
    )
    store.set_engine_default_model(
        "deepseek_harness",
        str(model or "").strip() or "deepseek-v4-flash",
    )
