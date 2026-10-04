from gateway.services.errors import GatewayError
from gateway.contracts import GatewayCall
import asyncio

import json

from typing import Literal

from urllib.parse import urlsplit

from uuid import uuid4


from pydantic import BaseModel, Field, field_validator

from sqlalchemy import and_, func, or_, select, update

from sqlalchemy.exc import IntegrityError

from gateway.services.management_scope import project_manager, require_grant_subject

from gateway.services.identity import COOKIE_NAME, IdentityService

from gateway.services.identity_api import _super_admin_read, _super_admin_request

from gateway.models import AuditEvent, Device, DeviceProviderApplication, PlatformProvider, ProviderAssignment, User, UserDevice


"""Managed provider catalog, assignments and per-device desired bundles."""


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
        raise GatewayError('invalid', 'Unsupported provider protocol')
    if set(body.protocols) != set(body.protocol_base_urls) or len(set(body.protocols)) != len(body.protocols):
        raise GatewayError('invalid', 'Provider protocols and endpoints differ')
    if len(set(body.models)) != len(body.models) or any(
        not model or model != model.strip() or len(model) > 128 for model in body.models
    ):
        raise GatewayError('invalid', 'Invalid provider model')
    if set(body.prices) - set(body.models):
        raise GatewayError('invalid', 'Unknown priced model')


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


class ProviderDefaultInput(ProviderAssignInput):
    enabled: bool


class ProviderTestInput(BaseModel):
    device_id: str = Field(min_length=1, max_length=64)


async def _admin(call: GatewayCall):
    identity, actor = await _super_admin_request(call)
    _, session = await identity.session_user(call.tokens.get(COOKIE_NAME))
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


async def _assignment_admin(call: GatewayCall, body: ProviderAssignInput):
    identity, actor, _ = await project_manager(call, device_id=body.subject_id if body.subject_type == 'device' else None, mutation=True)
    if body.subject_type == "user":
        await require_grant_subject(call, identity, actor.id, 'user', body.subject_id)
    return actor


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
        default_assignments = (await session.scalars(select(ProviderAssignment).where(
            ProviderAssignment.is_default == 1,
            ProviderAssignment.revoked_at.is_(None),
            or_(
                (ProviderAssignment.subject_type == "user") & (ProviderAssignment.subject_id == user_id),
                (ProviderAssignment.subject_type == "device") & (ProviderAssignment.subject_id == device_id),
            ),
        ))).all()
        available_ids = {provider.id for provider in providers}
        default_provider_id = next((assignment.provider_id for scope in ("user", "device")
                                    for assignment in default_assignments
                                    if assignment.subject_type == scope
                                    and assignment.provider_id in available_ids), "")
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
        providers=desired, default_provider_id=default_provider_id,
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


async def list_assignment_catalog(call: GatewayCall):
    await project_manager(call)
    async with call.database.session() as session:
        providers = (await session.scalars(select(PlatformProvider).order_by(PlatformProvider.name))).all()
    return {"providers": [{"id": row.id, "name": row.name, "enabled": bool(row.enabled)}
                          for row in providers]}


async def list_platform_providers(call: GatewayCall,
                                  q: str = '',
                                  enabled: bool | None = None,
                                  sort: Literal["name", "created_at"] = "name",
                                  direction: Literal["asc", "desc"] = "asc",
                                  page: int = 1,
                                  page_size: int = 25):
    await _super_admin_read(call)
    conditions = []
    if q.strip():
        escaped = q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        conditions.append(or_(PlatformProvider.name.ilike(f"%{escaped}%", escape="\\"),
                              PlatformProvider.type.ilike(f"%{escaped}%", escape="\\")))
    if enabled is not None:
        conditions.append(PlatformProvider.enabled == int(enabled))
    column = PlatformProvider.name if sort == "name" else PlatformProvider.created_at
    ordered = column.asc() if direction == "asc" else column.desc()
    async with call.database.session() as session:
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
            if not call.control_connections.is_online(device_id):
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


async def list_provider_applications(call: GatewayCall,
                                     q: str = '',
                                     page: int = 1,
                                     page_size: int = 25):
    await _super_admin_read(call)
    conditions = []
    if q.strip():
        escaped = q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        conditions.append(Device.name.ilike(f"%{escaped}%", escape="\\"))
    async with call.database.session() as session:
        total = await session.scalar(select(func.count()).select_from(Device).where(*conditions))
        rows = (await session.execute(select(Device, DeviceProviderApplication).outerjoin(
            DeviceProviderApplication, DeviceProviderApplication.device_id == Device.id,
        ).where(*conditions).order_by(Device.name, Device.id)
            .offset((page - 1) * page_size).limit(page_size))).all()
    return {"devices": [{
        "device_id": device.id, "device_name": device.name,
        "device_status": device.status,
        "online": call.control_connections.is_online(device.id),
        "desired_revision": device.provider_revision,
        "applied_revision": applied.applied_revision if applied else None,
        "last_error": applied.last_error if applied else None,
    } for device, applied in rows], "total": total, "page": page, "page_size": page_size}


async def test_platform_provider(call: GatewayCall, provider_id: str,
                                 body: ProviderTestInput):
    await _admin(call)
    async with call.database.session() as session:
        provider = await session.get(PlatformProvider, provider_id)
        device = await session.get(Device, body.device_id)
        if provider is None or not provider.enabled:
            raise GatewayError('not_found', 'Provider unavailable')
        if device is None or device.status != "active":
            raise GatewayError('not_found', 'Device unavailable')
    control = call.control_connections
    user_id = control.active_user(body.device_id)
    if user_id is None:
        raise GatewayError('unavailable', 'Device is offline')
    provider_ids, _ = await compiled_provider_access(call.database, body.device_id, user_id)
    if provider_id not in provider_ids:
        raise GatewayError('forbidden', 'Provider unavailable on device')
    try:
        return await control.request_provider_test(body.device_id, provider_id)
    except asyncio.TimeoutError as exc:
        raise GatewayError('timeout', 'Provider test timed out') from exc
    except ConnectionError as exc:
        raise GatewayError('unavailable', 'Device is unavailable') from exc


async def list_provider_test_targets(call: GatewayCall, provider_id: str,
                                     q: str = '',
                                     page: int = 1,
                                     page_size: int = 25):
    await _super_admin_read(call)
    connected = call.control_connections.connected_users()
    async with call.database.session() as session:
        provider = await session.get(PlatformProvider, provider_id)
        if provider is None or not provider.enabled:
            raise GatewayError('not_found', 'Provider unavailable')
        assignments = (await session.scalars(select(ProviderAssignment).where(
            ProviderAssignment.provider_id == provider_id,
            ProviderAssignment.revoked_at.is_(None),
        ))).all()
        direct = {item.subject_id for item in assignments if item.subject_type == "device"}
        users = {item.subject_id for item in assignments if item.subject_type == "user"}
        eligible = {device_id for device_id, user_id in connected.items()
                    if device_id in direct or user_id in users}
        conditions = [Device.id.in_(eligible), Device.status == "active"]
        if q.strip():
            escaped = q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            pattern = f"%{escaped}%"
            conditions.append(or_(Device.name.ilike(pattern, escape="\\"),
                                  Device.id.ilike(pattern, escape="\\")))
        total = await session.scalar(select(func.count()).select_from(Device).where(*conditions))
        devices = (await session.scalars(select(Device).where(*conditions)
                   .order_by(Device.name, Device.id)
                   .offset((page - 1) * page_size).limit(page_size))).all()
    return {"devices": [{"id": device.id, "name": device.name} for device in devices],
            "total": total, "page": page, "page_size": page_size}


async def create_platform_provider(call: GatewayCall, body: ProviderInput):
    actor = await _admin(call)
    _validate_catalog(body)
    provider_id = str(uuid4())
    encrypted = await asyncio.to_thread(call.gateway_signer.encrypt_provider_secret, provider_id, body.api_key)
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
        async with call.database.session() as session:
            async with session.begin():
                session.add(provider)
                session.add(AuditEvent(id=str(uuid4()), user_id=actor.id,
                                       action="admin.provider_created", result="success",
                                       metadata_json=json.dumps({"provider_id": provider_id})))
    except IntegrityError as exc:
        raise GatewayError('conflict', 'Provider name already exists') from exc
    return _public_provider(provider)


async def update_platform_provider(call: GatewayCall, provider_id: str, body: ProviderUpdateInput):
    actor = await _admin(call)
    _validate_catalog(body)
    encrypted = await asyncio.to_thread(call.gateway_signer.encrypt_provider_secret, provider_id, body.api_key) if body.api_key is not None else None
    try:
        async with call.database.session() as session:
            async with session.begin():
                provider = await session.get(PlatformProvider, provider_id)
                if not provider:
                    raise GatewayError('not_found', 'Provider unavailable')
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
        raise GatewayError('conflict', 'Provider name already exists') from exc
    return _public_provider(provider)


async def list_platform_provider_assignments(call: GatewayCall, provider_id: str,
                                             q: str = '',
                                             page: int = 1,
                                             page_size: int = 25):
    identity, actor, devices = await project_manager(call)
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
    async with call.database.session() as session:
        if devices is not None:
            users = await identity.manageable_user_ids(
                session, actor.id, roles=("super_admin", "org_admin", "department_admin"))
            conditions.append(or_(
                and_(ProviderAssignment.subject_type == "device", ProviderAssignment.subject_id.in_(devices)),
                and_(ProviderAssignment.subject_type == "user", ProviderAssignment.subject_id.in_(users or set())),
            ))
        if not await session.get(PlatformProvider, provider_id):
            raise GatewayError('not_found', 'Provider unavailable')
        total = await session.scalar(select(func.count()).select_from(base.where(*conditions).subquery()))
        assignments = (await session.execute(base.where(*conditions).order_by(
            ProviderAssignment.created_at, ProviderAssignment.id,
        ).offset((page - 1) * page_size).limit(page_size))).all()
    return {"assignments": [{
        "id": assignment.id, "subject_type": assignment.subject_type,
        "subject_id": assignment.subject_id,
        "subject_name": username if assignment.subject_type == "user" else device_name,
        "is_default": bool(assignment.is_default),
    } for assignment, username, device_name in assignments],
        "total": total, "page": page, "page_size": page_size}


async def assign_platform_provider(call: GatewayCall, provider_id: str, body: ProviderAssignInput):
    actor = await _assignment_admin(call, body)
    async with call.database.session() as session:
        async with session.begin():
            provider = await session.get(PlatformProvider, provider_id)
            if not provider or not provider.enabled:
                raise GatewayError('not_found', 'Provider unavailable')
            target = await session.get(User if body.subject_type == "user" else Device,
                                       body.subject_id)
            if not target or target.status != "active":
                raise GatewayError('not_found', 'Assignment target unavailable')
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
                assignment.is_default = 0
            else:
                return {"id": assignment.id, "provider_id": provider_id}
            await _bump_assigned_devices(session, body.subject_type, body.subject_id)
            session.add(AuditEvent(id=str(uuid4()), user_id=actor.id,
                                   action="admin.provider_assigned", result="success",
                                   metadata_json=json.dumps({"provider_id": provider_id,
                                                             "subject_type": body.subject_type,
                                                             "subject_id": body.subject_id})))
    return {"id": assignment.id, "provider_id": provider_id}


async def set_default_platform_provider(call: GatewayCall, provider_id: str,
                                        body: ProviderDefaultInput):
    actor = await _assignment_admin(call, body)
    async with call.database.session() as session:
        async with session.begin():
            provider = await session.get(PlatformProvider, provider_id)
            if not provider or (body.enabled and not provider.enabled):
                raise GatewayError('not_found', 'Provider unavailable')
            assignment = await session.scalar(select(ProviderAssignment).where(
                ProviderAssignment.provider_id == provider_id,
                ProviderAssignment.subject_type == body.subject_type,
                ProviderAssignment.subject_id == body.subject_id,
                ProviderAssignment.revoked_at.is_(None),
            ))
            if assignment is None:
                raise GatewayError('not_found', 'Active assignment required')
            if bool(assignment.is_default) == body.enabled:
                return {"is_default": body.enabled}
            if body.enabled:
                await session.execute(update(ProviderAssignment).where(
                    ProviderAssignment.subject_type == body.subject_type,
                    ProviderAssignment.subject_id == body.subject_id,
                    ProviderAssignment.revoked_at.is_(None),
                    ProviderAssignment.is_default == 1,
                ).values(is_default=0))
            assignment.is_default = int(body.enabled)
            await _bump_assigned_devices(session, body.subject_type, body.subject_id)
            session.add(AuditEvent(id=str(uuid4()), user_id=actor.id,
                                   action="admin.provider_default_changed", result="success",
                                   metadata_json=json.dumps({"provider_id": provider_id,
                                                             "subject_type": body.subject_type,
                                                             "subject_id": body.subject_id})))
    return {"is_default": body.enabled}


async def revoke_platform_provider_assignment(call: GatewayCall, provider_id: str,
                                              body: ProviderAssignInput):
    actor = await _assignment_admin(call, body)
    async with call.database.session() as session:
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
            assignment.is_default = 0
            await _bump_assigned_devices(session, body.subject_type, body.subject_id)
            session.add(AuditEvent(
                id=str(uuid4()), user_id=actor.id, action="admin.provider_assignment_revoked",
                result="success", metadata_json=json.dumps({
                    "provider_id": provider_id, "subject_type": body.subject_type,
                    "subject_id": body.subject_id,
                }),
            ))


async def disable_platform_provider(call: GatewayCall, provider_id: str):
    actor = await _admin(call)
    async with call.database.session() as session:
        async with session.begin():
            provider = await session.get(PlatformProvider, provider_id)
            if not provider:
                raise GatewayError('not_found', 'Provider unavailable')
            if not provider.enabled:
                return
            provider.enabled = 0
            provider.revision += 1
            await session.execute(update(ProviderAssignment).where(
                ProviderAssignment.provider_id == provider_id,
                ProviderAssignment.is_default == 1,
            ).values(is_default=0))
            await session.execute(update(Device).where(Device.status == "active").values(
                provider_revision=Device.provider_revision + 1,
                policy_revision=Device.policy_revision + 1,
            ))
            session.add(AuditEvent(id=str(uuid4()), user_id=actor.id,
                                   action="admin.provider_disabled", result="success",
                                   metadata_json=json.dumps({"provider_id": provider_id})))
