"""User-configured Gateway login via browser PKCE, without a special package."""
import asyncio
import base64
import hashlib
import hmac
import json
import os
import platform
import secrets
import time
from pathlib import Path
from typing import Any, NamedTuple
from urllib.parse import urlencode

import httpx
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from workstep_gateway_protocol import ManagedGatewayPayload
from workstep_gateway_protocol.origin import validate_gateway_origin, validate_daemon_origin
from services.config import config_store
from services import config as config_module
from . import connection_credentials

COOKIE = 'workstep_platform_local_session'


class GatewayLoginCompletion(NamedTuple):
    local_session: str
    actor: Any
    desktop: bool


def normalize_origin(value: str) -> str:
    return validate_gateway_origin(value.strip().removesuffix('/'))


def configured_payload():
    stored = config_store.get('gateway_platform', {})
    if not isinstance(stored, dict) or not stored.get('enabled', stored.get('authorized', False)) or not stored.get('authorized'): return None
    return ManagedGatewayPayload(gateway_id=stored['gateway_id'], gateway_origin=stored['url'],
        gateway_public_key_fingerprint=stored['fingerprint'], deployment_channel='settings', min_protocol_version=1)


def _encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode().rstrip('=')


def _identity(origin: str) -> dict:
    directory = config_module.CONFIG_DIR / 'gateway-identities'
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = directory / (hashlib.sha256(origin.encode()).hexdigest() + '.json')
    if path.exists(): return json.loads(path.read_text())
    key = Ed25519PrivateKey.generate()
    value = {'app_instance_id': secrets.token_urlsafe(24), 'private_key': key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()}
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as file: json.dump(value, file)
    return value


class GatewayBrowserLogin:
    def __init__(self, gateway, client_factory=None):
        self.gateway = gateway
        self.client_factory = client_factory or (lambda: httpx.AsyncClient(timeout=10, follow_redirects=False))
        self.pending = None
        self.desktop_local_session = None
        self.lock = asyncio.Lock()

    async def settings(self):
        stored = await asyncio.to_thread(config_store.get, 'gateway_platform', {})
        client = self.gateway.control_client
        restoring = getattr(self.gateway, '_restore_task', None)
        return {'url': stored.get('url', ''), 'configured': bool(stored.get('url')),
            'enabled': bool(os.environ.get('WORKSTEP_MANAGED_BUNDLE_DIR') or stored.get('enabled', stored.get('authorized', False))),
            'authenticated': bool(self.gateway.current_user_id), 'online': bool(client and client.online),
            'authorization_required': bool(getattr(self.gateway, 'authorization_required', False) or (client and getattr(client, 'authorization_required', False))),
            'reconnecting': bool(restoring and not restoring.done()),
            'pending_device': bool(stored.get('pending_device')), 'package_locked': bool(os.environ.get('WORKSTEP_MANAGED_BUNDLE_DIR'))}

    async def save_settings(self, origin: str, enabled: bool):
        origin = normalize_origin(origin) if origin.strip() else ''
        if enabled and not origin: raise ValueError('Gateway address required')
        if os.environ.get('WORKSTEP_MANAGED_BUNDLE_DIR'):
            raise ValueError('This installation has a package-pinned Gateway')
        async with self.lock:
            old = await asyncio.to_thread(config_store.get, 'gateway_platform', {})
            changed = old.get('url', '') != origin
            stored = {} if changed else dict(old)
            stored.update(url=origin, enabled=enabled)
            if changed or not enabled:
                stored.update(authorized=False, pending_device=False)
                self.pending = None
                self.desktop_local_session = None
            await asyncio.to_thread(config_store.set, 'gateway_platform', stored)
            if (changed or not enabled) and self.gateway.managed_config is not None:
                await self.gateway.close()
                self.gateway.managed_config = None
                self.gateway.verifier = None
                self.gateway.skill_sync = None
            if (changed or not enabled) and old.get('url'):
                await asyncio.to_thread(connection_credentials.delete, old['url'])
            return await self.settings()

    async def logout(self):
        async with self.lock:
            stored = await asyncio.to_thread(config_store.get, 'gateway_platform', {})
            stored = {**stored, 'authorized': False, 'pending_device': False}
            self.pending = None
            self.desktop_local_session = None
            await self.gateway.close()
            self.gateway.authorization_required = True
            if stored.get('url'):
                await asyncio.to_thread(connection_credentials.delete, stored['url'])
            await asyncio.to_thread(config_store.set, 'gateway_platform', stored)

    async def begin(self, origin: str, callback_origin: str, *, desktop: bool = False) -> str:
        origin = normalize_origin(origin)
        callback_origin = validate_daemon_origin(callback_origin)
        if os.environ.get('WORKSTEP_MANAGED_BUNDLE_DIR'):
            raise ValueError('This installation has a package-pinned Gateway')
        async with self.lock:
            old = await asyncio.to_thread(config_store.get, 'gateway_platform', {})
            if not old.get('enabled', old.get('authorized', False)) or old.get('url') != origin:
                raise ValueError('Save the Gateway address and enable Gateway mode before login')
            async with self.client_factory() as client:
                response = await client.get(origin + '/api/platform/gateway-key')
                response.raise_for_status()
                data = response.json()
            key = serialization.load_pem_public_key(data['public_key_pem'].encode())
            if not isinstance(key, Ed25519PublicKey): raise ValueError('Invalid Gateway key')
            fingerprint = hashlib.sha256(key.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)).hexdigest()
            if not hmac.compare_digest(fingerprint, data['fingerprint']): raise ValueError('Gateway key mismatch')
            if old.get('url') == origin and old.get('fingerprint') and old['fingerprint'] != fingerprint:
                raise ValueError('Gateway key changed; verify the platform before reconnecting')
            identity = await asyncio.to_thread(_identity, origin)
            verifier = secrets.token_urlsafe(48)
            state, nonce = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
            self.pending = {'url': origin, 'gateway_id': data['gateway_id'], 'fingerprint': fingerprint,
                'callback_origin': callback_origin, 'desktop': desktop, 'identity': identity, 'verifier': verifier, 'state': state, 'nonce': nonce, 'expires': time.monotonic()+300}
            # Saving an address alone never enables controlled mode or grants access.
            stored = {**old, 'url': origin, 'gateway_id': data['gateway_id'], 'fingerprint': fingerprint}
            if old.get('url') != origin: stored['authorized'] = False
            await asyncio.to_thread(config_store.set, 'gateway_platform', stored)
            query = {'gateway_id': data['gateway_id'], 'app_instance_id': identity['app_instance_id'],
                'state': state, 'nonce': nonce, 'code_challenge': _encode(hashlib.sha256(verifier.encode()).digest()),
                **({} if desktop else {'redirect_uri': callback_origin + '/api/gateway-platform/callback'})}
            return origin + '/desktop/login?' + urlencode(query)

    async def complete(self, code: str, state: str, *, callback_origin: str | None = None):
        async with self.lock:
            pending = self.pending
            if not pending or pending['expires'] <= time.monotonic() or not hmac.compare_digest(state, pending['state']):
                raise ValueError('Gateway login expired or invalid state')
            if callback_origin is not None and validate_daemon_origin(callback_origin) != pending['callback_origin']:
                raise ValueError('Gateway callback origin mismatch')
            self.pending = None
            identity = pending['identity']
            key = serialization.load_pem_private_key(identity['private_key'].encode(), password=None)
            public_key = key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode()
            async with self.client_factory() as client:
                response = await client.post(pending['url']+'/api/desktop/token', json={
                    'code': code, 'state': state, 'nonce': pending['nonce'], 'code_verifier': pending['verifier'],
                    'app_instance_id': identity['app_instance_id'], 'gateway_id': pending['gateway_id'],
                    'device_public_key': public_key, 'device_name': platform.node() or 'WorkStep daemon',
                    'version': __import__('version').APP_VERSION})
                response.raise_for_status()
                result = response.json()
            stored = {'url': pending['url'], 'gateway_id': pending['gateway_id'], 'fingerprint': pending['fingerprint'],
                'enabled': True,
                'authorized': bool(result.get('device_authorization')), 'pending_device': not bool(result.get('device_authorization'))}
            if not result.get('device_authorization'):
                await asyncio.to_thread(config_store.set, 'gateway_platform', stored)
                return None
            # Verify authorization before replacing the current connection.
            from .identity import ManagedAuthorizationVerifier
            authorization = result['device_authorization']
            proof = _encode(key.sign(authorization.encode()))
            verifier = ManagedAuthorizationVerifier(pending['gateway_id'], pending['url'], pending['fingerprint'], client_factory=self.client_factory)
            actor = await verifier.verify(authorization, proof)
            if actor.app_instance_id != identity['app_instance_id']: raise ValueError('Installation binding mismatch')
            control_key = Ed25519PrivateKey.generate()
            control_public = control_key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode()
            # Delegate challenge signing using the existing Desktop protocol.
            fingerprint = hashlib.sha256(control_key.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)).hexdigest()
            delegation = _encode(key.sign(f'workstep-control-delegate-v1:{authorization}:{fingerprint}'.encode()))
            control_private = control_key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
            await self.gateway.close()
            await asyncio.to_thread(config_store.set, 'gateway_platform', stored)
            await self.gateway.start()
            result = await self.gateway.bootstrap(authorization, proof, control_private, control_public, delegation)
            self.desktop_local_session = result[0] if pending["desktop"] else None
            return GatewayLoginCompletion(result[0], result[1], bool(pending["desktop"]))
