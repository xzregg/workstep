"""Persist Chrome push subscriptions and deliver reply and step results."""

import asyncio
import base64
from collections import deque
import json
import logging
import os
import time
from pathlib import Path
from urllib.parse import urlparse

from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from py_vapid import Vapid
from pywebpush import WebPushException, webpush

logger = logging.getLogger(__name__)


def _storage_dir() -> Path:
    return Path(os.environ.get("WORKSTEP_CONFIG_DIR") or Path.home() / ".workstep") / "data" / "web-push"


def _load_or_create(storage: Path) -> tuple[str, dict, list[dict]]:
    storage.mkdir(parents=True, exist_ok=True)
    private_file = storage / "vapid.pem"
    if private_file.exists():
        vapid = Vapid.from_file(str(private_file))
    else:
        vapid = Vapid()
        vapid.generate_keys()
        vapid.save_key(str(private_file))
        private_file.chmod(0o600)
    raw_key = vapid.public_key.public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
    public_key = base64.urlsafe_b64encode(raw_key).rstrip(b"=").decode()
    subscriptions_file = storage / "subscriptions.json"
    subscriptions = json.loads(subscriptions_file.read_text()) if subscriptions_file.exists() else {}
    recent_file = storage / "recent.json"
    recent = json.loads(recent_file.read_text()) if recent_file.exists() else []
    return public_key, subscriptions, recent


def _save(storage: Path, subscriptions: dict) -> None:
    temporary = storage / "subscriptions.json.tmp"
    temporary.write_text(json.dumps(subscriptions, ensure_ascii=False))
    temporary.chmod(0o600)
    temporary.replace(storage / "subscriptions.json")


def _save_recent(storage: Path, recent: list[dict]) -> None:
    temporary = storage / "recent.json.tmp"
    temporary.write_text(json.dumps(recent, ensure_ascii=False))
    temporary.chmod(0o600)
    temporary.replace(storage / "recent.json")


def _send(subscription: dict, payload: dict, private_file: Path) -> None:
    webpush(
        subscription_info=subscription,
        data=json.dumps(payload, ensure_ascii=False),
        vapid_private_key=str(private_file),
        vapid_claims={"sub": "https://github.com/xzregg/workstep"},
        ttl=3600,
    )


class CompletionPushService:
    def __init__(self, bus, storage: Path | None = None, sender=_send):
        self.bus = bus
        self.storage = storage or _storage_dir()
        self.sender = sender
        self.public_key = ""
        self.subscriptions: dict[str, dict] = {}
        self.recent: list[dict] = []
        self.queue = None
        self.task = None
        self._save_lock = asyncio.Lock()
        self._sent_ids = deque(maxlen=1000)

    async def start(self):
        self.public_key, self.subscriptions, self.recent = await asyncio.to_thread(
            _load_or_create, self.storage
        )
        self.queue = self.bus.subscribe(lambda event: event.get("type") in
                                        {"TEXT_MESSAGE_END", "RUN_FINISHED", "RUN_ERROR"})
        self.task = asyncio.create_task(self._run())

    async def shutdown(self):
        if self.queue is not None:
            self.bus.unsubscribe(self.queue)
        if self.task is not None:
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                pass

    async def register(self, subscription: dict, project_id: str, project_name: str,
                       session_ids: list[str], task_ids: list[str]):
        endpoint = subscription.get("endpoint", "")
        parsed = urlparse(endpoint)
        if parsed.scheme != "https" or parsed.hostname != "fcm.googleapis.com":
            raise ValueError("仅接受 Chrome 推送订阅")
        keys = subscription.get("keys") or {}
        if not keys.get("p256dh") or not keys.get("auth"):
            raise ValueError("推送订阅缺少密钥")
        async with self._save_lock:
            self.subscriptions[endpoint] = {
                "subscription": subscription, "project_id": project_id,
                "project_name": project_name[:120],
                "session_ids": session_ids[:100], "task_ids": task_ids[:100],
            }
            await asyncio.to_thread(_save, self.storage, self.subscriptions)

    async def remove(self, endpoint: str):
        async with self._save_lock:
            self.subscriptions.pop(endpoint, None)
            await asyncio.to_thread(_save, self.storage, self.subscriptions)

    def recent_for_project(self, project_id: str, since: float = 0) -> list[dict]:
        return [event for event in self.recent if event["project_id"] == project_id
                and event["recorded_at"] >= since]

    async def _run(self):
        while True:
            event = await self.queue.get()
            if event is None:
                return
            step_result = event.get("type") in {"RUN_FINISHED", "RUN_ERROR"}
            if step_result:
                if not event.get("step_key") or (event.get("type"), event.get("status")) not in {
                    ("RUN_FINISHED", "passed"), ("RUN_ERROR", "failed")
                }:
                    continue
            elif event.get("status") not in {"succeeded", "failed", "error"}:
                continue
            project_id = event.get("project_id")
            message_id = event.get("messageId")
            session_id = event.get("session_id")
            task_id = event.get("task_id")
            if not project_id or (not task_id if step_result else not message_id or not (session_id or task_id)):
                continue
            success = event["status"] in {"succeeded", "passed"}
            key = (f"{project_id}:{task_id}:step:{event['step_key']}:{event.get('sequence', event['status'])}"
                   if step_result else f"{project_id}:{session_id or task_id}:{message_id}")
            if key in self._sent_ids:
                continue
            self._sent_ids.append(key)
            record = {name: event.get(name) for name in
                      ("type", "project_id", "session_id", "task_id", "messageId", "status",
                       "step_key", "sequence")}
            record["recorded_at"] = time.time()
            async with self._save_lock:
                self.recent.append(record)
                self.recent = [item for item in self.recent[-1000:]
                               if item["recorded_at"] >= time.time() - 86400]
                await asyncio.to_thread(_save_recent, self.storage, self.recent)
            stale = []
            for endpoint, target in list(self.subscriptions.items()):
                if target["project_id"] != project_id:
                    continue
                if session_id not in target["session_ids"] and task_id not in target["task_ids"]:
                    continue
                from urllib.parse import urlencode
                project_name = target["project_name"]
                path = "/tasks" if task_id else "/chat"
                query = urlencode({"project": project_name, "task" if task_id else "session": task_id or session_id})
                payload = {
                    "id": key, "title": ("WorkStep 步骤完成" if success else "WorkStep 步骤失败")
                                      if step_result else ("WorkStep 回复完成" if success else "WorkStep 回复失败"),
                    "body": (f"步骤 {event['step_key']} {'已通过' if success else '执行失败'}") if step_result else
                            "任务的回复已完成" if task_id and success else
                            "任务的回复失败" if task_id else
                            "会话的回复已完成" if success else "会话的回复失败",
                    "url": f"{path}?{query}",
                }
                try:
                    await asyncio.to_thread(self.sender, target["subscription"], payload,
                                            self.storage / "vapid.pem")
                except WebPushException as exc:
                    if exc.response is not None and exc.response.status_code in {404, 410}:
                        stale.append(endpoint)
                    else:
                        logger.warning("Chrome push delivery failed: %s", exc)
                except Exception:
                    logger.exception("Chrome push delivery failed")
            if stale:
                async with self._save_lock:
                    for endpoint in stale:
                        self.subscriptions.pop(endpoint, None)
                    await asyncio.to_thread(_save, self.storage, self.subscriptions)
