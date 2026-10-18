"""Validate assistant overrides against generic or engine-advertised values.

Call from a worker: registry initialization and stored catalog reads can block.
"""
from engines.core.schema import ASSISTANT_THINKING_EFFORTS


def is_supported_effort(value: str, engine_id: str = "", model: str = "",
                        assistant_name: str = "") -> bool:
    if not value or value in ASSISTANT_THINKING_EFFORTS:
        return True
    from services.config import config_store
    from engines.core.registry import _ALL_ENGINES

    if not engine_id:
        defaults = config_store.get_assistant_defaults(assistant_name) if assistant_name else {}
        engine_id = defaults.get("engine") or config_store.get_execution_default_engine()
        model = model or defaults.get("model") or ""
    target = _ALL_ENGINES.get(engine_id)
    if target:
        for field in target.config_schema():
            if field.model_capability or field.key in {"thinking_effort", "model_reasoning_effort", "reasoning_effort"}:
                if any(option.value == value for option in field.options or ()):
                    return True
    selected_model = model or config_store.get_engine_default_model(engine_id)
    for item in config_store.get_engine_models(engine_id).get("models", []):
        if (item.get("id") == selected_model if selected_model else item.get("is_default")):
            return value in (item.get("supported_reasoning_efforts") or [])
    return False
