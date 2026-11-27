"""Tests for unified multi-engine quota query, 5-minute cache, concurrency, and scope isolation."""
import asyncio
import base64
import json
import threading
import time

import pytest
from httpx import ASGITransport, AsyncClient

from services.gateway_client.bridge import ManagedHttpBridge
from tests.test_api_contracts import api_context
from workstep_gateway_protocol import FrameType, ProxyFrame


@pytest.mark.asyncio
async def test_unified_quota_keeps_last_success_only_for_transient_failures_in_current_scope():
    from services.engine_quota import UnifiedQuotaService

    clock = [1000.0]
    service = UnifiedQuotaService(clock=lambda: clock[0], wall_clock=lambda: clock[0])
    scope = ("host", "alice")
    good = {"engine_id": "codex", "status": "ok", "quota": {"collected_at": 990, "remaining_percent": 75}}
    failed = {"engine_id": "codex", "status": "unavailable", "reason": "timeout", "quota": None}
    other = {"engine_id": "other", "status": "ok", "quota": {"remaining_percent": 80}}
    targets = [good, other]

    async def collect():
        return targets

    await service.get(scope, collect)
    clock[0] += 300
    targets = [failed, other]
    fallback = {**failed, "quota": good["quota"]}
    expired = await service.get(scope, collect)
    assert expired["engines"] == [fallback, other]
    assert expired["collected_at"] == 1300
    assert (await service.get(scope, collect))["cached"] is True
    assert (await service.get(scope, collect, refresh=True))["engines"] == [fallback, other]
    assert (await service.get(("host", "bob"), collect))["engines"] == [failed, other]

    targets = [{**failed, "status": "unauthenticated"}]
    assert (await service.get(scope, collect, refresh=True))["engines"] == targets
    targets = [failed]
    assert (await service.get(scope, collect, refresh=True))["engines"] == targets
    targets = [good]
    assert (await service.get(scope, collect, refresh=True))["engines"] == targets
    targets = [failed]
    service.invalidate(scope)
    assert (await service.get(scope, collect, refresh=True))["engines"] == targets


@pytest.mark.asyncio
async def test_unified_quota_service_caches_5_minutes_refreshes_and_deduplicates():
    from services.engine_quota import UnifiedQuotaService

    now_mono = [1000.0]
    now_wall = [1700000000.0]
    service = UnifiedQuotaService(
        ttl_seconds=300.0,
        clock=lambda: now_mono[0],
        wall_clock=lambda: now_wall[0],
    )
    calls = 0

    async def collect():
        nonlocal calls
        calls += 1
        return [{"engine_id": "codex_sdk", "supported": True, "status": "ok", "quota": {"engine_id": "codex_sdk", "primary": {"remaining_percent": 90 - calls}}}]

    scope = ("host", "", "", "proj-1")

    # First query hits upstream
    first = await service.get(scope, collect, refresh=False)
    assert calls == 1
    assert first["cached"] is False
    assert first["engines"][0]["quota"]["primary"]["remaining_percent"] == 89
    assert first["collected_at"] == 1700000000.0
    assert first["expires_at"] == 1700000300.0

    # Within 5 minutes -> hits cache, no upstream call
    now_mono[0] += 299.0
    now_wall[0] += 299.0
    second = await service.get(scope, collect, refresh=False)
    assert calls == 1
    assert second["cached"] is True
    assert second["engines"][0]["quota"]["primary"]["remaining_percent"] == 89

    # At 5 minutes -> expires and queries upstream
    now_mono[0] += 1.0
    now_wall[0] += 1.0
    third = await service.get(scope, collect, refresh=False)
    assert calls == 2
    assert third["cached"] is False
    assert third["engines"][0]["quota"]["primary"]["remaining_percent"] == 88
    assert third["expires_at"] == now_wall[0] + 300.0

    # Manual refresh within 5 minutes -> bypasses cache, updates cache, resets TTL
    now_mono[0] += 100.0
    now_wall[0] += 100.0
    refreshed = await service.get(scope, collect, refresh=True)
    assert calls == 3
    assert refreshed["cached"] is False
    assert refreshed["engines"][0]["quota"]["primary"]["remaining_percent"] == 87

    # Subsequent normal query 250s after refresh (350s after third) still hits refreshed cache
    now_mono[0] += 250.0
    now_wall[0] += 250.0
    after_refresh = await service.get(scope, collect, refresh=False)
    assert calls == 3
    assert after_refresh["cached"] is True
    assert after_refresh["engines"][0]["quota"]["primary"]["remaining_percent"] == 87

    # Expire refreshed cache at +50s (total +300s from refresh)
    now_mono[0] += 50.0
    now_wall[0] += 50.0
    expired_again = await service.get(scope, collect, refresh=False)
    assert calls == 4
    assert expired_again["cached"] is False
    assert expired_again["engines"][0]["quota"]["primary"]["remaining_percent"] == 86


@pytest.mark.asyncio
async def test_unified_quota_service_coalesces_concurrent_queries_and_preserves_newer_refresh():
    from services.engine_quota import UnifiedQuotaService

    now_mono = [1000.0]
    service = UnifiedQuotaService(ttl_seconds=300.0, clock=lambda: now_mono[0])
    started = asyncio.Event()
    release = asyncio.Event()
    calls = 0

    async def slow_collect():
        nonlocal calls
        calls += 1
        started.set()
        await release.wait()
        return [{"engine_id": "antigravity", "supported": True, "status": "ok", "quota": {"engine_id": "antigravity", "primary": {"remaining_percent": 70}}}]

    scope = ("host", "", "", "proj-concurrent")
    tasks = [asyncio.create_task(service.get(scope, slow_collect, refresh=False)) for _ in range(8)]
    await asyncio.wait_for(started.wait(), 2)

    # Start a manual refresh while slow normal query is still running; refresh finishes first
    async def fast_refresh():
        return [{"engine_id": "antigravity", "supported": True, "status": "ok", "quota": {"engine_id": "antigravity", "primary": {"remaining_percent": 95}}}]

    refreshed = await service.get(scope, fast_refresh, refresh=True)
    assert refreshed["engines"][0]["quota"]["primary"]["remaining_percent"] == 95

    release.set()
    results = await asyncio.gather(*tasks)
    assert calls == 1
    assert all(item == refreshed for item in results)

    # Subsequent cached read must keep the newer refresh result (95), not the stale slow fetch (70)
    cached = await service.get(scope, slow_collect, refresh=False)
    assert calls == 1
    assert cached["cached"] is True
    assert cached["engines"][0]["quota"]["primary"]["remaining_percent"] == 95


@pytest.mark.asyncio
@pytest.mark.parametrize(("intervening", "expected_percent"), [
    ("first_query", 75),
    ("older_fallback", 75),
    ("newer_success", 95),
    ("unauthenticated", None),
    ("unauthenticated_under_pressure", None),
    ("late_unauthenticated", None),
    ("removed", None),
    ("current_unauthenticated", None),
    ("current_removed", None),
    ("invalidated", None),
])
async def test_late_success_updates_only_the_eligible_engine_fallback(intervening, expected_percent):
    from services.engine_quota import _MAX_CACHE_ENTRIES, UnifiedQuotaService

    clock = [1000.0]
    service = UnifiedQuotaService(clock=lambda: clock[0], wall_clock=lambda: clock[0])
    scope = ("host", "alice")
    started = asyncio.Event()
    release = asyncio.Event()
    failure = {"engine_id": "codex", "status": "unavailable", "reason": "timeout", "quota": None}
    unauthenticated = {**failure, "status": "unauthenticated"}
    other = {"engine_id": "other", "status": "ok", "quota": {"remaining_percent": 80}}

    def success(percent):
        return {"engine_id": "codex", "status": "ok", "quota": {"remaining_percent": percent}}

    slow_result = unauthenticated if intervening == "late_unauthenticated" else success(75)

    async def slow_collect():
        started.set()
        await release.wait()
        return [slow_result]

    async def refresh(entries):
        async def collect():
            return entries

        return await service.get(scope, collect, refresh=True)

    if intervening in {"older_fallback", "late_unauthenticated"}:
        await refresh([success(20)])
        clock[0] += 300
    pending = asyncio.create_task(service.get(scope, slow_collect))
    try:
        await asyncio.wait_for(started.wait(), 2)
        if intervening == "newer_success":
            await refresh([success(95)])
        elif intervening in {"unauthenticated", "unauthenticated_under_pressure"}:
            await refresh([unauthenticated])
            if intervening == "unauthenticated_under_pressure":
                async def empty_collect():
                    return []

                for index in range(_MAX_CACHE_ENTRIES):
                    await service.get(("host", f"other-{index}"), empty_collect)
        elif intervening == "removed":
            await refresh([])
        elif intervening == "invalidated":
            service.invalidate(scope)

        latest_engines = [failure, other]
        if intervening == "current_unauthenticated":
            latest_engines = [unauthenticated, other]
        elif intervening == "current_removed":
            latest_engines = [other]
        failed = await refresh(latest_engines)
        fallback = {**failure, "quota": success(expected_percent)["quota"] if expected_percent is not None else None}
        expected = [fallback, other] if latest_engines[0] is failure else latest_engines
        clock[0] += 1
        release.set()
        if intervening == "invalidated":
            from services.engine_quota import QuotaInvalidatedError
            result = (await asyncio.gather(pending, return_exceptions=True))[0]
            assert isinstance(result, QuotaInvalidatedError)
        else:
            assert await pending == {**failed, "engines": expected}

        async def unexpected_collect():
            pytest.fail("reopening a session should use the cache")

        cached = await service.get(scope, unexpected_collect)
        assert cached == {**failed, "cached": True, "engines": expected}
        assert (await refresh([failure, other]))["engines"] == [fallback, other]
    finally:
        release.set()
        await asyncio.gather(pending, return_exceptions=True)


@pytest.mark.asyncio
async def test_unified_quota_service_invalidation_prevents_stale_inflight_cache_write():
    from services.engine_quota import UnifiedQuotaService

    now_mono = [2000.0]
    service = UnifiedQuotaService(ttl_seconds=300.0, clock=lambda: now_mono[0])
    started = asyncio.Event()
    release = asyncio.Event()
    calls = 0

    async def stale_collect():
        nonlocal calls
        calls += 1
        started.set()
        await release.wait()
        return [{"engine_id": "codex_sdk", "supported": True, "status": "ok", "quota": {"engine_id": "codex_sdk", "primary": {"remaining_percent": 11}}}]

    async def fresh_collect():
        nonlocal calls
        calls += 1
        return [{"engine_id": "codex_sdk", "supported": True, "status": "ok", "quota": {"engine_id": "codex_sdk", "primary": {"remaining_percent": 99}}}]

    scope = ("host", "", "", "proj-invalidate")
    pending = asyncio.create_task(service.get(scope, stale_collect, refresh=False))
    await asyncio.wait_for(started.wait(), 2)
    service.invalidate()
    release.set()
    from services.engine_quota import QuotaInvalidatedError
    with pytest.raises(QuotaInvalidatedError):
        await pending

    # Next read must NOT see the stale pre-invalidation value from cache
    fresh_result = await service.get(scope, fresh_collect, refresh=False)
    assert calls == 2
    assert fresh_result["cached"] is False
    assert fresh_result["engines"][0]["quota"]["primary"]["remaining_percent"] == 99


@pytest.mark.asyncio
@pytest.mark.parametrize(('old_refresh', 'new_refresh'), [(False, False), (True, False), (True, True)])
@pytest.mark.parametrize('global_invalidation', [False, True])
async def test_unified_quota_invalidation_does_not_join_previous_generation(old_refresh, new_refresh, global_invalidation):
    from services.engine_quota import UnifiedQuotaService

    service = UnifiedQuotaService()
    scope = ('host', 'project')
    started = asyncio.Event()
    release = asyncio.Event()

    async def before_engine_disabled():
        started.set()
        await release.wait()
        return [{'engine_id': 'codex_sdk'}]

    async def after_engine_disabled():
        return []

    stale = asyncio.create_task(service.get(scope, before_engine_disabled, refresh=old_refresh))
    await asyncio.wait_for(started.wait(), 2)
    try:
        service.invalidate(None if global_invalidation else scope)
        fresh = await asyncio.wait_for(service.get(scope, after_engine_disabled, refresh=new_refresh), 1)
        assert fresh['engines'] == []
        assert not fresh['cached']
    finally:
        release.set()
        from services.engine_quota import QuotaInvalidatedError
        with pytest.raises(QuotaInvalidatedError):
            await stale
    cached = await service.get(scope, before_engine_disabled)
    assert cached['cached'] and cached['engines'] == []


@pytest.mark.asyncio
async def test_unified_quota_service_isolates_scopes():
    from services.engine_quota import UnifiedQuotaService

    service = UnifiedQuotaService(ttl_seconds=300.0)
    seen = []

    async def make_collect(label: str):
        seen.append(label)
        return [{"engine_id": "codex_sdk", "supported": True, "status": "ok", "quota": {"engine_id": "codex_sdk", "limit_name": label, "primary": {"remaining_percent": 80}}}]

    host_p1 = ("host", "local", "dev-1", "dev-1", "proj-1")
    host_p2 = ("host", "local", "dev-1", "dev-1", "proj-2")
    proj_user_a = ("project", "managed", "user-a", "dev-1", "proj-1")
    proj_user_b = ("project", "managed", "user-b", "dev-1", "proj-1")

    r1 = await service.get(host_p1, lambda: make_collect("host-p1"))
    r2 = await service.get(host_p2, lambda: make_collect("host-p2"))
    r3 = await service.get(proj_user_a, lambda: make_collect("user-a"))
    r4 = await service.get(proj_user_b, lambda: make_collect("user-b"))

    assert seen == ["host-p1", "host-p2", "user-a", "user-b"]
    assert r1["engines"][0]["quota"]["limit_name"] == "host-p1"
    assert r2["engines"][0]["quota"]["limit_name"] == "host-p2"
    assert r3["engines"][0]["quota"]["limit_name"] == "user-a"
    assert r4["engines"][0]["quota"]["limit_name"] == "user-b"

    # Re-reading same scopes hits respective caches
    r1_cached = await service.get(host_p1, lambda: make_collect("unexpected"))
    r3_cached = await service.get(proj_user_a, lambda: make_collect("unexpected"))
    assert seen == ["host-p1", "host-p2", "user-a", "user-b"]
    assert r1_cached["cached"] is True and r1_cached["engines"][0]["quota"]["limit_name"] == "host-p1"
    assert r3_cached["cached"] is True and r3_cached["engines"][0]["quota"]["limit_name"] == "user-a"


@pytest.mark.anyio
async def test_unified_quota_api_queries_enabled_supported_engines_dynamically_with_fault_isolation(
    monkeypatch, tmp_path,
):
    import main
    from api import engine as engine_api
    from engines.core.quota import QuotaAuthenticationRequired
    from services.engine_quota import UnifiedQuotaService

    now_mono = [5000.0]
    now_wall = [1710000000.0]
    service = UnifiedQuotaService(
        ttl_seconds=300.0,
        clock=lambda: now_mono[0],
        wall_clock=lambda: now_wall[0],
    )
    monkeypatch.setattr("services.engine_quota.unified_quota_service", service)

    calls: dict[str, int] = {}

    class CodexFake:
        ENGINE_ID = "codex_sdk"
        supports_quota = True

        async def get_quota(self, cwd=""):
            calls["codex_sdk"] = calls.get("codex_sdk", 0) + 1
            return {
                "engine_id": "codex_sdk",
                "limit_name": "Codex",
                "primary": {"remaining_percent": 82 - calls["codex_sdk"], "resets_at": 1796181626},
            }

    class AntigravityFake:
        ENGINE_ID = "antigravity"
        supports_quota = True

        async def get_quota(self, cwd=""):
            calls["antigravity"] = calls.get("antigravity", 0) + 1
            return {
                "engine_id": "antigravity",
                "limit_name": "Antigravity",
                "groups": [
                    {"name": "Gemini Models", "windows": [{"kind": "weekly", "remaining_percent": 85, "resets_at": 1796181626}]},
                    {"name": "Claude and GPT models", "windows": [{"kind": "five-hour", "remaining_percent": 73}]},
                ],
            }

    class ClaudeFake:
        ENGINE_ID = "claude_agent_sdk"
        supports_quota = True

        async def get_quota(self, cwd=""):
            calls["claude_agent_sdk"] = calls.get("claude_agent_sdk", 0) + 1
            raise QuotaAuthenticationRequired("secret auth token")

    class CustomQuotaFake:
        ENGINE_ID = "my_custom_quota"
        supports_quota = True

        async def get_quota(self, cwd=""):
            calls["my_custom_quota"] = calls.get("my_custom_quota", 0) + 1
            raise RuntimeError("boom secret")

    class DisabledQuotaFake:
        ENGINE_ID = "disabled_quota"
        supports_quota = True

        async def get_quota(self, cwd=""):
            calls["disabled_quota"] = calls.get("disabled_quota", 0) + 1
            return {"primary": {"remaining_percent": 50}}

    class UnsupportedFake:
        ENGINE_ID = "opencode"
        supports_quota = False

        async def get_quota(self, cwd=""):
            calls["opencode"] = calls.get("opencode", 0) + 1
            return None

    instances = {
        "codex_sdk": CodexFake,
        "antigravity": AntigravityFake,
        "claude_agent_sdk": ClaudeFake,
        "my_custom_quota": CustomQuotaFake,
        "disabled_quota": DisabledQuotaFake,
        "opencode": UnsupportedFake,
    }
    catalog = [
        {"id": "codex_sdk", "enabled": True, "installed": True, "supports_quota": True},
        {"id": "antigravity", "enabled": True, "installed": True, "supports_quota": True},
        {"id": "claude_agent_sdk", "enabled": True, "installed": True, "supports_quota": True},
        {"id": "my_custom_quota", "enabled": True, "installed": True, "supports_quota": True, "custom": True, "name": "My Custom Quota"},
        {"id": "disabled_quota", "enabled": False, "installed": True, "supports_quota": True},
        {"id": "uninstalled_quota", "enabled": True, "installed": False, "supports_quota": True},
        {"id": "disabled_custom", "enabled": True, "installed": True, "supports_quota": True, "custom": True, "disabled": True},
        {"id": "opencode", "enabled": True, "installed": True, "supports_quota": False},
    ]

    monkeypatch.setattr(engine_api, "refresh_registry", lambda **_kw: None)
    monkeypatch.setattr(engine_api, "get_available_engines", lambda: list(catalog))
    monkeypatch.setattr(engine_api, "create_engine", lambda eid: instances[eid]() if eid in instances else None)

    transport = ASGITransport(app=main.app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # 1. Cold query returns all 4 enabled+installed+supports_quota engines, excludes disabled/uninstalled/unsupported
        resp = await client.get("/api/engine/quota")
        assert resp.status_code == 200
        body = resp.json()
        assert body["cached"] is False
        ids = [item["engine_id"] for item in body["engines"]]
        assert ids == ["codex_sdk", "antigravity", "claude_agent_sdk", "my_custom_quota"]
        assert "disabled_quota" not in calls
        assert "opencode" not in calls

        by_id = {item["engine_id"]: item for item in body["engines"]}
        assert by_id["codex_sdk"]["status"] == "ok"
        assert by_id["codex_sdk"]["quota"]["primary"]["remaining_percent"] == 81
        assert by_id["antigravity"]["status"] == "ok"
        assert len(by_id["antigravity"]["quota"]["groups"]) == 2
        assert by_id["claude_agent_sdk"]["status"] == "unauthenticated"
        assert by_id["claude_agent_sdk"]["quota"] is None
        assert by_id["my_custom_quota"]["status"] == "unavailable"
        assert by_id["my_custom_quota"]["name"] == "My Custom Quota"
        assert by_id["my_custom_quota"]["quota"] is None
        assert "secret" not in json.dumps(body)

        # 2. Second query within 5 minutes hits cache
        now_mono[0] += 120.0
        now_wall[0] += 120.0
        resp2 = await client.get("/api/engine/quota")
        assert resp2.status_code == 200
        assert resp2.json()["cached"] is True
        assert calls == {"codex_sdk": 1, "antigravity": 1, "claude_agent_sdk": 1, "my_custom_quota": 1}

        # 3. Manual refresh=1 bypasses cache and updates cached value
        resp3 = await client.get("/api/engine/quota?refresh=1")
        assert resp3.status_code == 200
        body3 = resp3.json()
        assert body3["cached"] is False
        assert calls["codex_sdk"] == 2
        assert next(x for x in body3["engines"] if x["engine_id"] == "codex_sdk")["quota"]["primary"]["remaining_percent"] == 80

        # 4. Subsequent normal query uses refreshed cache
        resp4 = await client.get("/api/engine/quota")
        assert resp4.status_code == 200
        assert resp4.json()["cached"] is True
        assert calls["codex_sdk"] == 2
        assert next(x for x in resp4.json()["engines"] if x["engine_id"] == "codex_sdk")["quota"]["primary"]["remaining_percent"] == 80


@pytest.mark.anyio
@pytest.mark.parametrize("adapter_failure", ["missing", "exception"])
async def test_unified_quota_preserves_snapshot_when_catalog_adapter_cannot_initialize(monkeypatch, adapter_failure):
    import main
    from api import engine as engine_api
    from services.engine_quota import UnifiedQuotaService

    class CodexFake:
        ENGINE_ID = "codex_sdk"
        supports_quota = True

        async def get_quota(self, cwd=""):
            return {"collected_at": 990, "primary": {"remaining_percent": 75}}

    catalog = [{"id": "codex_sdk", "enabled": True, "installed": True, "supports_quota": True}]
    initializing = False

    def create_engine(_engine_id):
        if not initializing:
            return CodexFake()
        if adapter_failure == "exception":
            raise RuntimeError("private constructor diagnostic")
        return None

    monkeypatch.setattr("services.engine_quota.unified_quota_service", UnifiedQuotaService())
    monkeypatch.setattr(engine_api, "refresh_registry", lambda **_kw: None)
    monkeypatch.setattr(engine_api, "get_available_engines", lambda: catalog)
    monkeypatch.setattr(engine_api, "create_engine", create_engine)

    async with AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test") as client:
        success = (await client.get("/api/engine/quota")).json()["engines"][0]
        assert success["quota"]["primary"]["remaining_percent"] == 75
        initializing = True
        failure = await client.get("/api/engine/quota?refresh=1")
        assert failure.status_code == 200
        assert failure.json()["engines"] == [{**success, "status": "unavailable"}]
        assert "private constructor diagnostic" not in failure.text

        reopened = (await client.get("/api/engine/quota")).json()
        assert reopened["cached"] is True
        assert reopened["engines"] == failure.json()["engines"]

        catalog[0]["enabled"] = False
        assert (await client.get("/api/engine/quota?refresh=1")).json()["engines"] == []


@pytest.mark.anyio
async def test_unified_quota_isolates_constructor_failure_during_real_registry_scan(monkeypatch):
    import main
    from engines.core import registry
    from engines.core.acp_base import AcpEngineBase
    from services.engine_quota import UnifiedQuotaService

    class QuotaAdapter(AcpEngineBase):
        ENGINE_ID = "first_quota_test"
        SUPPORTS_QUOTA = True
        fail = False

        def __init__(self):
            if self.fail:
                raise RuntimeError("private adapter diagnostic")
            super().__init__()

        @classmethod
        def is_installed(cls):
            return True

        @classmethod
        def get_version(cls):
            return "test"

        @staticmethod
        def resolve_binary():
            return None

        async def get_quota(self, cwd=""):
            return {"collected_at": 990, "primary": {"remaining_percent": 75}}

    class OtherAdapter(QuotaAdapter):
        ENGINE_ID = "second_quota_test"
        fail = False

    monkeypatch.setattr(registry, "_ALL_ENGINES", {cls.ENGINE_ID: cls for cls in (QuotaAdapter, OtherAdapter)})
    monkeypatch.setattr(registry, "ENGINE_REGISTRY", {})
    monkeypatch.setattr(registry, "_VERSION_CACHE", {})
    monkeypatch.setattr(registry, "_SCAN_CACHE", None)
    monkeypatch.setattr(registry.config_store, "is_engine_enabled", lambda _engine_id: True)
    service = UnifiedQuotaService()
    monkeypatch.setattr("services.engine_quota.unified_quota_service", service)

    async with AsyncClient(transport=ASGITransport(app=main.app, raise_app_exceptions=False), base_url="http://test") as client:
        response = await client.get("/api/engine/quota")
        assert response.status_code == 200
        first, other = response.json()["engines"]
        assert first["quota"]["primary"]["remaining_percent"] == 75
        assert other["status"] == "ok"

        QuotaAdapter.fail = True
        monkeypatch.setattr(registry, "_SCAN_CACHE", None)
        response = await client.get("/api/engine/quota?refresh=1")
        assert response.status_code == 200
        assert response.json()["engines"] == [{**first, "status": "unavailable"}, other]
        assert "private adapter diagnostic" not in response.text
        reopened = (await client.get("/api/engine/quota")).json()
        assert reopened["cached"] is True
        assert reopened["engines"] == response.json()["engines"]

        QuotaAdapter.fail = False

        async def collect_after_invalidation(_instance, cwd=""):
            service.invalidate()
            return {"primary": {"remaining_percent": 75}}

        monkeypatch.setattr(QuotaAdapter, "get_quota", collect_after_invalidation)
        invalidated = await client.get("/api/engine/quota?refresh=1")
        assert invalidated.status_code == 409
        assert invalidated.json() == {"detail": "Engine quota query invalidated"}


@pytest.mark.anyio
async def test_unified_quota_api_slow_collection_keeps_health_responsive_and_respects_project_bridge_scope(
    api_context, monkeypatch,
):
    import main
    from api import engine as engine_api
    from services.engine_quota import UnifiedQuotaService

    service = UnifiedQuotaService(ttl_seconds=300.0)
    monkeypatch.setattr("services.engine_quota.unified_quota_service", service)

    client, tmp_path = api_context
    directory = tmp_path / "remote-unified-quota"
    directory.mkdir()
    monkeypatch.setattr(engine_api, "project_manager", main.project_manager)

    initialized = await client.post("/api/project/init", json={"path": str(directory)})
    assert initialized.status_code == 200
    project_id = initialized.json()["id"]
    monkeypatch.setattr(main.gateway_client, "managed_config", object())

    entered = threading.Event()
    calls: list[str] = []

    class QuotaEngine:
        ENGINE_ID = "codex_sdk"
        supports_quota = True

        async def get_quota(self, cwd=""):
            calls.append(cwd)
            return {"engine_id": "codex_sdk", "primary": {"remaining_percent": 77}}

    def slow_registry(**_kwargs):
        entered.set()
        time.sleep(0.5)

    monkeypatch.setattr(engine_api, "refresh_registry", slow_registry)
    monkeypatch.setattr(
        engine_api,
        "get_available_engines",
        lambda: [{"id": "codex_sdk", "enabled": True, "installed": True, "supports_quota": True}],
    )
    monkeypatch.setattr(engine_api, "create_engine", lambda _id: QuotaEngine())

    async def bridge_request(query: str, user_id: str = "worker"):
        frames = []

        async def capture(frame):
            frames.append(frame)

        bridge = ManagedHttpBridge(main.app, "unified-quota", {
            "method": "GET", "path": "/api/engine/quota", "query": query,
            "headers": [], "user_id": user_id, "username": user_id,
            "project_id": project_id, "access_level": "read",
        }, capture, "device-1")
        bridge.start_task()
        await bridge.feed(ProxyFrame(stream_id="unified-quota", type=FrameType.http_request, payload={"phase": "end"}))
        await asyncio.wait_for(bridge._task, timeout=5)
        content = b"".join(
            base64.b64decode(frame.payload["data"])
            for frame in frames if frame.payload.get("phase") == "body"
        )
        return frames[0].payload["status"], json.loads(content)

    # Scope boundary rejections
    for bad_query in ("", "project_id=other", f"project_id={project_id}&project_id={project_id}",
                      f"project_id={project_id}&refresh=invalid", f"project_id={project_id}&extra=1"):
        status, _ = await bridge_request(bad_query)
        assert status == 403, bad_query
    assert calls == []

    # Slow scan does not block /api/health
    pending = asyncio.create_task(bridge_request(f"project_id={project_id}", user_id="user-a"))
    assert await asyncio.to_thread(entered.wait, 2)
    started = time.monotonic()
    assert (await client.get("/api/health")).status_code == 200
    assert time.monotonic() - started < 0.4
    status, body = await pending
    assert status == 200, body
    assert body["cached"] is False
    assert body["engines"][0]["quota"]["primary"]["remaining_percent"] == 77
    assert calls == [str(directory.resolve())]

    # Same user+project hits cache
    status2, body2 = await bridge_request(f"project_id={project_id}", user_id="user-a")
    assert status2 == 200 and body2["cached"] is True
    assert len(calls) == 1

    # Different user does NOT share user-a's cache
    status3, body3 = await bridge_request(f"project_id={project_id}", user_id="user-b")
    assert status3 == 200 and body3["cached"] is False
    assert len(calls) == 2

    # Manual refresh=1 is allowed in project scope and bypasses cache
    status4, body4 = await bridge_request(f"project_id={project_id}&refresh=1", user_id="user-a")
    assert status4 == 200 and body4["cached"] is False
    assert len(calls) == 3


@pytest.mark.anyio
async def test_unified_quota_api_concurrent_requests_do_not_duplicate_upstream_engine_calls(monkeypatch):
    import main
    from api import engine as engine_api
    from services.engine_quota import UnifiedQuotaService

    service = UnifiedQuotaService(ttl_seconds=300.0)
    monkeypatch.setattr("services.engine_quota.unified_quota_service", service)

    started = asyncio.Event()
    release = asyncio.Event()
    calls: dict[str, int] = {}

    class SlowCodex:
        ENGINE_ID = "codex_sdk"
        supports_quota = True

        async def get_quota(self, cwd=""):
            calls["codex_sdk"] = calls.get("codex_sdk", 0) + 1
            started.set()
            await release.wait()
            return {"engine_id": "codex_sdk", "primary": {"remaining_percent": 64}}

    class SlowAntigravity:
        ENGINE_ID = "antigravity"
        supports_quota = True

        async def get_quota(self, cwd=""):
            calls["antigravity"] = calls.get("antigravity", 0) + 1
            await release.wait()
            return {"engine_id": "antigravity", "primary": {"remaining_percent": 52}}

    instances = {"codex_sdk": SlowCodex, "antigravity": SlowAntigravity}
    catalog = [
        {"id": "codex_sdk", "enabled": True, "installed": True, "supports_quota": True},
        {"id": "antigravity", "enabled": True, "installed": True, "supports_quota": True},
    ]
    monkeypatch.setattr(engine_api, "refresh_registry", lambda **_kw: None)
    monkeypatch.setattr(engine_api, "get_available_engines", lambda: list(catalog))
    monkeypatch.setattr(engine_api, "create_engine", lambda eid: instances[eid]())

    transport = ASGITransport(app=main.app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        tasks = [asyncio.create_task(client.get("/api/engine/quota")) for _ in range(5)]
        await asyncio.wait_for(started.wait(), 2)
        release.set()
        responses = await asyncio.gather(*tasks)

    assert all(resp.status_code == 200 for resp in responses)
    assert calls == {"codex_sdk": 1, "antigravity": 1}
    for resp in responses:
        assert [item["engine_id"] for item in resp.json()["engines"]] == ["codex_sdk", "antigravity"]
