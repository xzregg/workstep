"""Normalize one completed model call into a stable managed usage event."""

from datetime import datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from uuid import NAMESPACE_URL, uuid5

from services.usage_accounting import parse_usage


PRICE_FIELDS = ("input_per_million", "output_per_million",
                "cache_read_per_million", "cache_write_per_million")


def _price_snapshot(provider: dict | None, model: str) -> tuple[str | None, dict[str, str] | None]:
    prices = provider.get("prices") if isinstance(provider, dict) else None
    if not isinstance(prices, dict):
        return None, None
    version = prices.get("version")
    catalog = prices.get("models")
    raw = catalog.get(model) if isinstance(catalog, dict) else None
    if not isinstance(raw, dict):
        return str(version) if version else None, None
    snapshot = {}
    try:
        for field in PRICE_FIELDS:
            value = raw.get(field, "0")
            amount = Decimal(str(value))
            if not amount.is_finite() or amount < 0:
                return str(version) if version else None, None
            snapshot[field] = str(amount)
    except (InvalidOperation, ValueError):
        return str(version) if version else None, None
    return str(version) if version else None, snapshot


def build_usage_event(*, gateway_id: str, device_id: str,
                      user_id: str | None, project_id: str | None,
                      task_id: str | None, message_id: str,
                      run_id: str | None, model: str | None,
                      occurred_at: datetime, provider: dict | None,
                      usage_json: str | None,
                      provider_id: str | None = None,
                      initiated_by_user_id: str | None = None,
                      session_id: str | None = None) -> dict:
    if not message_id or not device_id or not gateway_id or occurred_at.tzinfo is None:
        raise ValueError("Incomplete managed usage identity")
    usage_id = uuid5(
        NAMESPACE_URL,
        f"workstep-usage-v1:{gateway_id}:{device_id}:{project_id}:{message_id}:{run_id}",
    ).hex
    event = {"usage_event_id": usage_id,
             "request_id": message_id, "device_id": device_id,
             "user_id": user_id, "initiated_by_user_id": initiated_by_user_id or user_id,
             "project_id": project_id, "task_id": task_id, "run_id": run_id,
             "message_id": message_id, "session_id": session_id,
             "provider_id": (provider.get("id") if isinstance(provider, dict)
                             else provider_id),
             "provider_revision": (provider.get("managed_revision")
                                   if isinstance(provider, dict) else None),
             "model": model, "occurred_at": occurred_at.isoformat()}
    usage = parse_usage(usage_json)
    if usage is None:
        return {**event, "metering_status": "unmetered", "estimated_cost": None}
    event.update({"metering_status": "metered",
                  "input_tokens": usage["input_tokens"],
                  "output_tokens": usage["output_tokens"],
                  "cache_read_tokens": usage["cache_read_tokens"],
                  "cache_write_tokens": usage["cache_write_tokens"],
                  "total_tokens": usage["total_tokens"]})
    version, prices = _price_snapshot(provider, model or "")
    event["pricing_version"] = version
    if prices is None:
        reported = usage.get("provider_cost")
        if isinstance(reported, dict):
            amount = Decimal(str(reported["amount"]))
            event["currency"] = reported["currency"]
            event["estimated_cost"] = str(amount.quantize(
                Decimal("0.000001"), rounding=ROUND_HALF_UP,
            ))
        else:
            event["estimated_cost"] = None
        return event
    cache_read = usage["cache_read_tokens"]
    cache_write = usage["cache_write_tokens"]
    uncached = usage["input_tokens"]
    if usage["cache_input_included"]:
        uncached = max(0, uncached - cache_read - cache_write)
    cost = (
        Decimal(uncached) * Decimal(prices["input_per_million"])
        + Decimal(usage["output_tokens"]) * Decimal(prices["output_per_million"])
        + Decimal(cache_read) * Decimal(prices["cache_read_per_million"])
        + Decimal(cache_write) * Decimal(prices["cache_write_per_million"])
    ) / Decimal(1_000_000)
    event["unit_price_snapshot"] = prices
    event["currency"] = "USD"
    event["estimated_cost"] = str(cost.quantize(Decimal("0.000001"),
                                                 rounding=ROUND_HALF_UP))
    return event
