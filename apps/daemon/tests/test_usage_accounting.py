"""Token usage and pricing shared by statistics and execution reports."""

import json

import pytest

from services.usage_accounting import parse_usage, usage_cost


def test_usage_parser_normalizes_provider_cost_and_rejects_context_window_usage():
    assert parse_usage(json.dumps({
        "input_tokens": 12,
        "output_tokens": 3,
        "cache_read_input_tokens": 4,
        "provider_id": " provider-a ",
        "cost": {"amount": 0.25, "currency": "usd"},
    }), "claude") == {
        "input_tokens": 12,
        "output_tokens": 3,
        "cache_read_tokens": 4,
        "cache_write_tokens": 0,
        "cache_input_included": False,
        "total_tokens": 15,
        "provider_id": "provider-a",
        "provider_cost": {"amount": 0.25, "currency": "USD"},
    }
    assert parse_usage('{"usage_kind":"context_window","input_tokens":12}') is None


def test_model_cost_prefers_the_matching_execution_engine_for_same_named_models():
    usage = {
        "input_tokens": 1_000_000,
        "output_tokens": 0,
        "cache_read_tokens": 0,
        "cache_write_tokens": 0,
    }
    pricing = {
        "currency": "USD",
        "usd_to_cny_rate": 7.2,
        "prices": [
            {
                "provider_id": None,
                "engine_id": "codex",
                "model": "shared",
                "input_price": 1,
                "output_price": 0,
                "cache_price": 0,
            },
            {
                "provider_id": None,
                "engine_id": "claude",
                "model": "shared",
                "input_price": 2,
                "output_price": 0,
                "cache_price": 0,
            },
        ],
    }

    assert usage_cost(usage, "shared", pricing, engine="claude") == 2


def test_model_cost_does_not_double_count_cached_codex_input_tokens():
    usage = {
        "input_tokens": 1_000_000,
        "output_tokens": 0,
        "cache_read_tokens": 900_000,
        "cache_write_tokens": 0,
    }
    pricing = {
        "currency": "USD",
        "usd_to_cny_rate": 7.2,
        "prices": [{
            "provider_id": None,
            "engine_id": "codex",
            "model": "gpt-5",
            "input_price": 1,
            "output_price": 0,
            "cache_price": 0.1,
        }],
    }

    assert usage_cost(usage, "gpt-5", pricing, engine="codex") == pytest.approx(0.19)
