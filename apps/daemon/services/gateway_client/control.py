"""Outbound managed device control connection with bounded reconnect."""

import asyncio
import json
import logging
from urllib.parse import urlsplit

from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

logger = logging.getLogger(__name__)


def control_url(origin: str) -> str:
    parsed = urlsplit(origin)
    if parsed.scheme != "https" or not parsed.netloc or parsed.path or parsed.query or parsed.fragment:
        raise ValueError("Invalid managed Gateway origin")
    return f"wss://{parsed.netloc}/api/control/ws"


class GatewayControlClient:
    def __init__(self, origin: str, *, connector=connect, heartbeat_seconds: float = 20):
        self.url = control_url(origin)
        self.origin = origin
        self.connector = connector
        self.heartbeat_seconds = heartbeat_seconds
        self.online = False
        self.authorization_required = False
        self._task: asyncio.Task | None = None
        self._stop = asyncio.Event()

    def start(self, authorization: str, proof: str, device_id: str) -> None:
        if self._task and not self._task.done():
            raise RuntimeError("Control client already started")
        self._stop.clear()
        self.authorization_required = False
        self._task = asyncio.create_task(self._run(authorization, proof, device_id))

    async def stop(self) -> None:
        self._stop.set()
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        self.online = False

    async def _run(self, authorization: str, proof: str, device_id: str) -> None:
        delay = 1.0
        while not self._stop.is_set():
            try:
                async with self.connector(self.url, origin=self.origin, open_timeout=10,
                                          max_size=1024 * 1024) as socket:
                    await socket.send(json.dumps({"authorization": authorization,
                                                  "device_proof": proof}))
                    raw = await asyncio.wait_for(socket.recv(), timeout=10)
                    hello = json.loads(raw)
                    if hello != {"kind": "hello", "version": 1, "device_id": device_id}:
                        raise ValueError("Invalid Gateway control handshake")
                    self.online = True
                    delay = 1.0
                    while not self._stop.is_set():
                        await socket.send(json.dumps({"kind": "heartbeat"}))
                        raw = await asyncio.wait_for(socket.recv(), timeout=10)
                        ack = json.loads(raw)
                        if ack != {"kind": "heartbeat_ack", "version": 1,
                                   "device_id": device_id}:
                            raise ValueError("Invalid Gateway heartbeat acknowledgment")
                        try:
                            await asyncio.wait_for(self._stop.wait(), timeout=self.heartbeat_seconds)
                        except asyncio.TimeoutError:
                            pass
            except asyncio.CancelledError:
                raise
            except ConnectionClosed as exc:
                if exc.rcvd and exc.rcvd.code == 4401:
                    self.authorization_required = True
                    return
                logger.warning("Gateway control connection closed: %s", type(exc).__name__)
            except Exception as exc:
                logger.warning("Gateway control connection failed: %s", type(exc).__name__)
            finally:
                self.online = False
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=delay)
            except asyncio.TimeoutError:
                delay = min(delay * 2, 60)
