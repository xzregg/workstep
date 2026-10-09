"""PKCE-protected, single-use Desktop login and device registration."""
from gateway.services.errors import GatewayError

import base64
import hashlib
import hmac
import json
import secrets
from datetime import timedelta
from uuid import uuid4

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.exceptions import InvalidSignature

from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError

from gateway.database import GatewayDatabase
from gateway.services.identity import _as_utc, _digest, _now
from gateway.models import AuditEvent, DesktopAuthCode, Device, User, UserDevice
from gateway.services.signing import GatewaySigner


def _challenge(verifier: str) -> str:
    return base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()


def _device_key(public_pem: str) -> tuple[str, str]:
    try:
        public_key = serialization.load_pem_public_key(public_pem.encode())
    except (ValueError, TypeError) as exc:
        raise GatewayError('invalid', 'Invalid device public key') from exc
    if not isinstance(public_key, Ed25519PublicKey):
        raise GatewayError('invalid', 'Device key must be Ed25519')
    der = public_key.public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    canonical_pem = public_key.public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode()
    return canonical_pem, hashlib.sha256(der).hexdigest()


class DesktopAuthorizationService:
    def __init__(self, database: GatewayDatabase, signer: GatewaySigner, gateway_id: str):
        self.database = database
        self.signer = signer
        self.gateway_id = gateway_id

    async def authorize(self, user_id: str, gateway_id: str, state: str, nonce: str,
                        challenge: str, app_instance_id: str) -> str:
        if gateway_id != self.gateway_id:
            raise GatewayError('forbidden', 'Wrong Gateway')
        code = secrets.token_urlsafe(32)
        async with self.database.session() as session:
            async with session.begin():
                session.add(DesktopAuthCode(
                    code_hash=_digest(code), user_id=user_id, gateway_id=gateway_id,
                    app_instance_id=app_instance_id, state_hash=_digest(state),
                    nonce_hash=_digest(nonce), pkce_challenge=challenge,
                    expires_at=_now() + timedelta(minutes=2),
                ))
        return code

    async def redeem(self, *, code: str, state: str, nonce: str, verifier: str,
                     app_instance_id: str, gateway_id: str, device_public_key: str,
                     device_name: str, version: str, os: str | None = None,
                     arch: str | None = None,
                     rotation_signature: str | None = None) -> tuple[User, Device, str | None]:
        if gateway_id != self.gateway_id:
            raise GatewayError('forbidden', 'Wrong Gateway')
        canonical_key, fingerprint = _device_key(device_public_key)
        async with self.database.session() as session:
            async with session.begin():
                auth_code = await session.get(DesktopAuthCode, _digest(code))
                if auth_code is None:
                    raise GatewayError('unauthenticated', 'Unknown desktop code')
                if auth_code.used_at is not None:
                    raise GatewayError('conflict', 'Desktop code already used')
                if _as_utc(auth_code.expires_at) <= _now():
                    raise GatewayError('gone', 'Desktop code expired')
                if not (
                    hmac.compare_digest(auth_code.state_hash, _digest(state))
                    and hmac.compare_digest(auth_code.nonce_hash, _digest(nonce))
                    and hmac.compare_digest(auth_code.pkce_challenge, _challenge(verifier))
                    and hmac.compare_digest(auth_code.app_instance_id, app_instance_id)
                    and hmac.compare_digest(auth_code.gateway_id, gateway_id)
                ):
                    raise GatewayError('forbidden', 'Desktop authorization mismatch')
                user = await session.get(User, auth_code.user_id)
                if user is None or user.status != "active":
                    raise GatewayError('forbidden', 'Account unavailable')
                claimed = await session.execute(update(DesktopAuthCode).where(
                    DesktopAuthCode.code_hash == auth_code.code_hash,
                    DesktopAuthCode.used_at.is_(None),
                    DesktopAuthCode.expires_at > _now(),
                ).values(used_at=_now()).execution_options(synchronize_session=False))
                if claimed.rowcount != 1:
                    raise GatewayError('conflict', 'Desktop code already used')
                existing_key = await session.scalar(select(Device).where(
                    Device.public_key_fingerprint == fingerprint,
                ))
                device = await session.scalar(select(Device).where(
                    Device.app_instance_id == app_instance_id,
                ))
                if existing_key and device and existing_key.id != device.id:
                    raise GatewayError('conflict', 'Device key belongs to another installation')
                if existing_key and not device:
                    raise GatewayError('conflict', 'Device key belongs to another installation')
                if device and device.status in ("disabled", "revoked"):
                    raise GatewayError('forbidden', 'Device unavailable')
                if device and device.public_key_fingerprint != fingerprint:
                    if not rotation_signature:
                        raise GatewayError('forbidden', 'Old device key proof required')
                    try:
                        signature = base64.urlsafe_b64decode(rotation_signature + "===")
                        old_key = serialization.load_pem_public_key(device.public_key.encode())
                        old_key.verify(signature, f"workstep-device-rotate-v1:{code}:{fingerprint}".encode())
                    except (ValueError, InvalidSignature) as exc:
                        raise GatewayError('forbidden', 'Invalid rotation proof') from exc
                    device.public_key = canonical_key
                    device.public_key_fingerprint = fingerprint
                    device.status = "pending"
                    session.add(AuditEvent(
                        id=str(uuid4()), user_id=user.id, device_id=device.id,
                        action="device.key_rotation_requested", result="success", metadata_json=None,
                    ))
                if device is None:
                    from gateway.services.device_approval_policy import device_approval_mode
                    approval = await device_approval_mode(session)
                    device = Device(
                        id=str(uuid4()), name=device_name, owner_user_id=user.id, public_key=canonical_key,
                        public_key_fingerprint=fingerprint, app_instance_id=app_instance_id,
                        version=version, os=os, arch=arch, status="active" if approval == "automatic" else "pending",
                    )
                    session.add(device)
                    if approval == 'automatic':
                        session.add(AuditEvent(id=str(uuid4()), user_id=user.id, device_id=device.id,
                            action='device.auto_approved', result='success', metadata_json=None))
                else:
                    device.version = version
                    if os is not None and arch is not None:
                        device.os = os
                        device.arch = arch
                linkage = await session.scalar(select(UserDevice).where(
                    UserDevice.user_id == user.id,
                    UserDevice.device_id == device.id,
                ))
                if linkage is None:
                    session.add(UserDevice(
                        id=str(uuid4()), user_id=user.id, device_id=device.id,
                        access_level="edit",
                    ))
                elif linkage.revoked_at is not None:
                    raise GatewayError('forbidden', 'User device access revoked')
                await session.flush()
                signed = self.signer.sign_device_authorization(
                    gateway_id=gateway_id, device_id=device.id, user_id=user.id,
                    username=user.username, app_instance_id=app_instance_id,
                    display_name=user.display_name,
                    device_public_key=device.public_key,
                ) if device.status == "active" else None
                return user, device, signed

    async def transfer_owner(self, device_id: str, actor_id: str, user_id: str) -> None:
        async with self.database.session() as session:
            async with session.begin():
                device = await session.get(Device, device_id)
                user = await session.get(User, user_id)
                if device is None or user is None or user.status != 'active':
                    raise GatewayError('not_found', 'Device or owner unavailable')
                if device.status == 'revoked':
                    raise GatewayError('conflict', 'Device unavailable')
                previous = device.owner_user_id
                device.owner_user_id = user_id
                device.policy_revision += 1
                session.add(AuditEvent(id=str(uuid4()), user_id=actor_id, device_id=device_id,
                    action='admin.device_owner_transferred', result='success',
                    metadata_json=json.dumps({'previous_owner_user_id': previous, 'owner_user_id': user_id})))

    async def rename_device(self, device_id: str, actor_id: str, name: str) -> None:
        async with self.database.session() as session:
            async with session.begin():
                device = await session.get(Device, device_id)
                if device is None:
                    raise GatewayError('not_found', 'Device not found')
                previous = device.name
                device.name = name
                session.add(AuditEvent(id=str(uuid4()), user_id=actor_id, device_id=device_id,
                    action='admin.device_renamed', result='success',
                    metadata_json=json.dumps({'previous_name': previous, 'name': name}, ensure_ascii=False)))

    async def approve_device(self, device_id: str, actor_id: str) -> None:
        async with self.database.session() as session:
            async with session.begin():
                device = await session.get(Device, device_id)
                if device is None:
                    raise GatewayError('not_found', 'Device not found')
                if device.status == "revoked":
                    raise GatewayError('conflict', 'Device unavailable')
                device.status = "active"
                session.add(AuditEvent(
                    id=str(uuid4()), user_id=actor_id, device_id=device_id,
                    action="admin.device_approved", result="success", metadata_json=None,
                ))

    async def change_device_status(self, device_id: str, actor_id: str, status: str) -> None:
        async with self.database.session() as session:
            async with session.begin():
                device = await session.get(Device, device_id)
                if device is None:
                    raise GatewayError('not_found', 'Device not found')
                if device.status == "revoked":
                    raise GatewayError('conflict', 'Device already revoked')
                device.status = status
                if status == "revoked":
                    device.revoked_at = _now()
                session.add(AuditEvent(
                    id=str(uuid4()), user_id=actor_id, device_id=device_id,
                    action=f"admin.device_{status}", result="success", metadata_json=None,
                ))

    async def list_devices(self, *, status: str | None = None, q: str = '', sort: str = 'created_at',
                           direction: str = 'desc', page: int = 1, page_size: int = 25, allowed_ids: set[str] | None = None) -> tuple[list[Device], int]:
        async with self.database.session() as session:
            conditions = [Device.id.in_(allowed_ids)] if allowed_ids is not None else []
            if status:
                conditions.append(Device.status == status)
            if q.strip():
                conditions.append(Device.name.ilike(f"%{q.strip()}%"))
            total = await session.scalar(select(func.count()).select_from(Device).where(*conditions))
            column = {'created_at': Device.created_at, 'name': Device.name,
                      'status': Device.status}[sort]
            order = column.asc() if direction == 'asc' else column.desc()
            query = (select(Device).where(*conditions).order_by(order, Device.id.asc())
                     .offset((page - 1) * page_size).limit(page_size))
            return (await session.scalars(query)).all(), int(total or 0)
