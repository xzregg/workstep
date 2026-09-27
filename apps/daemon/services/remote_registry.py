"""Persistent catalog and identity mapping for remote projects."""

import hashlib
import secrets
import threading
from typing import Any
from urllib.parse import urlparse

from services.remote_access import RemoteAccessService, _secret_hash, _serialize_remote_state


class RemoteProjectRegistry:
    """Persistent client-side catalog of remote projects.

    A remote project gets a local identifier.  That identifier is the only one
    exposed to the browser; the host project identifier is resolved at the
    transport boundary and cannot be forged by callers.
    """

    CONFIG_KEY = "remote_projects"

    def __init__(self, config_store):
        self._config = config_store
        self._state_lock = threading.RLock()

    def _load(self) -> list[dict[str, Any]]:
        raw = self._config.get(self.CONFIG_KEY, [])
        if not isinstance(raw, list):
            return []
        return [dict(item) for item in raw if isinstance(item, dict)]

    def _save(self, values: list[dict[str, Any]]) -> None:
        self._config.set(self.CONFIG_KEY, values)

    @staticmethod
    def _local_id(fingerprint: str, project_id: str) -> str:
        digest = hashlib.sha256(f"{fingerprint}:{project_id}".encode()).hexdigest()[:20]
        return f"remote:{digest}"

    def add_from_share(self, share_string: str) -> dict[str, Any]:
        payload = RemoteAccessService.parse_share_string(share_string.strip())
        endpoint = str(payload["endpoint"])
        parsed = urlparse(endpoint)
        if parsed.scheme not in {"ws", "wss"} or not parsed.netloc:
            raise ValueError("Invalid remote-project WebSocket endpoint")
        fingerprint = str(payload["fingerprint"])
        host_project_id = str(payload["project_id"])
        local_id = self._local_id(fingerprint, host_project_id)
        values = self._load()
        existing = next((entry for entry in values if entry.get("id") == local_id), None)
        item = {
            "id": local_id,
            "host_project_id": host_project_id,
            "name": str(payload["project_name"]),
            "endpoint": endpoint,
            "fingerprint": fingerprint,
            "invite_token": str(payload["invite_token"]),
            "connection_status": "disconnected",
            "access_status": "pending",
            "access_expires_at": None,
            "steps": {},
            "workflows": [],
        }
        same_consumed_invite = bool(
            existing
            and existing.get("credential")
            and existing.get("last_invite_hash")
            and secrets.compare_digest(
                str(existing["last_invite_hash"]),
                _secret_hash(str(payload["invite_token"])),
            )
        )
        if same_consumed_invite:
            item.update(
                credential=existing["credential"],
                steps=existing.get("steps") or {},
                workflows=existing.get("workflows") or [],
                last_invite_hash=existing["last_invite_hash"],
                access_status=existing.get("access_status") or "active",
                access_expires_at=existing.get("access_expires_at"),
            )
            item.pop("invite_token", None)
        values = [entry for entry in values if entry.get("id") != local_id]
        values.append(item)
        self._save(values)
        return self._public(item)

    def get(self, local_project_id: str) -> dict[str, Any] | None:
        return next(
            (item for item in self._load() if item.get("id") == local_project_id),
            None,
        )

    def update(self, local_project_id: str, **changes: Any) -> dict[str, Any]:
        values = self._load()
        item = next((entry for entry in values if entry.get("id") == local_project_id), None)
        if item is None:
            raise KeyError(local_project_id)
        item.update(changes)
        self._save(values)
        return item

    def mark_authenticated(
        self,
        local_project_id: str,
        *,
        credential: str,
        project: dict[str, Any],
        access_status: str = "active",
        access_expires_at: int | None = None,
    ) -> dict[str, Any]:
        item = self.get(local_project_id)
        if item is None:
            raise KeyError(local_project_id)
        changes = {
            "credential": credential,
            "connection_status": "connected",
            "name": str(project.get("name") or item.get("name") or ""),
            "steps": project.get("steps") or {},
            "workflows": project.get("workflows") or [],
            "access_status": access_status,
            "access_expires_at": access_expires_at,
        }
        values = self._load()
        stored = next(entry for entry in values if entry.get("id") == local_project_id)
        stored.update(changes)
        invite_token = stored.get("invite_token")
        if isinstance(invite_token, str) and invite_token:
            stored["last_invite_hash"] = _secret_hash(invite_token)
        stored.pop("invite_token", None)
        self._save(values)
        return self._public(stored)

    def set_status(self, local_project_id: str, status: str) -> None:
        try:
            self.update(local_project_id, connection_status=status)
        except KeyError:
            pass

    def remove(self, local_project_id: str) -> bool:
        values = self._load()
        remaining = [item for item in values if item.get("id") != local_project_id]
        if len(remaining) == len(values):
            return False
        self._save(remaining)
        return True

    @staticmethod
    def _public(item: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": str(item.get("id") or ""),
            "path": "",
            "name": str(item.get("name") or ""),
            "steps": item.get("steps") or {},
            "workflows": item.get("workflows") or [],
            "type": "remote",
            "connection_status": str(item.get("connection_status") or "disconnected"),
            "access_status": str(item.get("access_status") or "pending"),
            "access_expires_at": item.get("access_expires_at"),
            "endpoint": str(item.get("endpoint") or ""),
            "host_project_id": str(item.get("host_project_id") or ""),
        }

    def list_public(self) -> list[dict[str, Any]]:
        return [self._public(item) for item in self._load()]


for _method_name in (
    "add_from_share", "get", "update", "mark_authenticated", "set_status",
    "remove", "list_public",
):
    setattr(
        RemoteProjectRegistry,
        _method_name,
        _serialize_remote_state(getattr(RemoteProjectRegistry, _method_name)),
    )
