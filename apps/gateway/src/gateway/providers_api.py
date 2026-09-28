"""Managed provider catalog, assignments and per-device desired bundles."""

import asyncio
import json
from typing import Literal
from urllib.parse import urlsplit
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.exc import IntegrityError

from .identity import COOKIE_NAME, IdentityService
from .identity_api import _super_admin_read, _super_admin_request
from .models import (AuditEvent, Device, DeviceProviderApplication, PlatformProvider, ProviderAssignment,
                     User, UserDevice)

router = APIRouter(prefix="/api/admin/providers")
SUPPORTED_PROVIDER_PROTOCOLS = frozenset({
    "anthropic_messages", "openai_responses", "openai_chat_completions",
})


class ProviderInput(BaseModel):
    name: str = Field(min_length=1, max_length=256)
    type: str = Field(min_length=1, max_length=64)
    protocols: list[str] = Field(min_length=1, max_length=8)
    protocol_base_urls: dict[str, str]
    api_key: str = Field(min_length=1, max_length=4096)
    models: list[str] = Field(default_factory=list, max_length=1000)
    price_version: str = Field(default="v1", min_length=1, max_length=64)
    prices: dict[str, dict[str, str]] = Field(default_factory=dict)

    @field_validator("name", "type", "price_version")
    @classmethod
    def trimmed(cls, value: str) -> str:
        if value != value.strip():
            raise ValueError("Value must not contain surrounding whitespace")
        return value

    @field_validator("protocol_base_urls")
    @classmethod
    def secure_urls(cls, value: dict[str, str]) -> dict[str, str]:
        if len(value) > 8:
            raise ValueError("Too many provider endpoints")
        for url in value.values():
            parsed = urlsplit(url)
            if (parsed.scheme != "https" or not parsed.hostname or parsed.username
                    or parsed.password or parsed.fragment or len(url) > 2048):
                raise ValueError("Provider endpoints must use HTTPS")
        return value


class ProviderUpdateInput(ProviderInput):
    api_key: str | None = Field(default=None, min_length=1, max_length=4096)


def _validate_catalog(body: ProviderInput) -> None:
    if any(protocol not in SUPPORTED_PROVIDER_PROTOCOLS for protocol in body.protocols):
        raise HTTPException(status_code=422, detail="Unsupported provider protocol")
    if set(body.protocols) != set(body.protocol_base_urls) or len(set(body.protocols)) != len(body.protocols):
        raise HTTPException(status_code=422, detail="Provider protocols and endpoints differ")
    if len(set(body.models)) != len(body.models) or any(
        not model or model != model.strip() or len(model) > 128 for model in body.models
    ):
        raise HTTPException(status_code=422, detail="Invalid provider model")
    if set(body.prices) - set(body.models):
        raise HTTPException(status_code=422, detail="Unknown priced model")


async def _bump_assigned_devices(session, subject_type: str, subject_id: str) -> None:
    if subject_type == "device":
        await session.execute(update(Device).where(Device.id == subject_id).values(
            provider_revision=Device.provider_revision + 1,
            policy_revision=Device.policy_revision + 1,
        ))
        return
    device_ids = (await session.scalars(select(UserDevice.device_id).where(
        UserDevice.user_id == subject_id, UserDevice.revoked_at.is_(None),
    ))).all()
    if device_ids:
        await session.execute(update(Device).where(Device.id.in_(device_ids)).values(
            provider_revision=Device.provider_revision + 1,
            policy_revision=Device.policy_revision + 1,
        ))


class ProviderAssignInput(BaseModel):
    subject_type: str
    subject_id: str = Field(min_length=1, max_length=64)

    @field_validator("subject_type")
    @classmethod
    def valid_subject_type(cls, value: str) -> str:
        if value not in ("user", "device"):
            raise ValueError("Unknown provider assignment scope")
        return value


async def _admin(request: Request):
    identity, actor = await _super_admin_request(request)
    _, session = await identity.session_user(request.cookies.get(COOKIE_NAME))
    await identity.require_step_up(session)
    return actor


def _public_provider(provider: PlatformProvider) -> dict:
    config = json.loads(provider.config_json)
    return {"id": provider.id, "name": provider.name, "type": provider.type,
            "revision": provider.revision, "enabled": bool(provider.enabled),
            "protocols": config.get("protocols", []),
            "protocol_base_urls": config.get("protocol_base_urls", {}),
            "models": json.loads(provider.models_json),
            "prices": json.loads(provider.prices_json),
            "has_key": bool(provider.secret_ciphertext)}


@router.get("")
async def list_platform_providers(request: Request,
                                  q: str = Query("", max_length=128),
                                  enabled: bool | None = None,
                                  sort: Literal["name", "created_at"] = "name",
                                  direction: Literal["asc", "desc"] = "asc",
                                  page: int = Query(1, ge=1),
                                  page_size: int = Query(25, ge=1, le=100)):
    await _super_admin_read(request)
    conditions = []
    if q.strip():
        escaped = q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        conditions.append(or_(PlatformProvider.name.ilike(f"%{escaped}%", escape="\\"),
                              PlatformProvider.type.ilike(f"%{escaped}%", escape="\\")))
    if enabled is not None:
        conditions.append(PlatformProvider.enabled == int(enabled))
    column = PlatformProvider.name if sort == "name" else PlatformProvider.created_at
    ordered = column.asc() if direction == "asc" else column.desc()
    async with request.app.state.database.session() as session:
        total = await session.scalar(select(func.count()).select_from(PlatformProvider).where(*conditions))
        providers = (await session.scalars(select(PlatformProvider).where(*conditions).order_by(
            ordered, PlatformProvider.id,
        ).offset((page - 1) * page_size).limit(page_size))).all()
        provider_ids = [provider.id for provider in providers]
        assignments = (await session.scalars(select(ProviderAssignment).where(
            ProviderAssignment.provider_id.in_(provider_ids),
            ProviderAssignment.revoked_at.is_(None),
        ))).all() if provider_ids else []
        user_ids = {item.subject_id for item in assignments if item.subject_type == "user"}
        device_ids = {item.subject_id for item in assignments if item.subject_type == "device"}
        users = {user.id for user in (await session.scalars(select(User).where(
            User.id.in_(user_ids), User.status == "active",
        ))).all()} if user_ids else set()
        user_devices = (await session.execute(select(UserDevice.user_id, UserDevice.device_id).where(
            UserDevice.user_id.in_(users), UserDevice.revoked_at.is_(None),
        ))).all() if users else []
        candidate_device_ids = device_ids | {device_id for _, device_id in user_devices}
        devices = (await session.scalars(select(Device).where(
            Device.id.in_(candidate_device_ids), Device.status == "active",
        ))).all() if candidate_device_ids else []
        active_devices = {device.id: device for device in devices}
        device_ids &= active_devices.keys()
        applied = {item.device_id: item for item in (await session.scalars(select(
            DeviceProviderApplication).where(
                DeviceProviderApplication.device_id.in_(active_devices),
            ))).all()} if active_devices else {}
    targets_by_user: dict[str, set[str]] = {}
    for user_id, device_id in user_devices:
        if device_id in active_devices:
            targets_by_user.setdefault(user_id, set()).add(device_id)
    result = []
    for provider in providers:
        own = [item for item in assignments if item.provider_id == provider.id]
        assigned_users = {item.subject_id for item in own
                          if item.subject_type == "user" and item.subject_id in users}
        assigned_devices = {item.subject_id for item in own
                            if item.subject_type == "device" and item.subject_id in device_ids}
        targets = set(assigned_devices)
        for user_id in assigned_users:
            targets.update(targets_by_user.get(user_id, ()))
        status = {"applied": 0, "pending": 0, "failed": 0, "offline": 0}
        for device_id in targets:
            if not request.app.state.control_connections.is_online(device_id):
                status["offline"] += 1
            elif applied.get(device_id) and applied[device_id].last_error:
                status["failed"] += 1
            elif applied.get(device_id) and applied[device_id].applied_revision == active_devices[device_id].provider_revision:
                status["applied"] += 1
            else:
                status["pending"] += 1
        item = _public_provider(provider)
        item.update({"model_count": len(item["models"]),
                     "price_version": item["prices"].get("version"),
                     "assignment_users": len(assigned_users),
                     "assignment_devices": len(assigned_devices),
                     "target_devices": len(targets), "application": status})
        result.append(item)
    return {"providers": result, "total": total, "page": page, "page_size": page_size}


@router.get("/applications")
async def list_provider_applications(request: Request,
                                     q: str = Query("", max_length=128),
                                     page: int = Query(1, ge=1),
                                     page_size: int = Query(25, ge=1, le=100)):
    await _super_admin_read(request)
    conditions = []
    if q.strip():
        escaped = q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        conditions.append(Device.name.ilike(f"%{escaped}%", escape="\\"))
    async with request.app.state.database.session() as session:
        total = await session.scalar(select(func.count()).select_from(Device).where(*conditions))
        rows = (await session.execute(select(Device, DeviceProviderApplication).outerjoin(
            DeviceProviderApplication, DeviceProviderApplication.device_id == Device.id,
        ).where(*conditions).order_by(Device.name, Device.id)
            .offset((page - 1) * page_size).limit(page_size))).all()
    return {"devices": [{
        "device_id": device.id, "device_name": device.name,
        "device_status": device.status,
        "online": request.app.state.control_connections.is_online(device.id),
        "desired_revision": device.provider_revision,
        "applied_revision": applied.applied_revision if applied else None,
        "last_error": applied.last_error if applied else None,
    } for device, applied in rows], "total": total, "page": page, "page_size": page_size}


@router.post("")
async def create_platform_provider(request: Request, body: ProviderInput):
    actor = await _admin(request)
    _validate_catalog(body)
    provider_id = str(uuid4())
    encrypted = await asyncio.to_thread(
        request.app.state.gateway_signer.encrypt_provider_secret,
        provider_id, body.api_key,
    )
    provider = PlatformProvider(
        id=provider_id, name=body.name, type=body.type, revision=1, enabled=1,
        config_json=json.dumps({"protocols": body.protocols,
                                "protocol_base_urls": body.protocol_base_urls}),
        secret_ciphertext=encrypted,
        models_json=json.dumps(body.models),
        prices_json=json.dumps({"version": body.price_version, "models": body.prices}),
        created_by_user_id=actor.id,
    )
    try:
        async with request.app.state.database.session() as session:
            async with session.begin():
                session.add(provider)
                session.add(AuditEvent(id=str(uuid4()), user_id=actor.id,
                                       action="admin.provider_created", result="success",
                                       metadata_json=json.dumps({"provider_id": provider_id})))
    except IntegrityError as exc:
        raise HTTPException(status_code=409, detail="Provider name already exists") from exc
    return _public_provider(provider)


@router.put("/{provider_id}")
async def update_platform_provider(request: Request, provider_id: str, body: ProviderUpdateInput):
    actor = await _admin(request)
    _validate_catalog(body)
    encrypted = (await asyncio.to_thread(
        request.app.state.gateway_signer.encrypt_provider_secret,
        provider_id, body.api_key,
    ) if body.api_key is not None else None)
    try:
        async with request.app.state.database.session() as session:
            async with session.begin():
                provider = await session.get(PlatformProvider, provider_id)
                if not provider:
                    raise HTTPException(status_code=404, detail="Provider unavailable")
                provider.name = body.name
                provider.type = body.type
                provider.revision += 1
                provider.config_json = json.dumps({
                    "protocols": body.protocols, "protocol_base_urls": body.protocol_base_urls,
                })
                if encrypted is not None:
                    provider.secret_ciphertext = encrypted
                provider.models_json = json.dumps(body.models)
                provider.prices_json = json.dumps({
                    "version": body.price_version, "models": body.prices,
                })
                await session.execute(update(Device).where(Device.status == "active").values(
                    provider_revision=Device.provider_revision + 1,
                    policy_revision=Device.policy_revision + 1,
                ))
                session.add(AuditEvent(
                    id=str(uuid4()), user_id=actor.id, action="admin.provider_updated",
                    result="success", metadata_json=json.dumps({"provider_id": provider_id,
                                                                  "revision": provider.revision}),
                ))
    except IntegrityError as exc:
        raise HTTPException(status_code=409, detail="Provider name already exists") from exc
    return _public_provider(provider)


@router.get("/{provider_id}/assignments")
async def list_platform_provider_assignments(request: Request, provider_id: str,
                                             q: str = Query("", max_length=128),
                                             page: int = Query(1, ge=1),
                                             page_size: int = Query(25, ge=1, le=100)):
    await _super_admin_read(request)
    base = select(ProviderAssignment, User.username, Device.name).outerjoin(
        User, and_(ProviderAssignment.subject_type == "user",
                   ProviderAssignment.subject_id == User.id),
    ).outerjoin(Device, and_(ProviderAssignment.subject_type == "device",
                             ProviderAssignment.subject_id == Device.id))
    conditions = [ProviderAssignment.provider_id == provider_id,
                  ProviderAssignment.revoked_at.is_(None)]
    if q.strip():
        escaped = q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        pattern = f"%{escaped}%"
        conditions.append(or_(User.username.ilike(pattern, escape="\\"),
                              Device.name.ilike(pattern, escape="\\"),
                              ProviderAssignment.subject_id.ilike(pattern, escape="\\")))
    async with request.app.state.database.session() as session:
        if not await session.get(PlatformProvider, provider_id):
            raise HTTPException(status_code=404, detail="Provider unavailable")
        total = await session.scalar(select(func.count()).select_from(base.where(*conditions).subquery()))
        assignments = (await session.execute(base.where(*conditions).order_by(
            ProviderAssignment.created_at, ProviderAssignment.id,
        ).offset((page - 1) * page_size).limit(page_size))).all()
    return {"assignments": [{
        "id": assignment.id, "subject_type": assignment.subject_type,
        "subject_id": assignment.subject_id,
        "subject_name": username if assignment.subject_type == "user" else device_name,
    } for assignment, username, device_name in assignments],
        "total": total, "page": page, "page_size": page_size}


@router.post("/{provider_id}/assign")
async def assign_platform_provider(request: Request, provider_id: str, body: ProviderAssignInput):
    actor = await _admin(request)
    async with request.app.state.database.session() as session:
        async with session.begin():
            provider = await session.get(PlatformProvider, provider_id)
            if not provider or not provider.enabled:
                raise HTTPException(status_code=404, detail="Provider unavailable")
            target = await session.get(User if body.subject_type == "user" else Device,
                                       body.subject_id)
            if not target or target.status != "active":
                raise HTTPException(status_code=404, detail="Assignment target unavailable")
            assignment = await session.scalar(select(ProviderAssignment).where(
                ProviderAssignment.provider_id == provider_id,
                ProviderAssignment.subject_type == body.subject_type,
                ProviderAssignment.subject_id == body.subject_id,
            ))
            if assignment is None:
                assignment = ProviderAssignment(
                    id=str(uuid4()), provider_id=provider_id,
                    subject_type=body.subject_type, subject_id=body.subject_id,
                    assigned_by_user_id=actor.id,
                )
                session.add(assignment)
            elif assignment.revoked_at is not None:
                assignment.revoked_at = None
            else:
                return {"id": assignment.id, "provider_id": provider_id}
            await _bump_assigned_devices(session, body.subject_type, body.subject_id)
            session.add(AuditEvent(id=str(uuid4()), user_id=actor.id,
                                   action="admin.provider_assigned", result="success",
                                   metadata_json=json.dumps({"provider_id": provider_id,
                                                             "subject_type": body.subject_type,
                                                             "subject_id": body.subject_id})))
    return {"id": assignment.id, "provider_id": provider_id}


@router.post("/{provider_id}/assign/revoke", status_code=204)
async def revoke_platform_provider_assignment(request: Request, provider_id: str,
                                              body: ProviderAssignInput):
    actor = await _admin(request)
    async with request.app.state.database.session() as session:
        async with session.begin():
            assignment = await session.scalar(select(ProviderAssignment).where(
                ProviderAssignment.provider_id == provider_id,
                ProviderAssignment.subject_type == body.subject_type,
                ProviderAssignment.subject_id == body.subject_id,
                ProviderAssignment.revoked_at.is_(None),
            ))
            if not assignment:
                return
            from datetime import datetime, timezone
            assignment.revoked_at = datetime.now(timezone.utc)
            await _bump_assigned_devices(session, body.subject_type, body.subject_id)
            session.add(AuditEvent(
                id=str(uuid4()), user_id=actor.id, action="admin.provider_assignment_revoked",
                result="success", metadata_json=json.dumps({
                    "provider_id": provider_id, "subject_type": body.subject_type,
                    "subject_id": body.subject_id,
                }),
            ))


@router.post("/{provider_id}/disable", status_code=204)
async def disable_platform_provider(request: Request, provider_id: str):
    actor = await _admin(request)
    async with request.app.state.database.session() as session:
        async with session.begin():
            provider = await session.get(PlatformProvider, provider_id)
            if not provider:
                raise HTTPException(status_code=404, detail="Provider unavailable")
            if not provider.enabled:
                return
            provider.enabled = 0
            provider.revision += 1
            await session.execute(update(Device).where(Device.status == "active").values(
                provider_revision=Device.provider_revision + 1,
                policy_revision=Device.policy_revision + 1,
            ))
            session.add(AuditEvent(id=str(uuid4()), user_id=actor.id,
                                   action="admin.provider_disabled", result="success",
                                   metadata_json=json.dumps({"provider_id": provider_id})))


async def compile_provider_bundle(database, signer, gateway_id: str, device_id: str,
                                  user_id: str, config_public_key_pem: str) -> str:
    async with database.session() as session:
        device = await session.get(Device, device_id)
        user = await session.get(User, user_id)
        relationship = await session.scalar(select(UserDevice).where(
            UserDevice.device_id == device_id, UserDevice.user_id == user_id,
            UserDevice.revoked_at.is_(None),
        ))
        if (not device or device.status != "active" or not user or user.status != "active"
                or not relationship):
            raise ValueError("Provider bundle target unavailable")
        revision = device.provider_revision
        providers = (await session.scalars(select(PlatformProvider).join(
            ProviderAssignment, ProviderAssignment.provider_id == PlatformProvider.id,
        ).where(PlatformProvider.enabled == 1, ProviderAssignment.revoked_at.is_(None),
                or_(
                    (ProviderAssignment.subject_type == "user") & (ProviderAssignment.subject_id == user_id),
                    (ProviderAssignment.subject_type == "device") & (ProviderAssignment.subject_id == device_id),
                )).distinct())).all()
        stored = [(provider.id, provider.name, provider.type, provider.config_json,
                   provider.secret_ciphertext, provider.models_json, provider.prices_json)
                  for provider in providers]
    desired = []
    for provider_id, name, type_id, config_json, ciphertext, models_json, prices_json in stored:
        config = json.loads(config_json)
        secret = await asyncio.to_thread(signer.decrypt_provider_secret,
                                         provider_id, ciphertext)
        desired.append({"id": provider_id, "name": name, "type": type_id,
                        **config, "api_key": secret, "models": json.loads(models_json),
                        "prices": json.loads(prices_json)})
    return await asyncio.to_thread(
        signer.sign_provider_bundle, gateway_id=gateway_id, device_id=device_id,
        user_id=user_id, revision=revision, config_public_key_pem=config_public_key_pem,
        providers=desired,
    )


async def compiled_provider_access(database, device_id: str, user_id: str) -> tuple[list[str], list[str]]:
    async with database.session() as session:
        providers = (await session.scalars(select(PlatformProvider).join(
            ProviderAssignment, ProviderAssignment.provider_id == PlatformProvider.id,
        ).where(PlatformProvider.enabled == 1, ProviderAssignment.revoked_at.is_(None),
                or_(
                    (ProviderAssignment.subject_type == "user") & (ProviderAssignment.subject_id == user_id),
                    (ProviderAssignment.subject_type == "device") & (ProviderAssignment.subject_id == device_id),
                )).distinct())).all()
    ids = sorted(provider.id for provider in providers)
    models = sorted({model for provider in providers
                     for model in json.loads(provider.models_json)})
    return ids, models
