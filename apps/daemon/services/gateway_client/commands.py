"""Pinned device commands and durable replay receipts."""

import asyncio
import base64
import binascii
import hashlib
import json
import re
import time
from dataclasses import dataclass
from typing import Awaitable, Callable

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey


@dataclass(frozen=True)
class ManagedDeviceCommand:
    command_id: str
    batch_id: str
    device_id: str
    idempotency_key: str
    action: str
    engine_id: str
    version: str | None
    accept_third_party_terms: bool
    expires_at: int


def _decode(value: str) -> bytes:
    if (not value or len(value) > 16384 or any(
        char not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"
        for char in value
    )):
        raise ValueError("Invalid command encoding")
    return base64.urlsafe_b64decode(value + "===")


def verify_device_command(token: str, public_key_pem: str, expected_fingerprint: str,
                          gateway_id: str, device_id: str) -> ManagedDeviceCommand:
    try:
        if not isinstance(token, str) or len(token) > 16384:
            raise ValueError("Invalid command token")
        public_key = serialization.load_pem_public_key(public_key_pem.encode())
        if not isinstance(public_key, Ed25519PublicKey):
            raise ValueError("Invalid Gateway command key")
        fingerprint = hashlib.sha256(public_key.public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo,
        )).hexdigest()
        if fingerprint != expected_fingerprint:
            raise ValueError("Gateway command key mismatch")
        header, payload, signature = token.split(".")
        if json.loads(_decode(header)) != {"alg": "EdDSA", "typ": "JWT"}:
            raise ValueError("Invalid command algorithm")
        public_key.verify(_decode(signature), f"{header}.{payload}".encode())
        claims = json.loads(_decode(payload))
        now = int(time.time())
        if (not isinstance(claims, dict) or claims.get("iss") != gateway_id
                or claims.get("gateway_id") != gateway_id
                or claims.get("kind") != "device.command"
                or claims.get("device_id") != device_id
                or claims.get("action") not in ("install", "update", "rollback", "refresh", "test")
                or type(claims.get("iat")) is not int or type(claims.get("exp")) is not int
                or claims["iat"] > now + 60 or claims["exp"] <= now
                or claims["exp"] - claims["iat"] > 3600
                or type(claims.get("accept_third_party_terms")) is not bool):
            raise ValueError("Invalid command scope or lifetime")
        for name in ("command_id", "batch_id", "idempotency_key"):
            value = claims.get(name)
            if not isinstance(value, str) or not value or len(value) > 128:
                raise ValueError("Invalid command identity")
        engine_id = claims.get("engine_id")
        version = claims.get("version")
        if (not isinstance(engine_id, str) or not re.fullmatch(r"[a-z][a-z0-9_]{0,63}", engine_id)
                or (claims["action"] in ("install", "update") and
                    (not isinstance(version, str) or not re.fullmatch(r"[0-9][0-9A-Za-z.+-]{0,99}", version)))
                or (claims["action"] in ("rollback", "refresh", "test") and version is not None)):
            raise ValueError("Invalid command parameters")
        return ManagedDeviceCommand(
            command_id=claims["command_id"], batch_id=claims["batch_id"],
            device_id=device_id, idempotency_key=claims["idempotency_key"],
            action=claims["action"], engine_id=engine_id, version=version,
            accept_third_party_terms=claims["accept_third_party_terms"],
            expires_at=claims["exp"],
        )
    except (InvalidSignature, KeyError, TypeError, ValueError, UnicodeError,
            binascii.Error, json.JSONDecodeError) as exc:
        raise ValueError("Invalid Gateway device command") from exc


class ManagedCommandExecutor:
    def __init__(self, store, action: Callable[[ManagedDeviceCommand], Awaitable[tuple[str, str | None]]]):
        self.store = store
        self.action = action
        self._inflight: dict[str, asyncio.Task] = {}
        self._lock = asyncio.Lock()

    async def execute(self, command: ManagedDeviceCommand) -> tuple[str, str | None]:
        async with self._lock:
            task = self._inflight.get(command.command_id)
            if task is None:
                task = asyncio.create_task(self._run(command))
                self._inflight[command.command_id] = task
                task.add_done_callback(lambda _task: self._inflight.pop(command.command_id, None))
        return await task

    async def _run(self, command: ManagedDeviceCommand) -> tuple[str, str | None]:
        receipt, claimed = await asyncio.to_thread(
            self.store.claim_managed_command, command.command_id, command.idempotency_key,
        )
        if not claimed:
            if receipt["status"] == "running":
                result = ("failed", "Previous execution interrupted")
                await asyncio.to_thread(
                    self.store.finish_managed_command, command.command_id,
                    command.idempotency_key, *result,
                )
                return result
            return receipt["status"], receipt.get("error")
        try:
            result = await self.action(command)
            if result[0] not in ("succeeded", "failed"):
                raise ValueError("Invalid local command result")
        except asyncio.CancelledError:
            result = ("failed", "Execution interrupted")
            await asyncio.to_thread(self.store.finish_managed_command,
                                    command.command_id, command.idempotency_key, *result)
            raise
        except Exception as exc:
            result = ("failed", f"{type(exc).__name__}: execution failed")
        await asyncio.to_thread(self.store.finish_managed_command,
                                command.command_id, command.idempotency_key, *result)
        return result
