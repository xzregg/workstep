"""Persist and validate the administrator's custom WebRTC STUN servers."""

from __future__ import annotations

import json
from uuid import uuid4

from pydantic import BaseModel, Field, field_validator
from workstep_gateway_protocol.webrtc import normalize_stun_urls

from gateway.contracts import GatewayCall
from gateway.models import AuditEvent, PlatformSetting

STUN_URLS_SETTING_KEY = "webrtc_stun_urls"


class WebRtcStunInput(BaseModel):
    stun_urls: list[str] = Field(default_factory=list, max_length=16)

    @field_validator("stun_urls")
    @classmethod
    def valid_stun_urls(cls, values: list[str]) -> list[str]:
        return normalize_stun_urls(values, max_items=16)


async def restore_webrtc_stun_settings(database, settings) -> None:
    """Restore persisted custom STUN URLs from PlatformSetting into live settings."""
    async with database.session() as session:
        row = await session.get(PlatformSetting, STUN_URLS_SETTING_KEY)
        if row:
            parsed = json.loads(row.value_json)
            if isinstance(parsed, list):
                settings.stun_urls = WebRtcStunInput(stun_urls=parsed).stun_urls


async def set_webrtc_stun_settings(call: GatewayCall, body: WebRtcStunInput) -> dict[str, list[str]]:
    """Save custom STUN server URLs (empty list reverts to Gateway built-in STUN)."""
    from gateway.services.identity import COOKIE_NAME
    from gateway.services.identity_api import _super_admin_request

    identity, actor = await _super_admin_request(call)
    _, auth = await identity.session_user(call.tokens.get(COOKIE_NAME))
    await identity.require_step_up(auth)
    payload = body.model_dump()
    async with call.database.session() as session:
        async with session.begin():
            row = await session.get(PlatformSetting, STUN_URLS_SETTING_KEY)
            if row:
                row.value_json = json.dumps(payload["stun_urls"])
                row.updated_by_user_id = actor.id
            else:
                session.add(
                    PlatformSetting(
                        key=STUN_URLS_SETTING_KEY,
                        value_json=json.dumps(payload["stun_urls"]),
                        updated_by_user_id=actor.id,
                    )
                )
            session.add(
                AuditEvent(
                    id=str(uuid4()),
                    user_id=actor.id,
                    action="admin.webrtc_stun_changed",
                    result="success",
                    metadata_json=json.dumps(payload),
                )
            )
    call.settings.stun_urls = list(body.stun_urls)
    return payload
