import asyncio
import base64
import json
from types import SimpleNamespace

from pywebpush import WebPusher

from services.completion_push import CompletionPushService, _load_or_create, _send
from streaming.bus import EventBus


def test_push_sender_signs_with_valid_contact(tmp_path, monkeypatch):
    public_key, _, _ = _load_or_create(tmp_path)
    delivered = []

    def capture_send(self, data, headers, **kwargs):
        delivered.append((data, headers, kwargs))
        return SimpleNamespace(status_code=201)

    # Keep the real webpush/VAPID signing path; only replace network delivery.
    monkeypatch.setattr(WebPusher, "send", capture_send)
    payload = {"title": "WorkStep 回复完成"}
    _send(
        {"endpoint": "https://fcm.googleapis.com/fcm/send/example",
         "keys": {"p256dh": public_key,
                  "auth": base64.urlsafe_b64encode(b"a" * 16).decode()}},
        payload,
        tmp_path / "vapid.pem",
    )

    assert len(delivered) == 1
    data, headers, options = delivered[0]
    assert json.loads(data) == payload
    authorization = headers["Authorization"]
    token = authorization.split("t=", 1)[1].split(",", 1)[0]
    claims_segment = token.split(".")[1]
    claims = json.loads(base64.urlsafe_b64decode(claims_segment + "=" * (-len(claims_segment) % 4)))
    assert claims["sub"] == "mailto:support@workstep.me"
    assert claims["aud"] == "https://fcm.googleapis.com"
    assert options["ttl"] == 3600


def test_push_only_targets_watched_terminal_messages(tmp_path):
    async def scenario():
        sent = []
        bus = EventBus()
        service = CompletionPushService(bus, tmp_path, lambda subscription, payload, key: sent.append(payload))
        await service.start()
        try:
            await service.register(
                {"endpoint": "https://fcm.googleapis.com/fcm/send/example",
                 "keys": {"p256dh": "public", "auth": "secret"}},
                "p1", "项目 A", ["s1"], [],
            )
            await bus.publish({"type": "TEXT_MESSAGE_END", "project_id": "p1",
                               "session_id": "other", "messageId": "m1", "status": "succeeded"})
            await bus.publish({"type": "TEXT_MESSAGE_END", "project_id": "p1",
                               "session_id": "s1", "task_id": "unrelated-task",
                               "channel": "session_chat", "messageId": "m2", "status": "failed"})
            await bus.publish({"type": "TEXT_MESSAGE_END", "project_id": "p1",
                               "session_id": "s1", "messageId": "m2", "status": "failed"})
            for _ in range(10):
                await asyncio.sleep(0.01)
                if sent:
                    break
            assert len(sent) == 1
            assert sent[0]["title"] == "WorkStep 回复失败"
            assert sent[0]["url"] == "/chat?project=%E9%A1%B9%E7%9B%AE+A&session=s1"
            assert service.recent_for_project("p1")[-1]["channel"] == "session_chat"
            assert (tmp_path / "vapid.pem").exists()
            assert (tmp_path / "subscriptions.json").exists()
            assert len(service.recent_for_project("p1")) == 2
            assert (tmp_path / "recent.json").exists()
        finally:
            await service.shutdown()
            await bus.close()

    asyncio.run(scenario())


def test_push_delivers_watched_step_results(tmp_path):
    async def scenario():
        sent = []
        bus = EventBus()
        service = CompletionPushService(bus, tmp_path, lambda subscription, payload, key: sent.append(payload))
        await service.start()
        try:
            await service.register(
                {"endpoint": "https://fcm.googleapis.com/fcm/send/example",
                 "keys": {"p256dh": "public", "auth": "secret"}},
                "p1", "项目 A", [], ["t1"],
            )
            await bus.publish({"type": "RUN_FINISHED", "project_id": "p1", "task_id": "t1",
                               "step_key": "review", "status": "passed", "sequence": 12})
            await bus.publish({"type": "RUN_ERROR", "project_id": "p1", "task_id": "t1",
                               "step_key": "review", "status": "failed", "sequence": 13})
            for _ in range(20):
                await asyncio.sleep(0.01)
                if len(sent) == 2:
                    break
            assert [item["title"] for item in sent] == ["WorkStep 步骤完成", "WorkStep 步骤失败"]
            assert sent[0]["id"] == "p1:t1:step:review:12"
            assert len(service.recent_for_project("p1")) == 2
        finally:
            await service.shutdown()
            await bus.close()

    asyncio.run(scenario())
