"""Claude-specific context-window usage normalization."""

from typing import Any, Mapping

from engines.core.events import normalize_token_usage


CLAUDE_DEFAULT_CONTEXT_WINDOW = 256_000


def normalize_claude_usage(usage: Mapping[str, Any]) -> dict[str, Any]:
    """Normalize Claude's exclusive input-token counts to WorkStep's schema."""
    normalized = normalize_token_usage(usage)
    cache_read = int(normalized["cache_read_input_tokens"])
    cache_write = int(normalized["cache_creation_input_tokens"])
    if "cache_input_included" not in usage and (cache_read or cache_write):
        normalized["cache_input_included"] = False
        if "total_tokens" not in usage:
            normalized["total_tokens"] = (
                int(normalized["input_tokens"])
                + cache_read
                + cache_write
                + int(normalized["output_tokens"])
            )
    return normalized


def claude_context_snapshot(usage: Mapping[str, Any]) -> tuple[int, int]:
    """Return one Claude API request's context occupancy and display window.

    Claude result-level usage is cumulative for the session and must never be
    passed here. Assistant-message usage describes one API request, so cached
    input and that response's output are part of the active request context.
    """
    normalized = normalize_claude_usage(usage)
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
