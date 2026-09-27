"""The provider catalog and cc-switch importer have independent owners."""

import json
import asyncio
import subprocess
import sys
import threading
import time

import pytest
from httpx import ASGITransport, AsyncClient

from services.provider_catalog import normalize_provider_protocols
from services.provider_cc_switch import cc_switch_candidate


def test_catalog_import_does_not_interrupt_engine_discovery():
    subprocess.run(
        [
            sys.executable,
            "-c",
            "import services.provider_catalog; "
            "from engines.core.registry import _ALL_ENGINES; "
            "assert {'claude', 'codex', 'pydantic_ai'} <= _ALL_ENGINES.keys()",
        ],
        check=True,
        capture_output=True,
        text=True,
    )


def test_catalog_preserves_order_and_aliases():
    assert normalize_provider_protocols(
        ["responses", "messages", "responses"], "custom"
    ) == ["openai_responses", "anthropic_messages"]


def test_cc_switch_candidate_keeps_protocol_and_model_in_one_import_unit():
    candidate = cc_switch_candidate({
        "id": "example",
        "name": "Example",
        "app_type": "codex",
        "settings_config": json.dumps({
            "auth": {"OPENAI_API_KEY": "test-key"},
            "config": (
                'model = "test-model"\n'
                '[model_providers.example]\n'
                'base_url = "https://example.com/v1"\n'
                'wire_api = "responses"\n'
            ),
        }),
    })
    assert candidate is not None
    assert candidate["protocol"] == "openai_responses"
    assert candidate["model_ids"] == ["test-model"]


@pytest.mark.anyio
async def test_slow_cc_switch_scan_does_not_block_health_check(monkeypatch):
    import api.provider as provider_api
    import main

    started = threading.Event()
    release = threading.Event()

    def slow_scan():
        started.set()
        release.wait(timeout=1)
        return []

    monkeypatch.setattr(provider_api.provider_service, "scan_cc_switch_providers", slow_scan)
    async with AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test") as client:
        started_at = time.perf_counter()
        request = asyncio.create_task(client.get("/api/provider/import/sources"))
        try:
            assert await asyncio.to_thread(started.wait, 1)
            assert not request.done()
            assert time.perf_counter() - started_at < 0.5
            health = await asyncio.wait_for(client.get("/api/health"), timeout=0.2)
            assert health.status_code == 200
        finally:
            release.set()
            response = await request
        assert response.status_code == 200
