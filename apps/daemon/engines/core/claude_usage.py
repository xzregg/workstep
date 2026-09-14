"""Claude-specific context-window usage normalization."""

from typing import Any, Mapping

from engines.core.events import normalize_token_usage


CLAUDE_DEFAULT_CONTEXT_WINDOW = 256_000


def claude_context_snapshot(usage: Mapping[str, Any]) -> tuple[int, int]:
    """Return one Claude API request's context occupancy and display window.

    Claude result-level usage is cumulative for the session and must never be
    passed here. Assistant-message usage describes one API request, so cached
    input and that response's output are part of the active request context.
    """
    normalized = normalize_token_usage(usage)
    used = sum(
        int(normalized[key])
        for key in (
            "input_tokens",
            "cache_creation_input_tokens",
            "cache_read_input_tokens",
            "output_tokens",
        )
    )
    for key in (
        "size",
        "context_window",
        "model_context_window",
        "contextWindow",
        "modelContextWindow",
    ):
        value = usage.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0:
            return used, int(value)
    return used, CLAUDE_DEFAULT_CONTEXT_WINDOW
