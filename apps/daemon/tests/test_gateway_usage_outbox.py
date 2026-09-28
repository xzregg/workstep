import asyncio

import pytest

from services.gateway_client.usage_outbox import UsageOutbox
from services.gateway_client.control import GatewayControlClient
from services.gateway_client.policy import ManagedPolicyCache
from services.gateway_client.usage import build_usage_event
from services.gateway_client.service import GatewayClientService


def test_usage_outbox_retries_stable_batch_and_clears_only_acked_items(tmp_path):
    outbox = UsageOutbox(tmp_path / "usage-outbox.db")
    one = {"usage_event_id": "usage-1", "input_tokens": 10, "output_tokens": 2}
    two = {"usage_event_id": "usage-2", "input_tokens": 20, "output_tokens": 3}
    assert outbox.append(one) is True
    assert outbox.append(one) is False
    outbox.append(two)
    first = outbox.pending()
    assert first["events"] == [one, two]
    assert outbox.pending()["batch_id"] == first["batch_id"]
    outbox.ack(first["batch_id"], accepted=["usage-1"], duplicates=[],
               rejected=[])
    assert [item["usage_event_id"] for item in outbox.pending()["events"]] == ["usage-2"]
    outbox.ack(first["batch_id"], accepted=[], duplicates=["usage-2"],
               rejected=[])
    assert outbox.pending() is None
    assert UsageOutbox(tmp_path / "usage-outbox.db").pending() is None


def test_usage_outbox_keeps_other_device_events_until_matching_connection(tmp_path):
    outbox = UsageOutbox(tmp_path / "usage-outbox.db")
    outbox.append({"usage_event_id": "old-usage", "device_id": "old-device"})
    outbox.append({"usage_event_id": "new-usage", "device_id": "new-device"})
    assert [item["usage_event_id"] for item in outbox.pending(device_id="new-device")["events"]] == [
        "new-usage"]
    assert [item["usage_event_id"] for item in outbox.pending(device_id="old-device")["events"]] == [
        "old-usage"]


@pytest.mark.asyncio
async def test_slow_usage_outbox_does_not_block_light_coroutine(tmp_path, monkeypatch):
    import time

    outbox = UsageOutbox(tmp_path / "usage-outbox.db")
    original = outbox.append

    def slow_append(value):
        time.sleep(0.15)
        return original(value)

    monkeypatch.setattr(outbox, "append", slow_append)
    task = asyncio.create_task(asyncio.to_thread(outbox.append, {
        "usage_event_id": "usage-1", "input_tokens": 10, "output_tokens": 2,
    }))
    await asyncio.sleep(0.02)
    assert not task.done()
    await asyncio.wait_for(asyncio.sleep(0.01), timeout=0.05)
    await task


@pytest.mark.asyncio
async def test_control_usage_loop_clears_outbox_only_after_ack(tmp_path):
    import json

    outbox = UsageOutbox(tmp_path / "usage-outbox.db")
    outbox.append({"usage_event_id": "usage-1", "device_id": "device-1",
                   "input_tokens": 10,
                   "output_tokens": 2})
    client = GatewayControlClient("https://gateway.test", gateway_id="gateway-test",
                                  public_key_fingerprint="pin", user_id="user-1",
                                  policy_cache=ManagedPolicyCache(), usage_outbox=outbox)
    messages = asyncio.Queue()
    sent = asyncio.Queue()

    class Socket:
        async def send(self, raw):
            await sent.put(json.loads(raw))

    task = asyncio.create_task(client._usage_loop(Socket(), "device-1", messages))
    batch = await asyncio.wait_for(sent.get(), timeout=1)
    assert batch["events"][0]["usage_event_id"] == "usage-1"
    assert outbox.pending() is not None
    messages.put_nowait({"kind": "usage_ack", "version": 1, "device_id": "device-1",
                         "batch_id": batch["batch_id"], "accepted": ["usage-1"],
                         "duplicates": [], "rejected": []})
    await asyncio.sleep(0.05)
    assert outbox.pending() is None
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)


def test_usage_event_snapshots_price_and_marks_missing_usage():
    from datetime import datetime, timezone
    import json

    provider = {"id": "provider-1", "managed_revision": 3,
                "prices": {"version": "v2", "models": {"model-a": {
                    "input_per_million": "1.00", "output_per_million": "2.00",
                    "cache_read_per_million": "0.10",
                }}}}
    context = {"gateway_id": "gateway-test", "device_id": "device-1",
               "user_id": "user-1", "project_id": "project-1",
               "task_id": "task-1", "message_id": "message-1",
               "run_id": "run-1", "model": "model-a",
               "occurred_at": datetime.now(timezone.utc)}
    usage = json.dumps({"input_tokens": 120, "output_tokens": 30,
                        "cache_read_input_tokens": 20,
                        "cache_input_included": True})
    event = build_usage_event(**context, provider=provider, usage_json=usage)
    assert event["input_tokens"] == 120
    assert event["estimated_cost"] == "0.000162"
    assert event["pricing_version"] == "v2"
    assert event["provider_revision"] == 3
    missing = build_usage_event(**{**context, "message_id": "message-2"},
                                provider=provider, usage_json=None)
    assert missing["metering_status"] == "unmetered"
    assert missing["estimated_cost"] is None
    assert "input_tokens" not in missing
    reported_cost = build_usage_event(
        **{**context, "message_id": "message-3"}, provider={"id": "provider-1"},
        usage_json=json.dumps({"input_tokens": 10, "output_tokens": 2,
                               "cost": {"amount": 0.01, "currency": "USD"}}),
    )
    assert reported_cost["estimated_cost"] == "0.010000"


@pytest.mark.asyncio
async def test_gateway_service_records_completed_message_to_durable_outbox(tmp_path):
    from datetime import datetime, timezone
    from types import SimpleNamespace

    service = GatewayClientService()
    service.managed_config = SimpleNamespace(gateway_id="gateway-test")
    service.usage_outbox = UsageOutbox(tmp_path / "usage-outbox.db")
    service.device_id = "device-1"
    service.current_user_id = "user-1"
    await service.record_message_usage(
        project_id="project-1", task_id="task-1", message_id="message-1",
        run_id="run-1", model="model-a", occurred_at=datetime.now(timezone.utc),
        provider={"id": "provider-1"}, provider_id="provider-1",
        usage_json='{"input_tokens":10,"output_tokens":2}', user_id="user-1",
    )
    event = service.usage_outbox.pending()["events"][0]
    assert event["device_id"] == "device-1"
    assert event["project_id"] == "project-1"
    assert event["input_tokens"] == 10
