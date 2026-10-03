"""Versioned engine operations executed by authenticated managed commands."""

import asyncio

from engines.core.registry import refresh_registry
from services import engine_runtime
from services.engine_actions import probe_engine

from .commands import ManagedDeviceCommand


def _command_scope(command: ManagedDeviceCommand) -> dict:
    return {"command_id": command.command_id, "idempotency_key": command.idempotency_key,
            "device_id": command.device_id, "action": command.action,
            "version": command.version,
            "accept_third_party_terms": command.accept_third_party_terms}


async def recover_engine_command(command: ManagedDeviceCommand) -> tuple[str, str | None]:
    if command.action not in ("install", "update", "rollback"):
        return "failed", "Previous execution interrupted"
    manager = engine_runtime.runtime_manager
    operation = await manager.recover_managed(command.engine_id, _command_scope(command))
    if operation is None:
        return "failed", "Previous execution interrupted"
    return await _wait_for_operation(manager, command.engine_id, operation["id"])


async def execute_engine_command(command: ManagedDeviceCommand) -> tuple[str, str | None]:
    if command.action == "refresh":
        await asyncio.to_thread(refresh_registry)
        return "succeeded", None
    if command.action == "test":
        result = await probe_engine(command.engine_id, timeout_seconds=60)
        return ("succeeded", None) if result["success"] else ("failed", "Engine test failed")
    if command.action not in ("install", "update", "rollback"):
        raise ValueError("Unsupported engine command")
    manager = engine_runtime.runtime_manager
    operation = await manager.start(
        command.engine_id, command.version,
        rollback=command.action == "rollback",
        accept_terms=command.accept_third_party_terms,
        managed_command=_command_scope(command),
    )
    return await _wait_for_operation(manager, command.engine_id, operation["id"])


async def _wait_for_operation(manager, engine_id: str, operation_id: str) -> tuple[str, str | None]:
    async with asyncio.timeout(930):
        while True:
            current = await manager.operation(engine_id)
            if current is None or current.get("id") != operation_id:
                return "failed", "Engine operation state lost"
            if current.get("status") == "succeeded":
                return "succeeded", None
            if current.get("status") == "failed":
                return "failed", "Engine operation failed"
            await asyncio.sleep(1)
