"""Authenticated outbound PC control WebSocket and connection presence."""

import asyncio
import base64
import binascii
import hashlib
import json
import secrets
import time
from datetime import datetime, timezone
from uuid import uuid4

import anyio
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlalchemy import select

from .models import Device, DeviceConnection, User, UserDevice

router = APIRouter()


def _decode(value: str) -> bytes:
    if not value or len(value) > 8192 or any(c not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-" for c in value):
        raise ValueError("Invalid control credential encoding")
    return base64.urlsafe_b64decode(value + "===")


async def binding_active(ws: WebSocket, device_id: str, user_id: str) -> bool:
    async with ws.app.state.database.session() as session:
        device = await session.get(Device, device_id)
        user = await session.get(User, user_id)
        assignment = await session.scalar(select(UserDevice).where(
            UserDevice.device_id == device_id,
            UserDevice.user_id == user_id,
            UserDevice.revoked_at.is_(None),
        ))
    return bool(device and device.status == "active" and user and user.status == "active"
                and assignment)


async def authenticate_device(ws: WebSocket, message: dict, nonce: str) -> tuple[str, str]:
    token = message.get("authorization")
    delegation = message.get("control_delegation_signature")
    challenge_proof = message.get("control_challenge_proof")
    control_public_key_pem = message.get("control_public_key_pem")
    if (not isinstance(token, str) or not isinstance(delegation, str)
            or not isinstance(challenge_proof, str) or not isinstance(control_public_key_pem, str)
            or len(token) > 16384 or len(control_public_key_pem) > 4096):
        raise ValueError("Missing control credential")
    try:
        header, payload, signature = token.split(".")
        if json.loads(_decode(header)) != {"alg": "EdDSA", "typ": "JWT"}:
            raise ValueError("Invalid control credential header")
        signer = ws.app.state.gateway_signer
        signer.private_key.public_key().verify(_decode(signature), f"{header}.{payload}".encode())
        claims = json.loads(_decode(payload))
        now = int(time.time())
        if (claims.get("gateway_id") != ws.app.state.settings.gateway_id
                or claims.get("iss") != ws.app.state.settings.gateway_id
                or not isinstance(claims.get("iat"), int)
                or not isinstance(claims.get("exp"), int)
                or claims["iat"] > now + 60 or claims["exp"] <= now
                or claims["exp"] - claims["iat"] > 900):
            raise ValueError("Expired control credential")
        device_id = claims["device_id"]
        public_key_pem = claims["device_public_key"]
        device_key = serialization.load_pem_public_key(public_key_pem.encode())
        if not isinstance(device_key, Ed25519PublicKey):
            raise ValueError("Invalid device key")
        control_key = serialization.load_pem_public_key(control_public_key_pem.encode())
        if not isinstance(control_key, Ed25519PublicKey):
            raise ValueError("Invalid delegated control key")
        control_fingerprint = hashlib.sha256(control_key.public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo,
        )).hexdigest()
        device_key.verify(_decode(delegation),
                          f"workstep-control-delegate-v1:{token}:{control_fingerprint}".encode())
        control_key.verify(_decode(challenge_proof),
                           f"workstep-control-challenge-v1:{nonce}:{token}".encode())
        fingerprint = hashlib.sha256(device_key.public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo,
        )).hexdigest()
    except (KeyError, TypeError, ValueError, binascii.Error, InvalidSignature,
            UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("Invalid control credential") from exc
    async with ws.app.state.database.session() as session:
        device = await session.get(Device, device_id)
        user = await session.get(User, claims.get("user_id"))
        assignment = await session.scalar(select(UserDevice).where(
            UserDevice.device_id == device_id,
            UserDevice.user_id == claims.get("user_id"),
            UserDevice.revoked_at.is_(None),
        ))
    if (not device or device.status != "active" or device.public_key_fingerprint != fingerprint
            or device.app_instance_id != claims.get("app_instance_id")
            or not user or user.status != "active" or not assignment):
        raise ValueError("Device or user unavailable")
    return device_id, user.id


class ControlConnections:
    def __init__(self):
        self._active: dict[str, tuple[str, WebSocket, asyncio.Task]] = {}
        self._lock = asyncio.Lock()

    def is_online(self, device_id: str) -> bool:
        return device_id in self._active

    async def claim(self, device_id: str, connection_id: str, ws: WebSocket) -> None:
        async with self._lock:
            previous = self._active.get(device_id)
            self._active[device_id] = (connection_id, ws, asyncio.current_task())
        if previous:
            try:
                await previous[1].close(code=4000, reason="Replaced by new connection")
            except (RuntimeError, anyio.ClosedResourceError):
                pass

    async def release(self, device_id: str, connection_id: str) -> None:
        async with self._lock:
            if self._active.get(device_id, (None,))[0] == connection_id:
                self._active.pop(device_id, None)

    async def shutdown(self) -> None:
        async with self._lock:
            active = list(self._active.values())
        for _, ws, _ in active:
            try:
                await ws.close(code=1001, reason="Gateway shutting down")
            except (RuntimeError, anyio.ClosedResourceError):
                pass
        if active:
            await asyncio.gather(*(task for _, _, task in active), return_exceptions=True)

    async def disconnect(self, device_id: str) -> None:
        async with self._lock:
            active = self._active.get(device_id)
        if active:
            try:
                await active[1].close(code=4003, reason="Device disabled or revoked")
            except (RuntimeError, anyio.ClosedResourceError):
                pass


@router.websocket("/api/control/ws")
async def control_socket(ws: WebSocket):
    await ws.accept()
    device_id = None
    user_id = None
    connection_id = None
    try:
        try:
            nonce = secrets.token_urlsafe(32)
            await ws.send_json({"kind": "challenge", "version": 1, "nonce": nonce})
            hello = await asyncio.wait_for(ws.receive_json(), timeout=5)
            if not isinstance(hello, dict):
                raise ValueError("Invalid handshake")
            device_id, user_id = await authenticate_device(ws, hello, nonce)
        except (ValueError, asyncio.TimeoutError):
            await ws.close(code=4401)
            return
        connection_id = uuid4().hex
        async with ws.app.state.database.session() as session:
            async with session.begin():
                session.add(DeviceConnection(id=connection_id, device_id=device_id))
        await ws.app.state.control_connections.claim(device_id, connection_id, ws)
        signer = ws.app.state.gateway_signer
        policy = signer.sign_policy_snapshot(
            gateway_id=ws.app.state.settings.gateway_id,
            device_id=device_id, user_id=user_id,
        )
        await ws.send_json({"kind": "hello", "version": 1, "device_id": device_id,
                            "gateway_public_key_pem": signer.public_key_pem,
                            "policy_snapshot": policy})
        policy_revision = 0
        while True:
            try:
                message = await asyncio.wait_for(ws.receive_json(), timeout=90)
            except asyncio.TimeoutError:
                await ws.close(code=4001, reason="Heartbeat timeout")
                return
            if not isinstance(message, dict):
                await ws.close(code=4400, reason="Invalid control message")
                return
            if message.get("kind") == "policy_applied":
                revision = message.get("revision")
                if type(revision) is not int or revision < 0 or revision > policy_revision:
                    await ws.close(code=4400, reason="Invalid policy revision")
                    return
                async with ws.app.state.database.session() as session:
                    connection = await session.get(DeviceConnection, connection_id)
                    if connection:
                        connection.applied_policy_revision = revision
                        await session.commit()
                await ws.send_json({"kind": "policy_applied_ack", "version": 1,
                                    "device_id": device_id, "revision": revision})
                continue
            if message.get("kind") != "heartbeat":
                await ws.close(code=4400, reason="Invalid control message")
                return
            if not await binding_active(ws, device_id, user_id):
                await ws.close(code=4003, reason="Device access revoked")
                return
            policy = signer.sign_policy_snapshot(
                gateway_id=ws.app.state.settings.gateway_id,
                device_id=device_id, user_id=user_id,
            )
            await ws.send_json({"kind": "heartbeat_ack", "version": 1,
                                "device_id": device_id, "policy_snapshot": policy})
    except WebSocketDisconnect:
        pass
    finally:
        if device_id and connection_id:
            with anyio.CancelScope(shield=True):
                async with ws.app.state.database.session() as session:
                    connection = await session.get(DeviceConnection, connection_id)
                    if connection:
                        connection.disconnected_at = datetime.now(timezone.utc)
                        connection.close_reason = "closed"
                        await session.commit()
                await ws.app.state.control_connections.release(device_id, connection_id)
