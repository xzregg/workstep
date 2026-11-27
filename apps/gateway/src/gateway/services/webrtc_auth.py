"""Gateway account authorization and admin visibility helpers for WebRTC P2P."""

from __future__ import annotations

from typing import Any

from sqlalchemy import select

from gateway.models import Device, User
from gateway.services.device_grants import has_device_access
from gateway.services.identity import IdentityService
from gateway.services.identity_errors import IdentityError


async def is_gateway_device_session_authorized(
    database,
    hub,
    *,
    device_id: str,
    session_cookie: str | None,
) -> bool:
    """Return True when the current Gateway user may passwordlessly access this WebRTC device."""
    if database is None or hub is None or not device_id or not session_cookie:
        return False
    reg = hub.get_device(device_id)
    if reg is None or not reg.gateway_key_fingerprint:
        return False
    try:
        user, _ = await IdentityService(database).session_user(session_cookie)
    except IdentityError:
        return False
    if user.status != "active":
        return False
    async with database.session() as session:
        device = await session.scalar(
            select(Device).where(Device.public_key_fingerprint == reg.gateway_key_fingerprint)
        )
        if device is None or device.status != "active":
            return False
        return bool(await has_device_access(session, user.id, device.id))


async def resolve_webrtc_admin_devices(
    session,
    webrtc_hub,
    *,
    allowed_ids: set[str] | None,
    q: str = "",
) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
    """Return scoped WebRTC registered device rows and a fingerprint-to-registration map."""
    hub_items = webrtc_hub.list_devices() if webrtc_hub is not None else []
    if not hub_items:
        return [], {}

    fingerprints = {
        str(item["gateway_key_fingerprint"])
        for item in hub_items
        if item.get("gateway_key_fingerprint")
    }
    bound_by_fp: dict[str, Device] = {}
    owner_names: dict[str, str] = {}
    if fingerprints:
        bound_devices = (
            await session.scalars(select(Device).where(Device.public_key_fingerprint.in_(fingerprints)))
        ).all()
        bound_by_fp = {
            device.public_key_fingerprint: device
            for device in bound_devices
            if device.public_key_fingerprint
        }
        owner_ids = {device.owner_user_id for device in bound_devices if device.owner_user_id}
        if owner_ids:
            owner_rows = (await session.scalars(select(User).where(User.id.in_(owner_ids)))).all()
            owner_names = {user.id: user.display_name or user.username for user in owner_rows}

    fp_to_hub = {
        str(item["gateway_key_fingerprint"]): item
        for item in hub_items
        if item.get("gateway_key_fingerprint")
    }
    needle = q.strip().lower()
    rows: list[dict[str, Any]] = []
    for item in hub_items:
        bound = bound_by_fp.get(item.get("gateway_key_fingerprint"))
        if allowed_ids is not None and (bound is None or bound.id not in allowed_ids):
            continue
        if needle:
            matches_name = needle in str(item["device_name"]).lower()
            matches_id = needle in str(item["device_id"]).lower()
            matches_bound = bound is not None and needle in bound.name.lower()
            if not (matches_name or matches_id or matches_bound):
                continue
        rows.append({
            "device_id": item["device_id"],
            "name": item["device_name"],
            "online": True,
            "connection_ip": item["connection_ip"],
            "connected_at": item["connected_at"],
            "active_sessions": item["active_sessions"],
            "p2p_path": f"/p2p/{item['device_id']}/",
            "gateway_bound": bound is not None,
            "bound_device_id": bound.id if bound is not None else None,
            "bound_device_name": bound.name if bound is not None else None,
            "bound_device_status": bound.status if bound is not None else None,
            "owner_user_id": bound.owner_user_id if bound is not None else None,
            "owner_name": owner_names.get(bound.owner_user_id) if bound is not None else None,
        })
    return rows, fp_to_hub
