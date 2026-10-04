"""Shared token-usage parsing and pricing for reports and statistics."""

from __future__ import annotations

import json
from typing import Any


def parse_usage(raw: str | None, engine: str | None = None) -> dict[str, Any] | None:
    if not raw:
        return None
    try:
        value = json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        return None
    if not isinstance(value, dict) or value.get("usage_kind") == "context_window":
        return None

    def number(*keys: str) -> int:
        for key in keys:
            candidate = value.get(key)
            if isinstance(candidate, (int, float)) and not isinstance(candidate, bool):
                return max(0, int(candidate))
        return 0

    input_tokens = number("input_tokens", "prompt_tokens")
    output_tokens = number("output_tokens", "completion_tokens")
    total_tokens = number("total_tokens", "tokens") or input_tokens + output_tokens
    if not any((input_tokens, output_tokens, total_tokens)):
        return None
    cache_input_included = value.get("cache_input_included")
    result: dict[str, Any] = {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cache_read_tokens": number("cache_read_input_tokens", "cached_tokens"),
        "cache_write_tokens": number("cache_creation_input_tokens"),
        "cache_input_included": (
            cache_input_included
            if isinstance(cache_input_included, bool)
            else engine not in {"claude", "claude_agent_sdk"}
        ),
        "total_tokens": total_tokens,
    }
    provider_id = value.get("provider_id")
    if isinstance(provider_id, str) and provider_id.strip():
        result["provider_id"] = provider_id.strip()
    cost = value.get("cost")
    if isinstance(cost, dict):
        amount = cost.get("amount")
        currency = cost.get("currency")
        if isinstance(amount, (int, float)) and not isinstance(amount, bool):
            result["provider_cost"] = {
                "amount": max(0, float(amount)),
                "currency": str(currency or "USD").upper(),
            }
    return result


def usage_cost(
    usage: dict[str, Any],
    model: str,
    pricing: dict[str, Any],
    *,
    engine: str = "",
) -> float:
    target_currency = pricing["currency"]
    rate = pricing["usd_to_cny_rate"]
    provider_cost = usage.get("provider_cost")
    if isinstance(provider_cost, dict):
        amount = provider_cost["amount"]
        source_currency = provider_cost["currency"]
        if source_currency == target_currency:
            return amount
        if source_currency == "USD" and target_currency == "CNY":
            return amount * rate
        if source_currency == "CNY" and target_currency == "USD":
            return amount / rate

    provider_id = usage.get("provider_id")
    prices = pricing.get("prices", [])
    price = (
        next(
            (
                item for item in prices
                if item.get("model") == model
                and item.get("provider_id") == provider_id
            ),
            None,
        )
        if provider_id
        else None
    )
    if price is None:
        price = next(
            (
                item for item in prices
                if item.get("model") == model and item.get("engine_id") == engine
            ),
            None,
        )
    if price is None:
        price = next(
            (
                item for item in prices
                if item.get("model") == model
                and not item.get("provider_id")
                and not item.get("engine_id")
            ),
            None,
        )
    if price is None:
        return 0

    cache_tokens = usage["cache_read_tokens"] + usage["cache_write_tokens"]
    if usage.get("cache_input_included") is False:
        uncached_input_tokens = usage["input_tokens"]
    else:
        uncached_input_tokens = max(
            0,
            usage["input_tokens"] - usage["cache_read_tokens"] - usage["cache_write_tokens"],
        )
    return (
        uncached_input_tokens * float(price["input_price"])
        + usage["output_tokens"] * float(price["output_price"])
        + cache_tokens * float(price["cache_price"])
    ) / 1_000_000
